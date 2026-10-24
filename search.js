/**
 * 记忆召回：把「整份读」换成「按关键词取几段」。
 *
 * 为什么要有这个文件：mem_read 一份 我们的线.md 就是 33KB，而模型想知道
 * 「以前定过什么」时，需要的是其中两三条，不是全篇。这里把受管文件切成一
 * 条一块，按关键词排序，只把最相关的几段连同行号交回去 —— 行号是给
 * memory_read 用的，模型可以顺着这几十行去精读，不必回头读整份。
 *
 * 三个不变量，改这个文件时别破坏：
 *   1. 只读。这里不写任何文件，写路径的三道闸在 index.js / memory.js 里，与此无关。
 *   2. 拿不准就不返回。宁可漏，也不拿不相干的段凑数 —— 模型会把召回当事实。
 *   3. 统计域与检索域一致。IDF 的 N / df 必须按过滤后的候选池算，不能先用
 *      全量（含 archive）算完再降权：archive 占本机语料 2/3，那样会把现行
 *      内容的分数整体压低，还会让旧快照挤进结果。
 *
 * 全同步、零依赖：这些文件都很小（百来段），同步读一遍是毫秒级。
 */
import { list, layerOf, readRaw, resolveTarget, relPath } from './memory.js'

/* ------------------------------------------------------------ 参数 */

/** 一段的目标字数。本语料的条目是「一条一块」，一条通常 200–500 字。 */
const TARGET_CHARS = 600
/** 字符上限。找不到切点时按字符硬切 —— 只按行数兜底挡不住「一行 700 字」的文件。 */
const CEIL_CHARS = 1200
/** 行数兜底：30 行必断，保证 endLine - startLine <= 45 这条硬约束。 */
const HARD_LINES = 30
/** 单次召回的总预算（字符）。约 7.2KB 纯中文 —— 比「给一半再让他补读一次」便宜。 */
const TOTAL_BUDGET = 2400
/**
 * 单段上限 / 下限。低于下限就不值得占一段的位置。
 *
 * 取 1200 不是拍的：切段改成「一行一条」之后实测 —— 现役 86 段里
 * P50=363、P90=740、P95=960、最长 1744，**只有 1 段超过 1200**。
 * 也就是说这个值一给，98% 的条目都是整条给完、不再挂「被截断」。
 * 早先设 400 / 750 时，一半以上的段都比窗口长，那个标记几乎每段都有，
 * 模型于是每次都去补读一次完整文件 —— 标了等于没标，还多花一趟。
 */
const HIT_CHARS = 1200
const HIT_MIN = 120
/** 命中行上下各取几行。只在「一条本身就超长」时才用得上。 */
const CONTEXT_LINES = 3
/** 覆盖率门槛：query 的词命中不到一半就不算命中。 */
const MIN_COVERAGE = 0.5
/** 同一个文件最多出几段，防止一份大文件霸榜。 */
const MAX_PER_FILE = 2
/** 显式翻存档时才用的降权系数。 */
const ARCHIVE_WEIGHT = 0.3
/** 路径/文件名命中的加分，是「加值」不是「乘值」——乘值会把整份文件的弱相关段一起抬上来。 */
const PATH_BOOST = 0.2

/**
 * 停用词：只用于丢掉「两个字都在集里」的 bigram。
 *
 * 有三个字**不在**这个集里，是刻意的：你 / 我 / 他。这份语料里它们是实体
 * （他=用户，我=助手），注入层里有一整节就叫「他说过的话」，丢掉它们等于把
 * 最需要区分的主语抹平。
 *
 * 没 / 不 / 会 / 要 / 有 同样留着：「他看过两次，没装」里的「没装」是那条
 * 记忆的全部意思，否定词不是虚词。
 */
const STOP = new Set('的了是在和与也都就很吗呢吧啊这个'.split(''))

/* ------------------------------------------------------------ 分词 */

/** 评论标记里有 id=20261024 这类数字，不剥的话查日期会命中所有提炼标记行。 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
}

/**
 * 中文按 2-gram 切，英文数字按非字母数字切。
 *
 * 只做 2-gram、不做 3–6 gram：query 和正文必须走同一套分词，否则 coverage 的
 * 分母会对不上（命中 2 个 bigram 却要除以 5 个 n-gram），长词反而搜不到。
 */
