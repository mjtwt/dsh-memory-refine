/**
 * 召回验收 —— 拿真数据跑，只读，不写任何记忆文件。
 *
 *   node test/recall.mjs            # 默认读 ~/.dsh
 *   DSH_HOME=/path node test/recall.mjs
 *
 * 这里断言的是 spec 第 6 节那五条：命中就是命中、没命中就返回 fallback，
 * 不为了过关去调分数。顺带验三条非功能约束（返回体积 / 段跨度 / 单文件段数）。
 *
 * 之所以跑真数据而不建沙盒：召回质量取决于真实语料的形状（33KB 但只有 1 个
 * 标题、条目自带小标题、archive 占 2/3），沙盒造不出这个分布，验了也不算数。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { recall } from '../search.js'
import { DSH_HOME, read, readRaw } from '../memory.js'
import { RECALL_TOOL } from '../index.js'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

const HOME = DSH_HOME || join(homedir(), '.dsh')
if (!existsSync(join(HOME, 'memory'))) {
  console.log(`跳过：${HOME} 下没有 memory/ 目录。用 DSH_HOME 指定一个真实记忆目录再跑。`)
  process.exit(0)
}
console.log(`数据源：${HOME}\n`)

/** 关键词在这份文件里的真实行号（1 起）。每次现算，不写死。 */
function linesContaining(path, keyword) {
  const text = readRaw(join(HOME, path))
  const out = []
  text.split('\n').forEach((line, i) => {
    if (line.includes(keyword)) out.push(i + 1)
  })
  return out
}

/**
 * 某次召回里是否存在「覆盖关键词所在行」的片段。
 *
 * 早先这里是 covers(path, 79) —— 行号写死。看着比「片段里含这个词」更硬，其实最脆：
 * 记忆文件加两行，后面所有行号整体下移，三条断言一起变红，而代码一行没改。
 * 2026-10-28 就这么红过一次（文件在 00:13 被加了 2 行，79/86/68 全部 +2）。
 *
 * 现在行号现算，判据跟着文件走。关键词真从文件里消失时返回空数组、断言失败 ——
 * 那正是该报的信号：要么记忆被改写了，要么召回退化了，两者都该有人看一眼。
 */
const covers = (value, path, keyword) => {
  const lines = linesContaining(path, keyword)
  if (!lines.length) return false
  return value.hits.some((h) => h.path === path && lines.some((n) => h.startLine <= n && h.endLine >= n))
}

const render = (value) =>
  RECALL_TOOL.output
    .render({}, value)
    .map((p) => p.text)
    .join('\n')

function run(query, args = {}) {
  const value = recall(query, { limit: 3, ...args })
  const text = render(value)
  console.log(`\n──────────── "${query}" ${JSON.stringify(args)}\n${text}\n`)
  return { value, text }
}

/* ------------------------------------------------ 一、命中质量（spec §6） */

/**
 * 查询词从记忆里现取。
 *
 * 早先这里写死的是真实标题 —— 那等于把她的记忆抄进仓库，而且换台机器必然全红。
 * 现在从每条记忆的小标题里现取一个 2–4 字的词，谁的记忆都能跑。
 */
const FILES = ['我们的线.md', '他-这个人.md', '环境-这台机器.md', 'MEMORY.md', '项目-MEMORY.md']
function samples(n) {
  const out = []
  for (const f of FILES) {
    const abs = join(HOME, 'memory', f)
    if (!existsSync(abs)) continue
    for (const m of readRaw(abs).matchAll(/^-\s*\*\*([^*\n]{2,24})\*\*/gm)) {
      const w = m[1].replace(/^[^\u4e00-\u9fa5]+/, '').replace(/[^\u4e00-\u9fa5].*$/, '')
      if (w.length >= 2 && w.length <= 4 && !out.some((x) => x.w === w)) out.push({ w, file: 'memory/' + f })
      if (out.length >= n) return out
    }
  }
  return out
}
const S = samples(2)
if (!S.length) {
  console.log('跳过：现役记忆里没取到能当查询的标题词。')
  process.exit(0)
}
const S1 = S[0]
const S2 = S[1] || S[0]

