/**
 * 记忆海的数据层 —— 纯函数，不碰宿主、不写盘。
 *
 * 把 `memory/*.md` 里的「一条一块」切成节点：海域 = 文件，深度 = 日期，
 * 连线 = 共用关键词。给面板那边的 canvas 直接用。
 *
 * 跟 `~/memory-sea/build.mjs` 是同一套口径（那份是独立原型，
 * 产出单文件 index.html；这份供插件面板调用）。改判据时两边要一起想，但**不要
 * 合并**：原型要能脱机跑、能发给别人看，这边要跟着 DSH_HOME 走。
 *
 * 读的是插件已有的 MEMORY_DIR，不另开门；**只读**，一个字节都不写回记忆目录。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MEMORY_DIR } from './memory.js'

/** 现役五片海域。顺序就是面板里从左到右的顺序。 */
export const SEA_LAYERS = [
  { id: 'line', file: '我们的线.md', label: '我们的线', zone: '暖流', color: '#4ea8de', hint: '关系、约定、梗' },
  { id: 'self', file: '他-这个人.md', label: '他 · 这个人', zone: '浅滩', color: '#e8833a', hint: '身体、训练、心理' },
  { id: 'env', file: '环境-这台机器.md', label: '环境 · 这台机器', zone: '深沟', color: '#5fbf9b', hint: '工具、系统、成本' },
  { id: 'core', file: 'MEMORY.md', label: '核心规则', zone: '海脊', color: '#c084fc', hint: '索引与跨类规则' },
  { id: 'proj', file: '项目-MEMORY.md', label: '项目', zone: '礁石', color: '#8fa3b8', hint: '项目级常驻' },
]

const ARCHIVE_LAYER = {
  id: 'archive',
  label: '沉积层',
  zone: '海床',
  color: '#5b6b7c',
  hint: '旧快照，只作回溯',
}

/** 记忆系统 2026-08 才有；早于此的日期是正文引用的旧事，不算这条的沉淀时间。 */
const SEA_START = Date.parse('2026-08-01')

const STOP_CHARS = new Set(
  (
    '的了是我你他她它这那就都也还不没有和与在很会能被把让给对从到而而且但因为所以如果虽然可以什么这个那个' +
    '自己一个时候已经现在里上下来去说做着过得地之其或等则于以为因此如若并且或者一样这种那些多少怎么还再又' +
    '们啊吧呢吗呀哦嗯么真太更最只会要想该得吧种次点儿'
  ).split('')
)

const STOP_GRAMS = new Set([
  '记忆', '条目', '我们', '他说', '说这', '这条', '那条', '一条', '一次', '那天', '当天', '以后', '之前',
  '时候', '自己', '不是', '就是', '这个', '那个', '一个', '现在', '因为', '所以', '但是', '而且', '然后',
  '如果', '虽然', '可以', '已经', '还是', '一样', '没有', '什么', '怎么', '这样', '那样', '这些', '那些',
  '一下', '一起', '直接', '别把', '不要', '不许', '不能', '规则', '做法', '接法', '用法', '记住', '别再',
  '原话', '性质', '意思', '觉得', '认为', '知道', '看到', '起来', '出来', '过来', '进去',
])

/**
 * 不作为连线标签的词 —— 她写记忆时的行文习惯，不是内容。
 *
 * 这批跟上面的 STOP_GRAMS 分工不同：STOP_GRAMS 是「分词阶段就该扔的泛词」，
 * 这张表是「能通过 df 阈值、但作为连线依据毫无信息量」的词。
 *
 * 为什么需要它：这些词的 df 恰好卡在阈值边缘（10–14 条记忆），单靠阈值挡不住。
 * 实测过 —— 光「当成」一个词就制造了 29 条连线，「深夜」28 条，「今天」22 条。
 * 于是 363 条边里有 201 条只共享一个词，而那些词全是口水。图上看着热闹，
 * 实际上是她的语气在跟自己的语气连线。
 *
 * 这张表是**保险**，不是主要手段：主要手段是把 df 阈值从 14 收到 6（见 SEA_MAX_DF），
 * 那一刀已经把这些词全部排除了。留着是防以后出现新的习惯词卡在 6 以下。
 */
const SEA_STOP_TAGS = new Set([
  // 时间（日期已经单独映射到纵轴了，不该再当关键词用一次）
  '今天', '明天', '昨天', '那天', '当天', '次日', '深夜', '中午', '晚上', '早上', '下午', '凌晨', '今天',
  // 结构、量词
  '件事', '句话', '东西', '时候', '样子', '地方', '情况', '部分', '内容', '方面', '第二', '第一', '第三',
  // 纯语气与判断副词
  '当成', '其实', '确实', '明显', '完整', '明确', '基本', '大概', '几乎', '完全', '特别', '非常',
])