function tokenize(text) {
  const out = []
  for (const m of text.matchAll(/[\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9_]*|\d+/g)) {
    const raw = m[0]
    if (/^[\u4e00-\u9fff]+$/.test(raw)) {
      if (raw.length === 1) continue
      for (let i = 0; i + 2 <= raw.length; i++) {
        const gram = raw.slice(i, i + 2)
        if (STOP.has(gram[0]) && STOP.has(gram[1])) continue
        out.push(gram)
      }
      continue
    }
    if (/^\d+$/.test(raw)) {
      // 「10」「22」这种月日级数字到处都是（日期、版本、百分比），只留 4 位以上的年份／编号
      if (raw.length >= 4) out.push(raw)
      continue
    }
    if (raw.length >= 2) out.push(raw.toLowerCase())
  }
  return out
}

/* ------------------------------------------------------------ 切段 */

const isBlank = (line) => !line.trim()
const isHeading = (line) => /^#{1,6}\s/.test(line)
/** 顶层列表项（行首没有缩进）。缩进的子项属于上一条，不能当切点。 */
const isTopItem = (line) => /^(?:[-*+]|\d+\.)\s/.test(line)

/** 去掉列表符号 / 加粗 / 引用号，留下能当标签的人话。 */
function plain(line) {
  return stripComments(line)
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[>\s]+/, '')
    .trim()
}

/**
 * 段标题取「段首那一条」的人话，而不是 Markdown 标题：
 * 我们的线.md 33KB 只有 1 个 `#`，10 段的标题会一模一样，模型没法靠它区分。
 * 这份记忆的真实结构是 `- **⭐ 小标题**：正文`，条目自带标题。
 */
function labelOf(text, fallbackTitle) {
  for (const line of text.split('\n')) {
    if (isHeading(line)) continue
    const clean = plain(line)
    if (clean) return clean.slice(0, 30)
  }
  return fallbackTitle.slice(0, 30)
}

/**
 * 把一份文件切成 [{ startLine, endLine, text }]，行号是 1 起的真实行号。
 *
 * `byItem` 决定「遇到切点就切」还是「攒够 TARGET_CHARS 再切」：
 *
 * - 记忆文件（topic / archive）用 true。实测这三份文件是「一行一条记忆」
 *   （`- **标题**：正文` 全在同一个物理行），所以一条的边界就是行边界。
 *   攒够 600 字再切会把 3–5 条互不相干的记忆捆成一段，召回时一起塞给模型。
 * - 规则文档（inject）用 false。AGENTS.md 里全是「一句话一条」的短列表，
 *   按条目切会得到 40 段、其中 20 段不足 60 字（最短 3 字），词太少、
 *   IDF 失真；而它本来也不参与 live 召回，没必要为它改切法。
 */