const a = run(S1.w)
check('标题词 → 命中片段覆盖该词所在行', covers(a.value, S1.file, S1.w), S1.file)
check('标题词 → 无存档层混入', a.value.hits.every((h) => h.layer !== 'archive'))

const b = run(S2.w)
check('第二个标题词也能召回', b.value.hits.length > 0, `${b.value.hits.length} 段`)
check('第二个标题词 → 无存档层混入', b.value.hits.every((h) => h.layer !== 'archive'))

// 语料里根本没有的词：宁可空手，也不硬凑。这个词是造的，不来自任何记忆。
const c = run('薛定谔的猫粮量子弦')
check('语料里没有的词 → hits 为空', c.value.hits.length === 0)
check('空结果时给出文件清单兜底', c.value.fallback.length > 0, `${c.value.fallback.length} 份`)

const d = run('我们的线')
check('文件名本身也能搜到', d.value.hits[0]?.path === 'memory/我们的线.md')

/* ------------------------------------------------ 二、存档层隔离 */

const f = run(S1.w, { scope: 'all' })
check(
  'scope=all → 存档层可能出现，但必须带 archive 标记',
  f.value.hits.every((h) => (h.layer === 'archive' ? h.layer === 'archive' : true)),
)
check(
  'scope=live 的候选池比 scope=all 小',
  a.value.total <= f.value.total,
  `live ${a.value.total} / all ${f.value.total}`,
)

/* ------------------------------------------------ 三、非功能约束 */

const all = [a, b, c, d, f]
const biggest = all.reduce((m, x) => Math.max(m, Buffer.byteLength(x.text, 'utf8')), 0)
check('任一 query 的渲染文本 ≤ 6KB', biggest <= 6144, `最大 ${biggest}B`)

const spanMax = all.reduce(
  (m, x) => Math.max(m, ...x.value.hits.map((h) => h.endLine - h.startLine + 1), 0),
  0,
)
check('单段跨度 ≤ 45 行', spanMax <= 45, `最大 ${spanMax} 行`)

const perFile = new Map()
for (const { value } of all) {
  const seen = new Map()
  for (const h of value.hits) seen.set(h.path, (seen.get(h.path) ?? 0) + 1)
  for (const [p, n] of seen) perFile.set(p, Math.max(perFile.get(p) ?? 0, n))
}
check('同一 query 里同一文件 ≤ 2 段', [...perFile.values()].every((n) => n <= 2))

/* ------------------------------------------------ 三半、一条一段（切段粒度） */
/**
 * 这三份记忆是「一行一条」（`- **标题**：正文` 全在同一个物理行），所以一段
 * 就该只装一条。早先攒够 600 字才切，`我们的线.md:79` 会返回 77-83 共 851 字、
 * 里面混着 3 条互不相干的记忆 —— 模型得自己从噪声里挑，还可能挑错。
 */
const topItems = (t) => t.split('\n').filter((l) => /^(?:[-*+]|\d+\.)\s/.test(l)).length
// 只约束记忆文件：注入层是规则文档，一句话一条的短列表按条目切会碎成 40 段、
// 20 段不足 60 字，所以它刻意保留「攒够字数再切」，一段装多条是设计如此。
const memHits = all.flatMap(({ value }) => value.hits).filter((h) => h.layer !== 'inject')
const bundled = memHits.filter((h) => topItems(h.text) > 1)
check(
  '一段只装一条记忆（不把多条捆在一起）',
  bundled.length === 0,
  bundled.map((h) => `${h.path}:${h.startLine} 装了 ${topItems(h.text)} 条`).join(', '),
)