/**
 * 一个词最多出现在几条记忆里，才配当连线依据。
 *
 * 14 → 6 的来历：原来 14 是想「别太窄」，结果那些纯语气词的 df 全在 10–14 之间，
 * 等于门槛恰好设在噪音刚好能过的地方。收到 6 之后，边数 363 → 227，并且浮出
 * 13 条真正的孤岛（原来 0 条 —— 不是记忆都相关，是门槛太松，谁都能连上谁）。
 */
const SEA_MAX_DF = 6

/** 去掉标记、markdown 强调、反引号与多余空白，留可读正文。 */
function clean(raw) {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 抽 2–3 字候选词：连续中文片段切 gram，去停用字、去泛词。 */
function grams(text) {
  const out = new Map()
  const runs = text.match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const run of runs) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n)
        if ([...g].some((c) => STOP_CHARS.has(c))) continue
        if (STOP_GRAMS.has(g)) continue
        out.set(g, (out.get(g) || 0) + 1)
      }
    }
  }
  return out
}

/**
 * 切条：一条 = 一个以 `- ` 开头的块，其后续行（缩进、子列表、`<!--@refine-->`）
 * 都归这一条。跟 search.js 的 segments() 口径一致 —— 两边说的是同一件事，
 * 只是那边给检索用、这边给画图用。
 */
export function splitSeaEntries(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let cur = null
  let pendingMarker = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = line.match(/<!--@refine\s+([^>]*)-->/)
    if (marker) {
      const attrs = {}
      for (const m of marker[1].matchAll(/(\w+)=([^\s]+)/g)) attrs[m[1]] = m[2]
      if (cur && !cur.refineId) Object.assign(cur, { refineId: attrs.id, markerDate: attrs.date, src: attrs.src })
      else pendingMarker = attrs
      if (cur) cur.raw += '\n'
      continue
    }
    if (/^- /.test(line)) {
      if (cur) entries.push(cur)
      cur = { startLine: i + 1, raw: line, refineId: null, markerDate: null, src: null }
      if (pendingMarker) {
        Object.assign(cur, { refineId: pendingMarker.id, markerDate: pendingMarker.date, src: pendingMarker.src })
        pendingMarker = null
      }
    } else if (cur) {
      cur.raw += '\n' + line
    }
  }
  if (cur) entries.push(cur)
  return entries
}

