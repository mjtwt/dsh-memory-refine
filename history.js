/**
 * 历史会话原话检索（memory_history）。
 *
 * 要解决的问题：核心记忆只存稳定结论，日常聊天不做全量提炼；但模型回答
 * 「我们之前是不是聊过 X」时，需要的是**他当时说的原话**，不是提炼过的结论。
 *
 * 数据来源只有一条：宿主已有的 `ctx.sessionQuery`。
 *   listSessions()        → 全部会话 header + live 标志（不读正文）
 *   readSurface(id)       → 该会话**当前表层**的事件（已折叠，纯函数折叠结果）
 * 然后复用本插件已有的 collectRecords() 提正文、tokenize() 分词，自己做 BM25。
 *
 * 三条边界，改这个文件时别越过：
 *   1. 只读。不写任何文件，不读 session*.jsonl.zstd（私有格式，无兼容保证）。
 *   2. 只查当前表层。上下文压缩折叠掉的旧消息**不该**出现在结果里——同一件事
 *      有新旧两版说法会让检索结果自相矛盾。要旧原文就走 readEvent 单独展开。
 *   3. 拿不准就不返回。门槛 0.35 不为了「有结果」而下调；没有命中就明说没命中。
 *
 * ───────────────── 三个容易做错的地方（实现时已定死，别再改口径） ─────────────────
 *
 * (1) refresh 与 scan_limit 的关系
 *     refresh 只作用于**缓存**，不改变扫描范围。scan_limit 永远是本次调用读
 *     readSurface 的会话数上限。
 *       refresh: 'all'           → 清空全部缓存；本次只重建 targets（受 scan_limit
 *                                  与 session_id 过滤约束）里的会话，因为它们在
 *                                  本次被读取；没被扫到的会话只是「没有缓存」，
 *                                  不是「重建失败」。
 *       stats.refreshed          → 如实反映「清掉了什么」（'all' 或某个 id），
 *                                  不是「重建了几场」——重建了几场看 sessions_scanned。
 *       stats.sessions_from_cache → refresh 之后必为 0（缓存已空，不存在可命中的）。
 *     这样统计自洽：sessions_scanned + sessions_from_cache + sessions_failed = 本次参与的场数。
 *
 * (2) max_chars 是**正文预算**，并且是硬上限
 *     只统计 hit.text 与 context 条目的 text（码点），不统计标题、时间、统计行。
 *     分配顺序：先 hits（按排名），再所有 hits 的 context_before，最后 context_after。
 *     预算见底就停，宁可少给一条，也不让总和超出去。
 *
 * (3) 空查询
 *     空串 / 纯空白 → ok:false + error（不抛异常，不让宿主把工具调用变成崩溃）。
 *     有字但分词后一个可检索词都没有（如只写了「的」或「12」）→ ok:true、
 *     hits:[]、note 说明原因。两种情况都不跑 listSessions，免得白花时间。
 */
import { collectRecords, stripInjection } from './gather.js'
import { tokenize } from './search.js'

/* --------------------------------------------------------------- 常量 */

/** 覆盖率门槛。会话语料比记忆文件杂，比 search.js 的 0.5 松；低于 0.35 基本是噪音。 */
const STOP_COVERAGE = 0.35
/** 软门槛：只用来在「一条没中」时告诉模型「最接近的候选差多远」，绝不拿来凑数。 */
const SOFT_COVERAGE = 0.2
/** 单条正文上限（码点）。 */
const HIT_CHARS = 200
/** 上下文单条上限（码点）。 */
const CTX_CHARS = 120
const DEFAULT_MAX_CHARS = 1500
const MAX_MAX_CHARS = 4000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const MAX_CONTEXT = 4
const DEFAULT_SCAN_LIMIT = 50
/** 同一场会话最多出几条，防止一场长会话霸榜。 */
const PER_SESSION_CAP = 2
/** 缓存会话数上限，按 builtAt 最旧淘汰。 */
const CACHE_LIMIT = 32
/** readSurface 的并发上限：持久会话每场都是全量读盘 + 回放校验，并发太高反而拖慢。 */
const MAX_READ_CONCURRENCY = 4

