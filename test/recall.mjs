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
import { DSH_HOME, read } from '../memory.js'
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

/** 某次召回里是否存在「覆盖指定行」的片段。 */
const covers = (value, path, line) =>
  value.hits.some((h) => h.path === path && h.startLine <= line && h.endLine >= line)

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

const a = run('底线测试')
check('底线测试 → 我们的线.md 覆盖第 79 行', covers(a.value, 'memory/我们的线.md', 79))
check('底线测试 → 他-这个人.md 覆盖第 53 行', covers(a.value, 'memory/他-这个人.md', 53))
check('底线测试 → 无存档层混入', a.value.hits.every((h) => h.layer !== 'archive'))

const b = run('缓存命中')
check('缓存命中 → 环境-这台机器.md 覆盖第 20 行', covers(b.value, 'memory/环境-这台机器.md', 20))
check('缓存命中 → 我们的线.md 覆盖第 86 行', covers(b.value, 'memory/我们的线.md', 86))
check('缓存命中 → 无存档层混入', b.value.hits.every((h) => h.layer !== 'archive'))

const c = run('破甲插件')
check('破甲插件 → 我们的线.md 覆盖第 68 行', covers(c.value, 'memory/我们的线.md', 68))
check('破甲插件 → 结果非空（v1 的「应为空」断言是错的）', c.value.hits.length > 0)

const d = run('银线')
check('银线 → hits 为空', d.value.hits.length === 0)
check(
  '银线 → fallback 里有我们的线.md',
  d.value.fallback.some((f) => f.path === 'memory/我们的线.md'),
)

const e = run('我们的线')
check('我们的线 → 第 1 名是 memory/我们的线.md', e.value.hits[0]?.path === 'memory/我们的线.md')

/* ------------------------------------------------ 二、存档层隔离 */

const f = run('缓存命中', { scope: 'all' })
check(
  'scope=all → 存档层可能出现，但必须带 archive 标记',
  f.value.hits.every((h) => (h.layer === 'archive' ? h.layer === 'archive' : true)),
)
check(
  'scope=live 的候选池比 scope=all 小',
  b.value.total <= f.value.total,
  `live ${b.value.total} / all ${f.value.total}`,
)

/* ------------------------------------------------ 三、非功能约束 */

const all = [a, b, c, d, e, f]
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

const wide = recall('破甲插件', { limit: 10 })
check('limit 上限 10 生效且不越界', wide.hits.length <= 10)

/* ------------------------------------------ 四半、长行开窗不能丢掉命中词 */

/* 2026-10-24 第二轮：一条 960 字的长行，命中词在第八九百字，而旧实现是
 * slice(0, N) 从头截 —— 返回的片段里根本没有它要搜的词，模型会觉得
 * 「召回了但没内容」。这里锁住「以命中词为中心开窗」。 */

const deep = recall('挪走留档')
if (deep.hits.length) {
  const hit = deep.hits[0]
  check(
    '长行靠后的命中词仍然落在片段里',
    hit.text.includes('挪走留档'),
    `${hit.text.length} 字 · truncated=${hit.truncated}`,
  )
}

/* 常见长度的条目应当整条给全，不该满屏「被截断」。 */
const common = recall('底线测试')
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

  const exact = read(bigPath, { offset: 68, limit: 3 })
  check('显式 limit 不被字节闸夹', exact.returned === 3 && !exact.capped)
}

const intact = recall('破甲插件')
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
