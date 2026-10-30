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
 * 没 / 不 / 会 / 要 / 有 同样留着：「他试过两次，没装」里的「没装」是那条
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
export function tokenize(text) {
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
    if (clean) return trimLabel(clean)
  }
  return trimLabel(fallbackTitle)
}

/**
 * 截到 30 字，但不留半截括号。
 *
 * 记忆标题常写成「某事某物（2026-10-05/06 他确认要提炼的一条）」，
 * 硬切会把右括号切掉，抬头看着像坏掉了 —— 宁可在括号前断开。
 * 断过的都留个省略号，跟「行号只报起点」是同一个道理：截了就说截了。
 */
function trimLabel(s) {
  const cut = s.slice(0, 30)
  if (cut.length === s.length) return cut
  const open = cut.lastIndexOf('（')
  if (open > 0 && cut.indexOf('）', open) === -1) return cut.slice(0, open) + '…'
  return cut + '…'
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

/* ------------------------------------------------------------ 自动注入 */

/**
 * 自动注入挑哪一条 —— 跟 recall 是两套东西，别合并。
 *
 * 差别不在参数，在**输入**：recall 的 query 是模型自己抠好的实体词（工具说明
 * 里明写着「取实体词，不要拿整句去搜」），两三个字，干净；而注入拿的是用户
 * 原话，一句十五字的话切出十四个 bigram。用 recall 那套「覆盖率过半」的门槛，
 * 闲聊就全军覆没 —— 实测「今天好累」「我饿了」「那个台灯的事」全是 0 条。
 *
 * 换判据的过程记在这里，免得下一个人（或我）又从头试一遍：
 *
 *   · 按「撞上稀有词」挑（df <= 4）：对话里的口头语会和生僻词混在同一个频段。
 *     「我想」「好的」「这段」「多久」在 107 段里各只出现两三次，于是被当成
 *     稀罕信号 —— 实测 22 句里塞了 4 条完全不相干的。
 *   · 用「和常用词相邻就否决」挡跨词碎片：「缓存那个坑」里的「个坑」能挡住，
 *     但「台灯」两边是「个台」「灯的」这种稀有碎片，误杀。
 *
 * 最后站住的是这一条：**命中词必须出现在那条记忆的标题里。**
 *
 *   标题是 `- **⭐ 小标题**：正文` 里那个人写的摘要，不是正文里的顺口一提。
 *   「台灯」「雨天」「记账」「工位」都在标题上；「我想」「好的」「这段」
 *   不会出现在任何标题里 —— 口头语天然进不了摘要，这一条比任何阈值都干净，
 *   而且它顺手把跨词碎片也滤掉了（碎片不成词，写不进标题）。
 *   （本段例子都是虚构的：真实记忆里的字不该被抄进代码注释。）
 *
 * 代价是会漏：正文里提了、标题没提的那些，永远不触发。认这个代价。
 * 口径是**宁可漏**：漏了她还是原来那个她；错塞她会顺着错的东西往下说，
 * 而我们还以为她想起来了。
 */
const INJECT = {
  /** 全库出现段数上限：超过这个数就是常用词，不当信号。 */
  maxDf: 12,
  /** 全库总频次下限：低于这个数的多半是跨词碎片。 */
  minTotal: 2,
  /** 分数下限。一个词的 idf 约等于 ln(段数/命中段数)，见文件头第三条不变量。 */
  minScore: 2.5,
  /** 正文预算。注入不是精读，给多了挤占真正要说的话。 */
  bodyChars: 800,
}

/** 切段 + 词表，按文件版本缓存：注入每轮都要问一次，不能每轮都重新分词。 */
const injectCache = { key: '', index: null }

function injectIndex() {
  const pool = segments('live')
  const key = pool.map((s) => `${s.path}:${s.version}:${s.startLine}`).join('|')
  if (injectCache.key === key && injectCache.index) return injectCache.index

  const N = pool.length
  const df = new Map()
  const total = new Map()
  for (const seg of pool) {
    const tf = new Map()
    for (const t of tokenize(seg.text)) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [t, f] of tf) {
      df.set(t, (df.get(t) ?? 0) + 1)
      total.set(t, (total.get(t) ?? 0) + f)
    }
  }
  const index = { pool, N, df, total, heads: pool.map((s) => headlineOf(s)) }
  injectCache.key = key
  injectCache.index = index
  return index
}

/**
 * 取一条记忆的标题。
 *
 * 记忆条目的真实结构是 `- **⭐ 小标题**：正文`，标题就在加粗里；没有加粗的
 * 才退回首行前 40 字。标题是**人写的摘要**，这是整套办法唯一的锚 —— 见
 * injectPick 的注释。
 *
 * 匹配前先把日期和时段剥掉。标题里普遍挂着「（2026-10-02 中午他主动交代）」，
 * 不剥的话用户随口一句「今天中午吃什么」会命中那个「中午」，把一条讲 CS2
 * 仓位的记忆翻出来 —— 实测就是这么错的。剥掉的只是匹配用的副本，正文不动。
 */
const DATE_NOTE = /20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|夜里|半夜|晚)?/g

/** 纯时间词不算信号：它们描述的是「什么时候聊的」，不是「聊了什么」。 */
const TIME_WORDS = new Set(
  '今天 明天 昨天 前天 后天 早上 上午 中午 下午 傍晚 晚上 深夜 半夜 凌晨 刚才 现在 最近 平时 每天 那天 这天 时候 时间'.split(' '),
)