/* --------------------------------------------------------------- 小工具 */

/** 整数参数：缺省/null/空串走默认值，非法值走默认值，其余夹到 [min, max]。 */
function intArg(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const v = Math.trunc(n)
  if (v < min) return min
  if (max !== undefined && v > max) return max
  return v
}

const round = (n, digits) => Number(n.toFixed(digits))

function isoTime(time) {
  const d = new Date(time)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

function hhmmss(time) {
  const d = new Date(time)
  return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : ''
}

/** 单场读取失败的原因：优先带 SessionQueryError 的 code，便于模型判断是会话没了还是坏了。 */
function errReason(err) {
  const code = err?.code ?? err?.data?.code
  if (typeof code === 'string' && code) return `error:${code}`
  return `error:${String(err?.message ?? err ?? 'unknown').slice(0, 80)}`
}

/**
 * 有上限的并发执行，保持结果顺序。
 * 不用 Promise.all 全铺开：27 场持久会话全量读盘会同时打开 27 份日志。
 */
async function withPool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/* ----------------------------------------------------------- 事件 → 记录 */

/** 把 content[] 里 type==='text' 的块拼起来；reasoning / tool-call 一律不看。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const c of content) if (c?.type === 'text') parts.push(String(c.text ?? ''))
  return parts.join('\n')
}

/**
 * 事件流 → 可检索记录。
 *
 * 复用 collectRecords：它已经在做「谁是用户、谁是助手、注入怎么剥、怎么去重」。
 * 但它也会产出 tool/call、tool/result，那不是原话，这里直接不要。
 *
 * 注意：喂给它的必须是 readSurface().events。表层里本来就没有 tool/call 和
 * agent/inbox/spliced，所以 collectRecords 的那两个分支不会命中、viaSplice
 * 恒为 false —— 这不是 bug，是选 readSurface 的附带好处（同一条用户消息不会
 * 因为双载体被索引两遍）。
 *
 * purpose:'history' 是本函数唯一对 collectRecords 的额外要求：它让 goal /
 * tool-goal 这类「宿主替用户写的目标摘要」也被排除。取素材那条路要留着它们
 * （否则提炼时不知道这场在忙什么），查原话这条路不能留 —— 这里要的是用户
 * 亲口说的话。除了这个参数，不要为了「兼容」再去改 collectRecords。
 */
function extractRecords(events) {
  const { records } = collectRecords(Array.isArray(events) ? events : [], { purpose: 'history' })
  const out = []
  for (const r of records) {
    if (r.kind !== 'user' && r.kind !== 'assistant') continue
    // 表层里根本不会有 agent/inbox/spliced，但万一上游把收件箱事件也递进来：
    // 那是「待消费队列」里的副本，消费时才落成 user/message。把它也索引会让
    // 同一句话占掉每会话的两个配额位。宁可不要 —— 收录面只认真正的消息事件。
    if (r.kind === 'user' && r.viaSplice) continue
    // 用户消息：cleanUserContent 已在 collectRecords 里剥过注入；这里再 strip 一遍
    // 是幂等的，代价可忽略，换来「无论上游怎么变，返回的都是没有注入的原话」。
    // 助手消息：理论上不含注入，同样过一遍。
    const raw = r.kind === 'user' ? textOfContent(r.content) : textOfContent(r.msg?.content)
    const text = stripInjection(raw).text
    if (!text) continue // 清洗后为空（纯注入 / 只有 reasoning / 只有图片）→ 丢弃
    out.push({ seq: r.seq, time: r.time, role: r.kind, text })
  }
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return out
}

/** 记录 → 倒排 + 每条的 tf / len + 本场 df（全局 df 由各场 df 相加，省一次全量遍历）。 */
function buildIndex(records) {
  const docs = []
  const postings = new Map()
  const df = new Map()
  records.forEach((rec, i) => {
    const tf = new Map()
    const tokens = tokenize(rec.text)
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    docs.push({ tf, len: tokens.length })
    for (const t of tf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1)
      let set = postings.get(t)
      if (!set) postings.set(t, (set = new Set()))
      set.add(i)
    }
  })
  return { docs, postings, df }
}