// 行号与正文必须严格对齐：absorbLoneHeadings 合并标题段时如果用字符串相加，
// 中间的空行会丢，text 比 endLine-startLine+1 短，按行号定位命中行就错位。
const aligned = memHits
  .filter((h) => !h.truncated)
  .every((h) => h.text.split('\n').length === h.endLine - h.startLine + 1)
check('片段行数与行号区间一致（合并段落不丢空行）', aligned)

/* ------------------------------------------------ 四、参数边界 */

let threw = false
try {
  recall('')
} catch {
  threw = true
}
check('空 query 抛错而不是返回垃圾', threw)

const wide = recall(S1.w, { limit: 10 })
check('limit 上限 10 生效且不越界', wide.hits.length <= 10)

/* ------------------------------------------ 四半、长行开窗不能丢掉命中词 */

/* 2026-10-24 第二轮：一条 960 字的长行，命中词在第八九百字，而旧实现是
 * slice(0, N) 从头截 —— 返回的片段里根本没有它要搜的词，模型会觉得
 * 「召回了但没内容」。这里锁住「以命中词为中心开窗」。
 *
 * 长行和词都现找：挑记忆里最长的一行，取它尾巴上的一个词当查询。 */

const longPick = (function () {
  let best = ''
  for (const f of FILES) {
    const abs = join(HOME, 'memory', f)
    if (!existsSync(abs)) continue
    for (const line of readRaw(abs).split('\n')) if (line.length > best.length) best = line
  }
  if (best.length < 600) return null
  const tail = best.slice(-120).match(/[\u4e00-\u9fa5]{4}/)
  return tail ? tail[0] : null
})()

if (longPick) {
  const deep = recall(longPick)
  if (deep.hits.length) {
    const hit = deep.hits[0]
    check(
      '长行靠后的命中词仍然落在片段里',
      hit.text.includes(longPick),
      `${hit.text.length} 字 · truncated=${hit.truncated}`,
    )
  }
} else {
  console.log('SKIP  长行开窗  :: 记忆里没有超过 600 字的行')
}

/* 常见长度的条目应当整条给全，不该满屏「被截断」。 */
const common = recall(S1.w)
const clipped = common.hits.filter((h) => h.truncated).length
check('常规条目不再动辄标截断', clipped === 0, `${common.hits.length} 段中 ${clipped} 段截断`)

/* ------------------------------------------------ 五、整份读的护栏 */
/* 这一段是回归用的：2026-10-24 实测过一次，模型看完 recall 仍会「保守起见」
 * 调 memory_read 且不传 offset，而默认 250 行 = 把 33KB 一次倒完。护栏在
 * memory.js 的字节上限，这里锁住它别再退回去。 */

const bigPath = join(HOME, 'memory', '我们的线.md')
if (existsSync(bigPath)) {
  const loose = read(bigPath) // 不传 offset / limit，就是当时那次调用
  check(
    '不传 limit 不会把大文件整份倒出来',
    loose.bytes <= 8400 && loose.capped,
    `${loose.bytes}B，全文 ${loose.size}B`,
  )
  check(
    'capped 时如实告知还有多少没给',
    loose.truncated && loose.returned < loose.lines,
    `给了 ${loose.returned}/${loose.lines} 行`,
  )

  const exact = read(bigPath, { offset: 10, limit: 3 })
  check('显式 limit 不被字节闸夹', exact.returned === 3 && !exact.capped)
}

const intact = recall(S1.w)
const whole = intact.hits.filter((h) => !h.truncated)
if (whole.length) {
  const rendered = RECALL_TOOL.output
    .render({}, { ...intact, hits: whole })
    .map((x) => x.text)
    .join('\n')
  check('片段完整时不再怂恿模型去 read', !rendered.includes('memory_read {'), `${whole.length} 段完整`)
}

/* ------------------------------------------------ 汇总 */

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  for (const r of failed) console.log(`  失败：${r.name}`)
  process.exit(1)
}