function headlineOf(seg) {
  const first = seg.text.split('\n').find((l) => !isNoiseLine(l)) ?? ''
  const clean = stripComments(first)
  const bold = clean.match(/\*\*(.+?)\*\*/)
  const head = bold ? bold[1] : plain(first).slice(0, 40)
  return head.replace(DATE_NOTE, '')
}

/** 空行，或者整行都是提炼标记 —— 都不该当「第几行」。 */
const isNoiseLine = (line) => isBlank(line) || !stripComments(line).trim()

/**
 * 虚词：命中词里沾上一个就整个扔掉。
 *
 * 这条是给「标题匹配」补的最后一道。2-gram 会把词切碎，碎片散落在标题里也是
 * 可能的 —— 「想要一个 QQ 版的我」切出「的我」，「帮我把这个文件」切出「把这」，
 * 两句都能对上一个标题。而跨词边界切出来的碎片，几乎一定含虚词；真词几乎一定
 * 不含（台灯、雨天、拍照、健身、沙盘、缓存、插件、日记、心理、记账）。
 *
 * 注意这里的判据是「沾一个就扔」，跟上面 STOP 的「两个都是虚词才扔」不是一回事：
 * STOP 用于检索（宁可多留），这个用于注入（宁可少给）。
 */
const FUNC_CHARS = new Set(
  '的了是在和与也都就很吗呢吧啊这个我你他她它们着过但被让给对从向往到为以因所之其哪怎样么把还只再才又多'.split(''),
)
const hasFuncChar = (gram) => [...gram].some((c) => FUNC_CHARS.has(c))

/**
 * 取给模型看的那一段正文，连同行号。
 *
 * 行号必须是**正文第一行的真实行号**，不能拿切段起点充数：记忆文件里每条
 * 前面都挂着一行 `<!--@refine id=... -->`，拿切段起点会把「第 129 行」指到
 * 那行注释上，模型照号去翻会翻到一条看不懂的东西 —— 那比不给行号更坏。
 *
 * 只承诺起始行，不承诺结束行：正文超预算会从尾部截断，承诺结束行就是撒谎。
 */
function bodyWindow(seg) {
  const lines = seg.text.split('\n')
  let first = 0
  while (first < lines.length && isNoiseLine(lines[first])) first++

  const out = []
  let used = 0
  let truncated = false
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]
    if (used + line.length > INJECT.bodyChars) {
      const room = INJECT.bodyChars - used
      if (room > 0) out.push(line.slice(0, room) + '…')
      truncated = true
      break
    }
    out.push(line)
    used += line.length + 1
  }

  return {
    text: out.join('\n').trim(),
    startLine: seg.startLine + first,
    truncated,
  }
}

/**
 * 拿一句用户原话，挑出最多一条要带进上下文的记忆。
 * @param {string} query - 用户这一轮的原话，不是抠出来的词。
 * @returns {null | {path, startLine, label, text, truncated, terms, score}}
 */
export function injectPick(query) {
  const q = String(query ?? '').trim()
  if (q.length < 2) return null

  const grams = tokenize(stripComments(q))
  if (!grams.length) return null

  const { pool, N, df, total, heads } = injectIndex()
  if (!N) return null

  // 候选词：库里出现过、不是烂大街的、不含虚词、不是纯时间词。
  //
  // 「不是跨词碎片」这条以前写成 minTotal>=2（全库出现两次以上）。它挡得住
  // 「忆插」这种切词时崩出来的碎片，但会误杀**独有真名**：全库只出现一次的
  // 人名、宠物名、专有名词，正是最该被想起来的东西，一个都不能漏。而碎片不可能
  // 出现在标题里 —— 标题是人写的一句话摘要，没人会在标题里写「忆插」。所以放宽：
  // 只出现一次的词，只要它出现在某条标题里，就当真词收下。
  const inSomeHead = (g) => heads.some((h) => h.includes(g))
  const terms = [...new Set(grams)].filter((g) => {
    const d = df.get(g) ?? 0
    if (d <= 0 || d > INJECT.maxDf) return false
    if (hasFuncChar(g) || TIME_WORDS.has(g)) return false
    return (total.get(g) ?? 0) >= INJECT.minTotal || inSomeHead(g)
  })
  if (!terms.length) return null

  // 只在标题里找。标题匹配是这套办法的全部信号源，不掺正文。
  const scored = []
  for (const seg of pool) {
    const head = headlineOf(seg)
    const hit = terms.filter((t) => head.includes(t))
    if (!hit.length) continue
    let score = 0
    for (const t of hit) score += Math.log(N / df.get(t))
    scored.push({ seg, hit, score, head })
  }

  // 同分时优先「命中词占标题的比例更高」的那条：标题越短，命中一个词就说明
  // 这条越集中在这件事上。反例是「CS2 饰品仓位与他的保本心理」和「他的心理
  // 健康底色」都含「心理」，该选后者。
  const density = (c) => c.hit.join('').length / Math.max(c.head.length, 1)
  scored.sort((a, b) => b.score - a.score || density(b) - density(a) || a.seg.startLine - b.seg.startLine)
  const top = scored[0]
  if (!top || top.score < INJECT.minScore) return null

  const body = bodyWindow(top.seg)
  if (!body.text) return null

  return {
    path: top.seg.path,
    startLine: body.startLine,
    label: top.seg.label,
    text: body.text,
    truncated: body.truncated,
    terms: top.hit,
    score: Number(top.score.toFixed(2)),
  }
}