/**
 * 一场会话的缓存条目。
 *
 * 缓存的是**提取后的记录 + 倒排**，不是原始事件：原始事件的体积是它的十几倍，
 * 而缓存要解决的正是「readSurface 背后的全量读盘 + 回放校验」。
 */
function buildEntry(header, live, capturedThroughSeq, events) {
  const records = extractRecords(events)
  const { docs, postings, df } = buildIndex(records)
  return {
    createdAt: String(header?.createdAt ?? ''),
    live,
    capturedThroughSeq: capturedThroughSeq ?? null,
    records,
    docs,
    postings,
    df,
    builtAt: Date.now(),
  }
}

/** 写缓存并维持容量上限（淘汰 builtAt 最旧的）。 */
function putEntry(store, id, entry) {
  store.set(id, entry)
  while (store.size > CACHE_LIMIT) {
    let oldestId = null
    let oldestAt = Infinity
    for (const [key, value] of store) {
      if (value.builtAt < oldestAt) {
        oldestAt = value.builtAt
        oldestId = key
      }
    }
    if (oldestId === null) break
    store.delete(oldestId)
  }
}

/**
 * 读一场会话，必要时重建索引。
 *
 * 失效规则（§6.7），按顺序：
 *   1. 会话已不在 listSessions() 里 → 由调用方删缓存，这里不管；
 *   2. live === true → 每次都 readSurface 核对 capturedThroughSeq，变了才重建；
 *   3. live === false → 有缓存就直接复用，不再调 readSurface；
 *   4. live === false 但 header.createdAt 与缓存里的不一致 → 重建（header 本来就在手上，零成本）。
 */
async function loadSession({ sessionQuery, header, live, entry, signal }) {
  const id = String(header.id)
  if (!live && entry && entry.createdAt === String(header.createdAt ?? '')) {
    return { id, entry, read: false, rebuilt: false }
  }

  const snapshot =
    signal === undefined ? await sessionQuery.readSurface(id) : await sessionQuery.readSurface(id, signal)
  const through = snapshot?.capturedThroughSeq ?? null

  // 规则 2 的后半段：会话还在变（live），但这次读到的版本号与缓存一致 → 索引仍然对，重建是白费。
  if (live && entry && entry.capturedThroughSeq === through) {
    entry.live = true
    return { id, entry, read: true, rebuilt: false }
  }

  const fresh = buildEntry(header, live, through, snapshot?.events)
  return { id, entry: fresh, read: true, rebuilt: true }
}

/* --------------------------------------------------------------- 打分 */

/**
 * 汇总候选：按查询词取倒排交集，累计 tf 与命中词数。
 * 用 `${sessionId}\0${docIndex}` 当键 —— 记录下标只在一场会话内唯一。
 */
function collectCandidates({ corpus, terms, df, N }) {
  const acc = new Map()
  for (const [id, entry] of corpus) {
    for (const term of terms) {
      const postings = entry.postings.get(term)
      if (!postings) continue
      const dfTerm = df.get(term)
      const idf = dfTerm ? Math.log(N / dfTerm) : 0
      for (const index of postings) {
        const key = `${id}\u0000${index}`
        let item = acc.get(key)
        if (!item) {
          item = { id, entry, index, raw: 0, hits: 0 }
          acc.set(key, item)
        }
        item.hits++
        item.raw += (entry.docs[index].tf.get(term) ?? 0) * idf
      }
    }
  }
  return acc
}

/* --------------------------------------------------------------- 返回体 */