function splitFile(text, { byItem = true } = {}) {
  const lines = text.split('\n')
  const out = []
  let start = 0

  const push = (endExclusive) => {
    while (start < endExclusive && isBlank(lines[start])) start++
    let end = endExclusive
    while (end > start && isBlank(lines[end - 1])) end--
    if (end > start) {
      out.push({ startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') })
    }
    start = endExclusive
  }

  let acc = 0
  for (let i = 0; i < lines.length; i++) {
    acc += lines[i].length + 1
    const prev = i > 0 ? lines[i - 1] : ''
    // 缩进的 `  - 子项` 不算条目起点：它是上一条的组成部分，切开会把一条记忆劈成两半。
    // 标题也当切点，再由 absorbLoneHeadings 把它并到下文去 —— 否则标题会粘在
    // 上一条记忆的尾巴上，污染那条的词表。
    const boundary =
      isBlank(lines[i]) ||
      isHeading(lines[i]) ||
      (isTopItem(lines[i]) && (i === 0 || isBlank(prev) || isHeading(prev)))

    if (boundary && (byItem || acc >= TARGET_CHARS)) { push(i); acc = 0; continue }
    // 没有切点也要断：按字符硬切，否则长行文件会产出 10KB 以上的巨段
    if (acc >= CEIL_CHARS) { push(i + 1); acc = 0; continue }
    if (i - start >= HARD_LINES) { push(i); acc = 0; continue }
  }
  push(lines.length)
  return out
}

/**
 * 把「只有标题（加一句摘要）」的段并进下一段。
 *
 * 按条目切之后，`# 环境 · 这台机器` + `_DSH 之后仍然成立的环境事实…_` 会自己
 * 成一段。它没有可检索的具体内容，词全是「身份、身体、训练、健康」这种泛词，
 * 任何沾边的查询都会被它吸进来，白占一个候选位。标题属于下文，所以往后并。
 *
 * 判据是「以标题开头且不含列表项」，不是「全是标题行」—— 文件头那种
 * 标题+摘要的组合也要算进来。
 *
 * 拼接时必须用 lines 重新切，不能字符串相加：中间隔着空行，直接相加会让
 * text 的行数少于 endLine - startLine + 1，后面按行号定位命中行就会错位。
 */
function absorbLoneHeadings(parts, lines) {
  const out = []
  let pending = null
  const isHeadBlock = (part) => {
    const own = part.text.split('\n')
    return isHeading(own[0] ?? '') && !own.some((l) => isTopItem(l))
  }

  for (const part of parts) {
    if (isHeadBlock(part)) {
      pending = pending ? { startLine: pending.startLine, endLine: part.endLine } : { ...part }
      continue
    }
    const from = pending ? pending.startLine : part.startLine
    if (pending) pending = null
    out.push({ startLine: from, endLine: part.endLine, text: lines.slice(from - 1, part.endLine).join('\n') })
  }

  // 文件末尾挂着的标题别丢：并到上一段
  if (pending) {
    const last = out[out.length - 1]
    if (last) {
      last.endLine = pending.endLine
      last.text = lines.slice(last.startLine - 1, pending.endLine).join('\n')
    } else {
      out.push({ ...pending, text: lines.slice(pending.startLine - 1, pending.endLine).join('\n') })
    }
  }
  return out
}

/* ------------------------------------------------------------ 段集合 */

const scopeFiles = (scope) => {
  // memory.js 的 list 只认 all / inject / memory；live 是这里的扩展语义，
  // 直接把它传下去会静默走 all 分支，archive 就进来了。
  if (scope === 'all') return list('all')
  if (scope === 'inject' || scope === 'memory') return list(scope)
  // 注入层不参与 live 召回：AGENTS.md 每一轮都整份在上下文里，召回它的段落
  // 没有任何信息增益，只会凭「命中一个常见词」挤进前几名、占掉别处的预算。
  // 要看它显式传 scope:"inject"。
  return list('all').filter((f) => f.layer !== 'archive' && f.layer !== 'inject')
}

/**
 * 取段。每个文件只读一次、只算一次哈希（describe 已经给过 version，不重算）。
 * 返回值不含分词结果，分词在 recall 里按需做 —— 只导给人看时不必白算一遍。
 */
export function segments(scope = 'live') {
  const out = []
  for (const file of scopeFiles(scope)) {
    const abs = resolveTarget(file.path)
    const text = readRaw(abs)
    if (!text) continue
    const lines = text.split('\n')
    const layer = layerOf(abs)
    const headings = lines
      .map((line, i) => (isHeading(line) ? { line: i + 1, title: plain(line) } : null))
      .filter(Boolean)

    const parts = absorbLoneHeadings(splitFile(text, { byItem: layer !== 'inject' }), lines)
    for (const part of parts) {
      const title = headings.filter((h) => h.line <= part.startLine).at(-1)?.title ?? '(无标题)'
      out.push({
        path: relPath(abs),
        layer,
        version: file.version,
        title,
        label: labelOf(part.text, title),
        startLine: part.startLine,
        endLine: part.endLine,
        text: part.text,
      })
    }
  }
  return out
}

/* ------------------------------------------------------------ 打分 */

function buildPool(scope) {
  const pool = segments(scope)
  const N = pool.length
  const df = new Map()
  const tfs = pool.map((seg) => {
    const tf = new Map()
    for (const token of tokenize(stripComments(seg.text))) tf.set(token, (tf.get(token) ?? 0) + 1)
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    return tf
  })
  return { pool, N, df, tfs }
}

/** 命中最多的一行（1 起的绝对行号），用来决定截断窗口落在哪。 */
function bestLine(seg, terms) {
  const lines = seg.text.split('\n')
  let best = { line: seg.startLine, hits: -1 }
  lines.forEach((line, i) => {
    const set = new Set(tokenize(stripComments(line)))
    let hits = 0
    for (const t of terms) if (set.has(t)) hits++
    if (hits > best.hits) best = { line: seg.startLine + i, hits }
  })
  return best.line
}

/**
 * 以命中行为中心取一段可读文本。
 *
 * 不能「从头截 N 字」：命中词在段尾时，模型会拿到一段不含命中词的文本，还
 * 以为自己看全了。这里先取 ±CONTEXT_LINES 行，超预算就从离命中行最远的那端
 * 往回收，命中行永远保留。
 */
function windowText(seg, hitLine, terms = []) {
  const lines = seg.text.split('\n')
  const anchor = Math.min(Math.max(hitLine - seg.startLine, 0), lines.length - 1)
  // 两端收掉空行和「整行都是提炼标记」的行：留着的话 render 第一行是
  // `<!--@refine ...-->`，看起来像召回坏了。行号跟着一起挪，精读参数才不会错。
  const isNoise = (line) => isBlank(line) || !stripComments(line).trim()

  // 切段改成「一行一条」之后，段本身就已经是一条记忆：装得下就整条给。
  // 不再按 ±3 行前后挪 —— 那会在相邻条目之间来回取，把邻居的记忆也捞进来
  // （旧的 79 行 → 77-83 就是这样，851 字里混着 3 条互不相干的东西）。
  if (seg.text.length <= HIT_CHARS) {
    let a = 0
    let b = lines.length - 1
    while (a < b && isNoise(lines[a])) a++
    while (b > a && isNoise(lines[b])) b--
    return {
      text: lines.slice(a, b + 1).join('\n'),
      startLine: seg.startLine + a,
      endLine: seg.startLine + b,
      truncated: false,
    }
  }

  let lo = Math.max(0, anchor - CONTEXT_LINES)
  let hi = Math.min(lines.length - 1, anchor + CONTEXT_LINES)
  const size = () => lines.slice(lo, hi + 1).join('\n').length

  while (size() > HIT_CHARS && (lo < anchor || hi > anchor)) {
    if (hi - anchor >= anchor - lo) hi--
    else lo++
  }

  while (lo < hi && isNoise(lines[lo])) lo++
  while (hi > lo && isNoise(lines[hi])) hi--

  let text = lines.slice(lo, hi + 1).join('\n')
  let clamped = false
  if (text.length > HIT_CHARS) {
    const one = sliceAroundLine(lines[anchor], terms, HIT_CHARS)
    text = (one.cutHead ? '…' : '') + one.text + (one.cutTail ? '…' : '')
    clamped = true
  }
  // 只有「在行内被切断」才算截断。窗口不等于整个切段不算 —— 那本来就是常态，
  // 每段都标一次「已截断」等于没有信息量。
  return { text, startLine: seg.startLine + lo, endLine: seg.startLine + hi, truncated: clamped }
}

/**
 * 单行超长时以命中词为中心开窗。
 *
 * 不能 slice(0, N)：一条一千字的长条目，命中词常在第七八百字，从头截出来的
 * 片段里根本没有它要找的词 —— 模型看到的是「搜到了但没搜到」。
 */
function sliceAroundLine(line, terms, budget) {
  let pos = -1
  for (const t of terms) {
    const i = line.indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  if (pos < 0 || line.length <= budget) {
    return { text: line.slice(0, budget), cutHead: false, cutTail: line.length > budget }
  }
  // 前文留三分之一：命中词靠前就少留上文，靠后就多留，保证它一定落在窗口里
  const head = Math.min(pos, Math.floor(budget / 3))
  const start = Math.max(0, pos - head)
  const end = Math.min(line.length, start + budget)
  return { text: line.slice(start, end), cutHead: start > 0, cutTail: end < line.length }
}

/** 0 命中时的兜底清单：只列现役文件，列旧版对「去哪找」没有帮助。 */
function fallbackList() {
  return list('all')
    .filter((f) => f.layer !== 'archive')
    .map((f) => {
      const abs = resolveTarget(f.path)
      const title = readRaw(abs)
        .split('\n')
        .find((line) => isHeading(line))
      return { path: f.path, layer: f.layer, title: title ? plain(title) : '(无标题)' }
    })
}

/**
 * 按关键词召回。
 *
 * 返回的 startLine / endLine 是**这段返回文本**的真实行号，可以直接喂给
 * memory_read 的 offset / limit —— 召回只负责指出位置，精读仍然走既有的
 * 分页读取，两件事不合并。
 */
export function recall(query, { limit = 3, scope = 'live' } = {}) {
  const q = String(query ?? '').trim()
  const cap = Math.max(1, Math.min(Number(limit) || 3, 10))
  const cleanScope = ['live', 'all', 'inject', 'memory'].includes(scope) ? scope : 'live'
  if (!q) throw new Error('query 不能为空')

  const terms = [...new Set(tokenize(stripComments(q)))]
  if (!terms.length) {
    return { query: q, scope: cleanScope, total: 0, filtered: 0, terms, hits: [], fallback: fallbackList() }
  }

  const { pool, N, df, tfs } = buildPool(cleanScope)

  const scored = []
  pool.forEach((seg, i) => {
    const tf = tfs[i]
    let raw = 0
    let hit = 0
    for (const term of terms) {
      const freq = tf.get(term)
      if (!freq) continue
      hit++
      raw += freq * Math.log(N / (df.get(term) ?? 1))
    }
    if (!hit) return

    const coverage = hit / terms.length
    const base = raw / Math.sqrt(seg.text.length)
    const stem = seg.path.replace(/^.*\//, '').replace(/\.md$/i, '').toLowerCase()
    // 文件名命中：用户经常记的就是文件名（说「我们的线」，文件就叫 我们的线.md）
    const pathHit = stem.length >= 2 && terms.some((t) => stem.includes(t) || t.includes(stem))
    const isArchive = seg.layer === 'archive'
    let score = base + (pathHit ? PATH_BOOST * base : 0)
    if (isArchive) score *= ARCHIVE_WEIGHT
    scored.push({ seg, coverage, score, pathHit, isArchive })
  })

  const passed = scored.filter((s) => s.coverage >= MIN_COVERAGE)
  // 文件级加分只在整份文件里做一次相对比较，不能反过来压过覆盖率更高的命中
  const topBase = passed.reduce((max, s) => Math.max(max, s.score), 0)
  for (const s of passed) {
    if (!s.pathHit) continue
    const head = s.seg.startLine === 1
    if (head) s.score = Math.max(s.score, topBase * 1.15)
  }

  passed.sort(
    (a, b) =>
      b.score - a.score ||
      b.coverage - a.coverage ||
      // 同分时偏向纲领层：注入层和索引层的一句话比常记层的一句更"算数"
      (a.seg.layer === 'inject' || a.seg.layer === 'index' ? 0 : 1) -
        (b.seg.layer === 'inject' || b.seg.layer === 'index' ? 0 : 1),
  )

  const hits = []
  const perFile = new Map()
  // 一份文件最多出几段。切段改成「一行一条」之后段数涨了近一倍（48→86），
  // 同一个文件的相关条目自然也变多，写死的 2 会把 cov=1 的段挤掉。但要随
  // limit 缩放而不是直接放大：默认 limit=3 时仍是最多 2 段，保证至少留一个
  // 位置给别的文件；只有用户明确要更多结果时才放开。
  const perFileCap = Math.max(MAX_PER_FILE, Math.ceil(cap * 0.6))
  let budget = TOTAL_BUDGET
  for (const cand of passed) {
    const used = perFile.get(cand.seg.path) ?? 0
    if (used >= perFileCap) continue
    if (budget < HIT_MIN) break

    const line = bestLine(cand.seg, terms)
    const win = windowText(cand.seg, line, terms)
    const room = Math.min(HIT_CHARS, budget)
    const cutByBudget = win.text.length > room
    const text = cutByBudget ? win.text.slice(0, room) + '…' : win.text
    budget -= text.length
    perFile.set(cand.seg.path, used + 1)
    hits.push({
      path: cand.seg.path,
      layer: cand.seg.layer,
      title: cand.seg.title,
      // 标签取「真正返回的那段文本」的首条，不是切段起点：截断窗口挪过位置之后，
      // 拿切段起点的标签会指到另一条记忆上（说 2026-10-21，显示的却是 10-22）。
      label: labelOf(win.text, cand.seg.title),
      startLine: win.startLine,
      endLine: win.endLine,
      hitLine: line,
      version: cand.seg.version,
      coverage: Number(cand.coverage.toFixed(2)),
      score: Number(cand.score.toFixed(3)),
      truncated: win.truncated || cutByBudget,
      text,
    })
    if (hits.length >= cap) break
  }

  return {
    query: q,
    scope: cleanScope,
    total: passed.length,
    filtered: scored.length - passed.length,
    terms,
    hits,
    fallback: hits.length ? [] : fallbackList(),
  }
}
