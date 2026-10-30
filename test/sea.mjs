/**
 * 记忆海数据层验收 —— 只读真实记忆，不写任何东西。
 *
 *   node test/sea.mjs
 *
 * 图这种「看着不对但说不出哪不对」的东西，最该钉死的是**不变量**：
 * 层统计对不对得上、每条有没有日期、连线的两头存不存在。
 * 真数据上的形状（多少条、跨度多长）只打印出来看，不做断言 ——
 * 记忆天天在长，写死数字的测试第二天就红。
 */
import { buildSea } from '../sea.js'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

const live = buildSea()
if (!live.total) {
  console.log('SKIP  ~/.dsh/memory 下没有可切分的条目')
  process.exit(0)
}

console.log(`形状：${live.total} 个节点 · ${live.edges.length} 条连线 · ${live.chars} 字`)
console.log(`跨度：${live.range.from} → ${live.range.to}`)
for (const l of live.layers) console.log(`  ${l.zone}\t${l.label}\t${l.count} 条`)

check('节点非空', live.total > 0)
check('每个节点都有日期', live.nodes.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.date)))
check('每个节点都有行号', live.nodes.every((n) => Number.isInteger(n.line) && n.line >= 1))
check('每个节点都归了层', live.nodes.every((n) => live.layers.some((l) => l.id === n.layer)))
check('层统计之和等于节点数', live.layers.reduce((s, l) => s + l.count, 0) === live.total)
check('节点 id 与下标一致', live.nodes.every((n, i) => n.id === i))
check('默认不加载沉积层', live.nodes.every((n) => !n.archived))
check(
  '连线两头都在范围内',
  live.edges.every((e) => e.a >= 0 && e.a < live.total && e.b >= 0 && e.b < live.total && e.a !== e.b)
)
check('连线不指向沉积层', live.edges.every((e) => !live.nodes[e.a].archived && !live.nodes[e.b].archived))
check('日期范围来自真实节点', live.nodes.some((n) => n.date === live.range.to))

// 沉积层：显式要才有，且节点数要变大
const full = buildSea({ withArchive: true })
check('显式要沉积层时节点变多', full.total > live.total, `${live.total} → ${full.total}`)
check('沉积层单独成层', full.layers.some((l) => l.id === 'archive'))

// 正文截断
const cut = buildSea({ bodyLimit: 100 })
check('正文按预算截断', cut.nodes.every((n) => n.text.length <= 100))
check('截断会留记号', cut.nodes.some((n) => n.truncated === true))

// 读两次结果一致（没有隐式全局状态）
const again = buildSea()
check(
  '两次调用节点数一致',
  again.total === live.total,
  `${live.total} / ${again.total}`
)

// 指纹与身份：面板靠这两样判断「自上次打开动没动」和「哪几条是新的」
check('指纹存在且不含正文', typeof live.digest === 'string' && live.digest.length > 0 && !/[\u4e00-\u9fa5]{6}/.test(live.digest))
check('文件没动则指纹不变', again.digest === live.digest)
check('每条都有稳定身份 key', live.nodes.every((n) => typeof n.key === 'string' && n.key.includes('|')))
check('key 两两不重复', new Set(live.nodes.map((n) => n.key)).size === live.total, `${new Set(live.nodes.map((n) => n.key)).size} / ${live.total}`)
check(
  'key 不随 id 漂移（同样数据同样 key）',
  live.nodes.every((n, i) => n.key === again.nodes[i].key)
)
check('要了沉积层指纹就跟着变', full.digest !== live.digest)

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