const CONTEXT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    seq: { type: 'integer' },
    time: { type: 'string' },
    role: { type: 'string' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['seq', 'time', 'role', 'text', 'truncated'],
  additionalProperties: false,
}

const HIT_SCHEMA = {
  type: 'object',
  properties: {
    session_id: { type: 'string' },
    created_at: { type: 'string' },
    seq: { type: 'integer' },
    time: { type: 'string' },
    role: { type: 'string' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    score: { type: 'number' },
    coverage: { type: 'number' },
    context_before: { type: 'array', items: CONTEXT_ITEM_SCHEMA },
    context_after: { type: 'array', items: CONTEXT_ITEM_SCHEMA },
  },
  required: ['session_id', 'created_at', 'seq', 'time', 'role', 'text', 'truncated', 'score', 'coverage'],
  additionalProperties: false,
}

const HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    query: { type: 'string' },
    total_hits: { type: 'integer' },
    returned: { type: 'integer' },
    hits: { type: 'array', items: HIT_SCHEMA },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: { session_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['session_id', 'reason'],
        additionalProperties: false,
      },
    },
    stats: { type: 'object', additionalProperties: true },
    note: { type: 'string' },
  },
  // 只强制 ok：失败分支是 { ok:false, error }，其余字段在成功分支里都给齐。
  required: ['ok'],
  additionalProperties: false,
}

const ROLE_LABEL = { user: '他', assistant: '我' }

