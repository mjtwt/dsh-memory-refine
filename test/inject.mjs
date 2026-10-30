/**
 * 自动注入验收 —— 拿真数据跑，只读，不写任何记忆文件。
 *
 *   node test/inject.mjs            # 默认读 ~/.dsh
 *   DSH_HOME=/path node test/inject.mjs
 *
 * 验四件事：
 *   1. 该触发的一定触发（撞上标题的实体词）；
 *   2. 不该触发的一条都不许触发（闲聊、口头语、虚词碎片、纯时间词）；
 *   3. **行号指着的那一行，就是返回正文的第一行**——这是最硬的一条，也是
 *      最容易做错的一条：记忆文件每条前面挂着 `<!--@refine ... -->`，报切段
 *      起点会指到注释上，比不给行号更坏；
 *   4. 正文不超预算。
 *
 * 断言里的关键词一律现查，不写死行号（`test/recall.mjs` 踩过这个坑：文件加
 * 两行，写死的行号全红，而代码一行没改）。关键词真从记忆里消失时，那一条
 * 标 SKIP 而不是 FAIL。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { injectPick } from '../search.js'
import { DSH_HOME, readRaw } from '../memory.js'

const HOME = DSH_HOME || join(homedir(), '.dsh')
if (!existsSync(join(HOME, 'memory'))) {
  console.log(`跳过：${HOME} 下没有 memory/ 目录。用 DSH_HOME 指定一个真实记忆目录再跑。`)
  process.exit(0)
}
console.log(`数据源：${HOME}\n`)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}
function skip(name, why) {
  console.log(`SKIP  ${name}  :: ${why}`)
}

let cache = null
function readAll() {
  if (cache) return cache
  const out = []
  for (const f of ['我们的线.md', '他-这个人.md', '环境-这台机器.md', 'MEMORY.md', '项目-MEMORY.md']) {
    const abs = join(HOME, 'memory', f)
    if (existsSync(abs)) out.push(readRaw(abs))
  }
  cache = out
  return out
}

/* ------------------------------------------------ 1. 该触发的 */

/**
 * 从句子里「那个 X 的事」的 X 猜他会说什么 —— 样例词从现役记忆的标题里现取。
 *
 * 早先这里是写死的真词（就是她某几条记忆的标题）。两个毛病：一是不该把她的
 * 记忆抄进仓库，二是换台机器就全变成 skip，等于没测。现取之后，谁的记忆都能跑。
 */
function titleWords() {
  const out = []
  for (const seg of readAll()) {
    for (const m of seg.matchAll(/^-\s*\*\*([^*\n]{2,14})\*\*/gm)) {
      const w = m[1].replace(/^[^\u4e00-\u9fa5]+/, '').replace(/[^\u4e00-\u9fa5].*$/, '')
      if (w.length >= 2 && w.length <= 4 && !out.includes(w)) out.push(w)
      if (out.length >= 10) return out
    }
  }
  return out
}

const words = titleWords()
if (!words.length) {
  skip('「该触发」那一组', '现役记忆里没取到能当样例的标题词')
} else {
  // 只瞄前几个：标题词不一定都满足 injectPick 的稀有度门槛（df 要 ≤ 4），
  // 所以这一组断言的是「至少有一条真能把她的话接住」，不是「每条都接住」。
  let fired = 0
  for (const w of words) {
    const pick = injectPick('那个' + w + '的事')
    if (pick && pick.text.includes(w)) fired++
  }
  // 只报数量，不报是哪几个词：日志会被截图贴出去，那些词是她的记忆
  check('标题词出现在原话里就会触发', fired > 0, `${fired}/${words.length} 条接住`)
}

/* ------------------------------------------------ 2. 不该触发的 */

const MUST_NOT_FIRE = [
  '今天好累',
  '我饿了',
  '你怎么看',
  '我想吃火锅',
  '好的我知道了',
  '这段代码有个 bug',
  '帮我把这个文件改一下',
  '还要多久',
  '今天中午吃什么好呢',
  '刚才说的那个',
  '嗯',
  '对',
]

for (const say of MUST_NOT_FIRE) {
  const pick = injectPick(say)
  check(`「${say}」不该触发`, pick === null, pick ? `却塞了 ${pick.label}` : '')
}

/* ------------------------------------------------ 3. 行号指着正文 */

console.log('\n--- 行号与正文 ---')
// 用上面现取到的词，句式各不同 —— 行号校验跟句子长得像不像没关系，只要真触发。
// 断言名只写编号：这些句子里的词是她记忆里的，不该出现在日志里。
const LINE_CASES = words.slice(0, 4).map((w) => '那个' + w + '的事')
LINE_CASES.forEach(function (say, i) {
  const tag = '样例 ' + (i + 1) + '「那个…的事」'
  const pick = injectPick(say)
  if (!pick) {
    skip(tag + ' 行号', '没触发')
    return
  }
  const raw = readRaw(join(HOME, pick.path)).split('\n')
  const at = (raw[pick.startLine - 1] ?? '').trim()
  const first = pick.text.split('\n')[0].trim()

  // 行号必须落在正文上：不是空行，不是提炼标记（**只打印长度，不打印那一行**：
  // 测试日志会被截图、被贴出去，而那一行是她的记忆）
  check(`${tag} 行号不是注释/空行`, at !== '' && !at.startsWith('<!--'), `L${pick.startLine} · ${at.length} 字`)

  // 更强的一条：那一行就是返回正文的第一行
  const sameLine = pick.truncated ? at.startsWith(first.replace(/…$/, '')) : at === first
  check(`${tag} 行号指向正文首行`, sameLine, pick.truncated ? '(正文被截，只比前缀)' : '')

  check(`${tag} 正文不超预算`, pick.text.length <= 820, `${pick.text.length} 字`)
})

/* ------------------------------------------------ 4. 边界 */

console.log('\n--- 边界 ---')
check('空串不触发', injectPick('') === null)
check('单字不触发', injectPick('嗯') === null)
check('纯英文符号不触发', injectPick('???') === null)
check('超长句子不炸', typeof injectPick('这是一句很长的话'.repeat(200)) !== 'undefined')

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