function loadLayer(nodes, layer, isArchive, sigs) {
  const path = join(MEMORY_DIR, layer.file)
  if (!existsSync(path)) {
    if (sigs) sigs.push(`${layer.file}:-`)
    return 0
  }
  let text
  let mtime
  let st
  try {
    st = statSync(path)
    mtime = st.mtime.toISOString().slice(0, 10)
    text = readFileSync(path, 'utf8')
  } catch {
    // 单个文件读不动不该让整片海消失
    if (sigs) sigs.push(`${layer.file}:!`)
    return 0
  }
  // 指纹只认「大小 + 修改时间」：够判断「文件动过没有」，也不用把正文再算一遍
  if (sigs) sigs.push(`${layer.file}:${st.size}:${Math.round(st.mtimeMs)}`)

  let kept = 0
  for (const e of splitSeaEntries(text)) {
    const body = clean(e.raw)
    if (body.length < 40) continue // 目录行、空壳、纯标题

    const dates = [...body.matchAll(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g)].map(
      (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    )
    // 一条里常引用旧事（比如几年前的某张照片）；取最晚的那个当「这条沉淀下来的
    // 时间」。全都早于记忆系统启用的时点，就退回文件修改时间。
    const valid = dates.filter((d) => Date.parse(d) >= SEA_START && Date.parse(d) <= Date.now())
    let date = e.markerDate || valid.sort().pop() || mtime
    const dm = String(date).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (dm) date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`

    const headline = body
      .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 46)

    nodes.push({
      id: nodes.length,
      layer: layer.id,
      file: layer.file,
      line: e.startLine,
      date,
      chars: body.length,
      headline,
      text: body,
      // 跨次稳定的身份：`id` 是下标，插一条后面全移位，拿它比「谁是新的」会全错。
      // 正文开头 40 字在编辑、增补下基本不动，够当一把钥匙；前端只存它的哈希。
      key: `${layer.file}|${body.slice(0, 40)}`,
      refineId: e.refineId || null,
      src: e.src || null,
      archived: !!isArchive,
    })
    kept++
  }
  return kept
}

/**
 * 铺一片海。
 *
 * @param {{ withArchive?: boolean, bodyLimit?: number }} [opts]
 *   withArchive 默认 false —— archive 里的旧快照会把现役记忆挤成角落，
 *   而且白拖一轮解析。想看得显式要。
 *   （archive 原始约 291 条，其中 24 条正文过短、被 40 字门槛滤掉，实际铺 267。
 *   所以注释和文案里都别写死数字 —— 图例上的数是实时算的，写死必然对不上。）
 *   bodyLimit 给正文截断（面板一次不要背几百 KB），0 表示不截。
 */
export function buildSea(opts = {}) {
  const withArchive = opts.withArchive === true
  const bodyLimit = Number.isFinite(opts.bodyLimit) ? Math.max(0, opts.bodyLimit) : 0

  const nodes = []
  const layers = []
  const sigs = []

  for (const layer of SEA_LAYERS) {
    const kept = loadLayer(nodes, layer, false, sigs)
    layers.push({
      id: layer.id,
      label: layer.label,
      zone: layer.zone,
      color: layer.color,
      count: kept,
      hint: layer.hint,
    })
  }

  if (withArchive) {
    const dir = join(MEMORY_DIR, 'archive')
    if (existsSync(dir)) {
      let total = 0
      let files = []
      try {
        files = readdirSync(dir).filter((x) => x.endsWith('.md'))
        const dst = statSync(dir)
        sigs.push(`archive:#:${files.length}:${Math.round(dst.mtimeMs)}`)
      } catch {
        sigs.push('archive:!')
      }
      for (const f of files) {
        total += loadLayer(
          nodes,
          { ...ARCHIVE_LAYER, file: `archive/${f}`, label: `沉积 · ${basename(f, '.md')}` },
          true,
          sigs
        )
      }
      if (total) layers.push({ ...ARCHIVE_LAYER, count: total })
    }
  }

  /* 关键词与连线 */

  const df = new Map()
  const perNode = nodes.map((n) => grams(n.text))
  for (const g of perNode) for (const k of g.keys()) df.set(k, (df.get(k) || 0) + 1)

  // 每条取打分最高的几个标签：字长加权、按 idf 打分、子串互相去重。
  //
  // 旧版这里是 `(k.length-1)*2.2*tf + Math.min(f,12)*0.55` —— 第二项在**奖励**
  // 高频词（f 越大加分越多，封顶 12）。结果「当成」「深夜」「今天」这些纯语气词
  // 因为到处都是，反而排进了每条记忆的标签里，再两两共现就织出一片假边。
  // 一条记忆的标签应该是**它独有**的词，不是它跟别人共有的口水。
  // 所以换成 idf 乘进去：f 越大权重越低。
  const N0 = Math.max(nodes.length, 1)
  const idfOf = (f) => Math.log(N0 / Math.max(f, 1))

  const tagSets = perNode.map((g) => {
    const cand = []
    for (const [k, tf] of g) {
      const f = df.get(k) || 1
      if (f < 2 || f > SEA_MAX_DF) continue
      if (STOP_GRAMS.has(k) || SEA_STOP_TAGS.has(k)) continue
      cand.push({ k, score: (k.length - 1) * 2.2 * tf * idfOf(f) })
    }
    cand.sort((a, b) => b.score - a.score)
    const picked = []
    for (const c of cand) {
      if (picked.length >= 6) break
      if (picked.some((p) => p.includes(c.k) || c.k.includes(p))) continue
      picked.push(c.k)
    }
    return picked
  })
  nodes.forEach((n, i) => {
    n.tags = tagSets[i]
    if (bodyLimit > 0 && n.text.length > bodyLimit) {
      n.text = n.text.slice(0, bodyLimit)
      n.truncated = true
    }
  })

  // 连线：共用标签。沉积层已经不按词连了（它们本来就是旧快照，连起来是噪音）
  const edges = []
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].archived) continue
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].archived) continue
      const shared = nodes[i].tags.filter((t) => nodes[j].tags.includes(t))
      if (!shared.length) continue
      // 权重 = 共享词的 idf 之和，不是「共享了几个词」。
      // 共有一个只有 2 条记忆用的词（idf≈4.1）比共有一堆 6 条记忆用的词
      // （每个 idf≈3.0）更能说明它们讲的是同一件事。按个数数会把两者算成一样。
      let w = 0
      for (const t of shared) w += idfOf(df.get(t) || 1)
      edges.push({ a: i, b: j, w: Number(w.toFixed(2)), tags: shared.slice(0, 3) })
    }
  }

  // 每个节点只留最亲的 4 条，免得画成毛球
  const byNode = new Map()
  for (const e of edges) {
    for (const k of [e.a, e.b]) {
      if (!byNode.has(k)) byNode.set(k, [])
      byNode.get(k).push(e)
    }
  }
  const keep = new Set()
  for (const [, list] of byNode) {
    list.sort((x, y) => y.w - x.w)
    list.slice(0, 4).forEach((e) => keep.add(e))
  }
  const finalEdges = [...keep]
    .filter((e) => keep.has(e) && (byNode.get(e.a).indexOf(e) < 4 || byNode.get(e.b).indexOf(e) < 4))
    .sort((a, b) => b.w - a.w)
    .slice(0, 400)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, tags: e.tags }))

  const dates = nodes.map((n) => n.date).sort()

  return {
    generatedAt: new Date().toISOString(),
    home: MEMORY_DIR,
    // 五份文件的「大小 + 修改时间」拼起来。面板拿它判断「自上次打开以来动过没有」，
    // 比比对正文便宜得多，也不依赖任何缓存里的内容。
    digest: sigs.sort().join('|'),
    layers,
    nodes,
    edges: finalEdges,
    range: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    total: nodes.length,
    chars: nodes.reduce((s, n) => s + n.chars, 0),
  }
}