function renderHistory(_args, value) {
  if (!value?.ok) return [{ type: 'text', text: `历史检索失败：${value?.error ?? '未知原因'}` }]

  const s = value.stats ?? {}
  const lines = [
    `命中 ${value.hits.length}/${value.total_hits} 条 · 关键词「${value.query}」`,
    `扫描 ${s.sessions_scanned ?? 0} 场（缓存复用 ${s.sessions_from_cache ?? 0} · 失败 ${s.sessions_failed ?? 0} · 共列出 ${s.sessions_listed ?? 0}）· 索引记录 ${s.records_indexed ?? 0} 条 · ${s.elapsed_ms ?? 0}ms${s.sessions_excluded_self ? ' · 已排除当前会话' : ''}`,
  ]
  if (value.note) lines.push(`说明：${value.note}`)

  value.hits.forEach((hit, i) => {
    const who = ROLE_LABEL[hit.role] ?? hit.role
    lines.push('', `#${i + 1} ${hit.session_id} · ${hhmmss(hit.time)} · ${who} · 覆盖度 ${hit.coverage.toFixed(2)} · seq ${hit.seq}`)
    for (const ctx of hit.context_before ?? []) {
      lines.push(`   ↑ [seq ${ctx.seq} · ${ROLE_LABEL[ctx.role] ?? ctx.role}] ${ctx.text}`)
    }
    lines.push(hit.text)
    for (const ctx of hit.context_after ?? []) {
      lines.push(`   ↓ [seq ${ctx.seq} · ${ROLE_LABEL[ctx.role] ?? ctx.role}] ${ctx.text}`)
    }
    if (hit.truncated) {
      lines.push(
        `   （正文被截断：原文更长。要前后文就带 context:2 再查一次，或用 session_id + seq 走宿主的 readEvent。）`,
      )
    }
  })

  lines.push(
    '',
    'score 只用于排序，不是可信度。只查当前表层：被上下文压缩折叠掉的旧消息不在结果里，需要时用 session_id + seq 展开原始日志，并说明那是旧版。',
  )
  if (value.skipped?.length) {
    lines.push(`未参与：${value.skipped.map((x) => `${x.session_id}(${x.reason})`).join('、')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/* --------------------------------------------------------------- 主流程 */

/**
 * 调用方身份与检索范围：只在这里解析一次。
 *
 * 三件事必须集中在一处，否则「什么时候排除自己」会在不同分支各写一套：
 *   1. callerId —— 调用方所在的会话。运行时在 AgentRegistry.enter() 里硬断言
 *      `agent.id === agent.session.id`（不相等直接 throw），但官方工具写的是
 *      `agent.session.id`，所以两种写法都认、取到哪个都一样。拿不到就是 null
 *      （HTTP 路由、后台任务、单元测试都会走到这种情形），此时一律不排除。
 *   2. wantId —— 显式 session_id。优先级高于「默认排除自己」：指定了就照指定的查，
 *      哪怕指定的正是自己（与官方 targetId 同义，那里缺省才是 caller 自己）。
 *   3. excludeId —— 真正要排除的会话；null 表示这次不排除。
 *
 * 只排除「调用方自己这一场」，绝不按 live === true 成批排除：别的活动窗口也是
 * 人家的历史，误伤它们就违背了这个工具的用途。
 */
function resolveCaller(exec, args) {
  const raw = exec?.agent?.session?.id ?? exec?.agent?.id
  const callerId = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  const wantId = String(args?.session_id ?? '').trim()
  return { callerId, wantId, excludeId: callerId && !wantId ? callerId : null }
}

export function makeHistoryTool(ctx) {
  const store = new Map()
  ctx.effect(() => () => store.clear(), 'memory-refine: history cache')

  return {
    name: 'memory_history',
    description:
      '按关键词在历史会话的原话里检索（不查记忆文件）。**只在三种时候用**：用户要的是原话或具体日期；核心记忆（memory_recall）里没有、但用户确信聊过（没提炼不等于没聊过）；核心记忆的结论过期或自相矛盾，要回源头核对。**核心记忆已命中且够答时不要调它**，那是重复付费。索引只收用户与你的真实发言：宿主注入的时间戳、运行时上下文（runtime-context）、目标摘要（goal / tool-goal）、批准提示、工具提醒、后台任务通知都按来源整条排除，不会被当成谁说过的话。返回会话 id、事件序号、时间与原文片段；用 session_id + seq 可精确展开上下文。默认排除调用方自己所在的会话，避免搜到自己刚说的话；显式传 session_id 时照指定的查。只检索模型可见的当前表层：被上下文压缩折叠掉的旧消息不在结果里，需要时用 seq 展开原始日志并核对。**命中条数不等于相关**——覆盖率门槛低，擦线的片段常常只是共用了几个常见词、与问题无关，每条都要看原文再决定引用哪条。score 只用于排序，不是可信度。找不到就明确说没找到，不要用相近结果代替。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '关键词或短语，中文直接写。用实体词（人名、项目名、专有名词），不要用整句。',
        },
        session_id: {
          type: 'string',
          description: '只在指定会话里搜（指定当前会话自己也会照查）；省略 = 搜全部历史会话，但默认排除当前会话自己的话。',
        },
        limit: {
          type: 'integer',
          description: `最多返回几条，默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}。`,
        },
        context: {
          type: 'integer',
          description: `给每条命中额外带上下文几条（同会话、按 seq 相邻，取自当前表层）。默认 0。上限 ${MAX_CONTEXT}。`,
        },
        max_chars: {
          type: 'integer',
          description: `本次返回正文总字数上限（只算原文，不含标题与统计），默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_MAX_CHARS}。`,
        },
        scan_limit: {
          type: 'integer',
          description: `最多扫描多少个会话（从最新往旧），默认 ${DEFAULT_SCAN_LIMIT}。它同时是 refresh 的重建范围上限。`,
        },
        refresh: {
          type: 'string',
          description:
            '手动刷新索引：填会话 id = 只重建这一场；填 "all" = 清空全部缓存。只清缓存、不改变本次的扫描范围（仍受 scan_limit 约束）。用于旧会话被重新启用、或怀疑索引与原文对不上时。省略 = 正常复用缓存。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: HISTORY_SCHEMA, render: renderHistory },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionQuery = ctx.get('sessionQuery')
      if (!sessionQuery || typeof sessionQuery.readSurface !== 'function') {
        return { ok: false, error: 'sessionQuery 服务不可用：检索历史会话需要它。' }
      }
      return runHistory({ store, sessionQuery, args, exec })
    },
  }
}

async function runHistory({ store, sessionQuery, args, exec }) {
  const started = process.hrtime.bigint()
  const elapsed = () => round(Number((process.hrtime.bigint() - started) / 1000n) / 1000, 1)

  const query = String(args?.query ?? '').trim()
  // (3-a) 空查询：直接回错误。不抛异常 —— 抛出去在宿主那边会变成一次工具调用崩溃。
  if (!query) return { ok: false, error: 'query 不能为空：给一个关键词或短语（实体词最准）。' }

  const terms = [...new Set(tokenize(query))]
  const skipped = []
  const stats = {
    sessions_listed: 0,
    sessions_scanned: 0,
    sessions_from_cache: 0,
    sessions_failed: 0,
    records_indexed: 0,
    refreshed: [],
    sessions_excluded_self: 0,
    elapsed_ms: 0,
  }

  // (3-b) 有字但切不出词：不扫会话，直接说清楚为什么没结果。
  if (!terms.length) {
    return {
      ok: true,
      query,
      total_hits: 0,
      returned: 0,
      hits: [],
      skipped,
      stats: { ...stats, elapsed_ms: elapsed() },
      note: `「${query}」里没有可检索的词：单字、双字虚词（的了是在和与也都就很）和 4 位以下数字在分词时会被丢掉。换实体词再查。`,
    }
  }

  // (1) 手动刷新：只动缓存，不动扫描范围。必须在 listSessions 之前。
  const refresh = String(args?.refresh ?? '').trim()
  if (refresh === 'all') {
    store.clear()
    stats.refreshed = ['all']
  } else if (refresh) {
    store.delete(refresh)
    stats.refreshed = [refresh]
  }

  let listed
  try {
    listed = await sessionQuery.listSessions()
  } catch (err) {
    return { ok: false, error: `列会话失败：${err?.message ?? err}` }
  }
  const sessions = (Array.isArray(listed) ? listed : []).filter((x) => x?.header?.id)
  stats.sessions_listed = sessions.length

  // 规则 1：已经不在会话列表里的，缓存留着没用。整张表对着列表现场对账。
  const alive = new Set(sessions.map((x) => String(x.header.id)))
  for (const id of [...store.keys()]) if (!alive.has(id)) store.delete(id)

  const refreshId = refresh && refresh !== 'all' ? refresh : ''
  if (refreshId && !alive.has(refreshId)) skipped.push({ session_id: refreshId, reason: 'not_found' })

  const { wantId, excludeId } = resolveCaller(exec, args)
  let pool = sessions
  if (wantId) {
    pool = sessions.filter((x) => String(x.header.id) === wantId)
    if (!pool.length && !skipped.some((s) => s.session_id === wantId)) {
      skipped.push({ session_id: wantId, reason: 'not_found' })
    }
  }

  const limit = intArg(args?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const context = intArg(args?.context, 0, 0, MAX_CONTEXT)
  const maxChars = intArg(args?.max_chars, DEFAULT_MAX_CHARS, 1, MAX_MAX_CHARS)
  const scanLimit = intArg(args?.scan_limit, DEFAULT_SCAN_LIMIT, 1)

  // scan_limit 是「本次最多读几场」的硬上限，refresh 不会突破它。
  const targets = pool.slice(0, scanLimit)
  const signal = exec?.signal

  const loaded = await withPool(targets, MAX_READ_CONCURRENCY, async (item) => {
    const header = item.header
    const id = String(header.id)
    const live = Boolean(item.live)
    try {
      const got = await loadSession({ sessionQuery, header, live, entry: store.get(id), signal })
      return { id, ...got }
    } catch (err) {
      return { id, error: err }
    }
  })

  const corpus = new Map()
  let rebuilt = 0
  for (const got of loaded) {
    if (got.error) {
      stats.sessions_failed++
      skipped.push({ session_id: got.id, reason: errReason(got.error) })
      // 读失败但手里有上一次的缓存：拿旧缓存顶上，同时仍旧进 skipped。
      // 旧索引里的内容本身是真的，只是可能不全；比整场缺席更有用，也不会静默。
      // 故意不计入 sessions_from_cache：这场已经记在 sessions_failed 里了，再加一次
      // 会让「scanned + from_cache + failed」超过参与场数，统计就不自洽了。
      const stale = store.get(got.id)
      if (stale) corpus.set(got.id, stale)
      continue
    }
    if (got.read) {
      stats.sessions_scanned++
      if (got.rebuilt) {
        putEntry(store, got.id, got.entry)
        rebuilt++
      }
    } else {
      stats.sessions_from_cache++
    }
    corpus.set(got.id, got.entry)
  }

  let N = 0
  const df = new Map()
  for (const entry of corpus.values()) {
    N += entry.docs.length
    stats.records_indexed += entry.docs.length
    for (const [term, count] of entry.df) df.set(term, (df.get(term) ?? 0) + count)
  }

  // 自指噪音：当前会话既是查询者又是被查对象，它自己的话（刚发的那句指令、自己上一轮
  // 的分析）会挤占名额、把真正的旧历史顶到后面去。
  // 按批准方案 B 在「结果阶段」排除：扫描与建索引照旧（live 走 snapshotLive，零磁盘 I/O），
  // 这样 scanned / from_cache / failed 的统计自洽不被破坏，也不会误伤别人的活动会话。
  // 口径：这一场真参与了本次检索、却被排除在结果之外就记 1 —— 与关键词有没有命中它无关，
  // 否则这个数字会随关键词跳动，没法当验收依据。
  stats.sessions_excluded_self = excludeId && corpus.has(excludeId) ? 1 : 0

  const empty = (note) => ({
    ok: true,
    query,
    total_hits: 0,
    returned: 0,
    hits: [],
    skipped,
    stats: { ...stats, elapsed_ms: elapsed() },
    note,
  })

  if (N === 0) {
    return empty(
      corpus.size === 0
        ? '这一轮没有任何会话被读到（会话列表为空，或全部读取失败——见 skipped）。'
        : '扫到的会话里没有可检索的正文（可能都只有工具调用）。',
    )
  }

  // ---- 打分：coverage 与 BM25
  const candidates = collectCandidates({ corpus, terms, df, N })
  const scored = []
  let softMax = 0
  for (const item of candidates.values()) {
    const coverage = item.hits / terms.length
    if (coverage < STOP_COVERAGE) {
      if (coverage >= SOFT_COVERAGE) softMax = Math.max(softMax, coverage)
      continue
    }
    const doc = item.entry.docs[item.index]
    scored.push({ ...item, coverage, score: item.raw / Math.sqrt(doc.len || 1) })
  }

  const recOf = (item) => item.entry.records[item.index]
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (recOf(b).time ?? 0) - (recOf(a).time ?? 0) ||
      // 分数与时间都相同时按 seq 倒序，保证同一份数据每次输出顺序一致（方便测试与复核）
      (recOf(b).seq ?? 0) - (recOf(a).seq ?? 0),
  )

  // 只滤掉「调用方自己这一场」；别的活动会话照常参与。
  const visible = excludeId ? scored.filter((item) => item.id !== excludeId) : scored

  // 每会话最多 2 条（在排除自己之后数，否则自指条目会先占掉名额）
  const perSession = new Map()
  const capped = []
  for (const item of visible) {
    const used = perSession.get(item.id) ?? 0
    if (used >= PER_SESSION_CAP) continue
    perSession.set(item.id, used + 1)
    capped.push(item)
  }
  const totalHits = capped.length
  const chosen = capped.slice(0, limit)

  // ---- (2) 正文预算：hits → context_before → context_after，全程只减不超
  // truncated 同时覆盖两种截断（单条 200 字上限、总预算不够），因为对模型来说
  // 表达的是同一件事：这段不是全文，要看完整就再查一次。与 search.js 的 cutByBudget 同义。
  let budget = maxChars
  const picked = []
  for (const item of chosen) {
    if (budget <= 0) break
    const rec = recOf(item)
    const cps = Array.from(rec.text)
    const take = Math.min(HIT_CHARS, cps.length, budget)
    if (take <= 0) break
    budget -= take
    picked.push({ item, rec, text: cps.slice(0, take).join(''), truncated: take < cps.length })
  }

  const allocContext = (rec) => {
    if (budget <= 0) return null
    const cps = Array.from(rec.text)
    const take = Math.min(CTX_CHARS, cps.length, budget)
    if (take <= 0) return null
    budget -= take
    return {
      seq: rec.seq,
      time: isoTime(rec.time),
      role: rec.role,
      text: cps.slice(0, take).join(''),
      truncated: take < cps.length,
    }
  }

  if (context > 0) {
    // 先所有 hits 的上文，再所有 hits 的下文：预算紧张时上文的用处大于下文。
    // 每侧从最近的一条开始要，预算见底时留下的是最靠近命中的那几条。
    for (const p of picked) p.before = []
    for (let k = 1; k <= context; k++) {
      for (const p of picked) {
        const i = p.item.index - k
        if (i < 0) continue
        const item = allocContext(p.item.entry.records[i])
        if (item) p.before[k - 1] = item
      }
    }
    for (const p of picked) p.before = p.before.filter(Boolean).reverse() // 输出按时间正序
    for (const p of picked) p.after = []
    for (let k = 1; k <= context; k++) {
      for (const p of picked) {
        const i = p.item.index + k
        if (i >= p.item.entry.records.length) continue
        const item = allocContext(p.item.entry.records[i])
        if (item) p.after[k - 1] = item
      }
    }
    for (const p of picked) p.after = p.after.filter(Boolean)
  }

  const hits = picked.map((p) => {
    const hit = {
      session_id: p.item.id,
      created_at: p.item.entry.createdAt,
      seq: p.rec.seq,
      time: isoTime(p.rec.time),
      role: p.rec.role,
      text: p.text,
      truncated: p.truncated,
      score: round(p.item.score, 4),
      coverage: round(p.item.coverage, 2),
    }
    if (context > 0) {
      hit.context_before = p.before ?? []
      hit.context_after = p.after ?? []
    }
    return hit
  })

  const notes = []
  if (!totalHits) {
    notes.push(
      softMax >= SOFT_COVERAGE
        ? `没找到够格的命中：最接近的候选覆盖率只有 ${softMax.toFixed(2)}（门槛 ${STOP_COVERAGE}）。不要拿相近结果顶替，换个实体词再查。`
        : `没有命中「${query}」。换个实体词再查；如果确实没聊过，就直接说没找到，不要硬凑。`,
    )
  } else if (hits.length < totalHits) {
    const why = picked.length < chosen.length ? `max_chars=${maxChars} 的正文预算用完了` : `limit=${limit}`
    notes.push(`过滤后共 ${totalHits} 条命中，本次只返回 ${hits.length} 条（${why}）。要更多就调大 limit，或换个更窄的词。`)
  }
  if (skipped.length) notes.push(`${skipped.length} 场会话没能参与检索（见 skipped），结果是部分的。`)
  if (stats.refreshed.length) {
    notes.push(
      `已按 refresh 清空缓存：${stats.refreshed.join('、')}。本次实际重建 ${rebuilt} 场（扫描范围仍受 scan_limit 约束，没扫到的会话下次再建）。`,
    )
  }

  return {
    ok: true,
    query,
    total_hits: totalHits,
    returned: hits.length,
    hits,
    skipped,
    stats: { ...stats, elapsed_ms: elapsed() },
    note: notes.join(' '),
  }
}
