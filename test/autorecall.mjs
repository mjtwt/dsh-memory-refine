/**
 * 自动召回链路验收 —— 假一个宿主，把 apply() 真跑一遍。
 *
 *   node test/autorecall.mjs
 *
 * 为什么要在插件外面验：这里进不了真 DSH，而「注册得上不上、拿不拿得到
 * 他刚说的那句话、注入出来的东西长什么样」恰好是最容易错、又最不容易在
 * 真会话里看出来的三件事。真跑一遍胜过读十遍类型声明。
 *
 * 验六条：
 *   1. apply() 不炸，七个工具照样注册；
 *   2. systemPrompt.context 注册上了，name / order / interpolate 对；
 *   3. agent/pre-step 装上了，决策原样返回；
 *   4. 说一句撞得上记忆的话，text() 吐出带 `[记忆] ` 前缀的正文；
 *   5. **注入产生的那条消息不会被当成他的输入**（否则会自己吃自己）；
 *   6. 没撞上就返回空串 —— 空串才是不注入，返回别的东西都会被宿主当成内容。
 *
 * 注意：这里**不再测 session/event**。那条路在真机上一次都没触发过（宿主给
 * 用户消息打的是 turn/start、agent/inbox/spliced，没有 user/message），已于
 * 2026-10-30 删除。留着测一个永远不会来的事件，只会让人误以为它有保障。
 *
 * 日志会被这次测试写脏，跑完截回原长度。
 */
import { existsSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from '../memory.js'

const LOG = join(DSH_HOME, 'memory-refine-inject.log.jsonl')
const DEBUG = join(DSH_HOME, 'memory-refine-inject.debug.jsonl')
const sizeBefore = existsSync(LOG) ? statSync(LOG).size : 0
const debugSizeBefore = existsSync(DEBUG) ? statSync(DEBUG).size : 0

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

/* ---------------------------------------------------------- 假宿主 */

const toolNames = []
const contexts = []
const handlers = new Map()

const fakeCtx = {
  effect(fn) {
    try {
      return fn()
    } catch {
      return () => {}
    }
  },
  inject(names, cb) {
    // 模拟：systemPrompt 在场，webServer 缺席（精简部署就长这样）
    if (!names.includes('systemPrompt')) return
    cb({
      effect: (fn) => {
        try {
          return fn()
        } catch {
          return () => {}
        }
      },
      systemPrompt: {
        context: (c) => {
          contexts.push(c)
          return () => {}
        },
        getContextOrder: () => 0,
      },
    })
  },
  on(evt, fn) {
    handlers.set(evt, fn)
    return () => {}
  },
  get() {
    return undefined
  },
  skills: { register: () => () => {} },
  tools: {
    register: (t) => {
      toolNames.push(t.name)
      return () => {}
    },
  },
  commands: { register: () => () => {} },
}

/* ---------------------------------------------------------- 跑 */

const { apply } = await import('../index.js')
apply(fakeCtx)

check('apply 不炸，七个工具都在', toolNames.length === 7, toolNames.join(','))

const auto = contexts.find((c) => c.name === 'memory-refine:auto-recall')
check('自动召回注册上了', Boolean(auto))
check('name 稳定', auto?.name === 'memory-refine:auto-recall')
check('order 在身份段与源码段之间', auto?.order === 150)
check('关掉了插值', auto?.interpolate === false)

/*
 * pre-step —— 真机上唯一走得通的那条路。
 * 宿主顺序：claim → assemble(求值①) → pre-step → refreshContext(求值②)。
 * 我们的原话在 pre-step 的 payload.messages 里，记下来之后求值②就能用。
 */
const onPreStep = handlers.get('agent/pre-step')
check('pre-step 监听装上了', typeof onPreStep === 'function')

const fakeDecision = { kind: 'enter', messages: [], startsRequestSeries: true }
const prestep = (sid, text, turn) =>
  onPreStep(
    {
      agent: { id: sid },
      messages: text ? [{ role: 'user', content: [{ type: 'text', text }] }] : [],
      turn,
      step: 1,
    },
    async () => fakeDecision
  )
const renderOf = (sid, session) => auto.text({ agent: { id: sid, session } })

const SID = 'sess-test-autorecall'
// 还没说话：什么都不该有
check('没说话时不注入', renderOf(SID) === '')

// 说一句撞得上的
const kept = await prestep(SID, '那个台灯的事还记得吗', 1)
check('决策原样返回，不碰主流程', kept === fakeDecision)
const out = renderOf(SID)
check('撞上时吐出内容', out.startsWith('[记忆] '), out ? out.split('\n')[0] : '(空)')
check('第二行给了路径和行号', /^memory\/.+ 第 \d+ 行$/.test(out.split('\n')[1] ?? ''), out.split('\n')[1])
check('同一轮不重复注入', renderOf(SID) === '')

// 再说一句撞不上的：旧的那条不该被顶回来
await prestep(SID, '今天中午吃什么好呢', 2)
check('撞不上时清空', renderOf(SID) === '')

await prestep(SID, '今天好累', 3)
check('闲聊不注入', renderOf(SID) === '')

// 这一步没有新消息（同一轮里 pre-step 会被叫两次，第二次 n=0）：不顶回上一句
await prestep(SID, '', 3)
check('这一步没有新消息时，不把上一句顶回来', renderOf(SID) === '')

/*
 * 自己注入的那条也是 user/message，进 pre-step 时必须被认出来丢掉。
 * 认不出就会拿上一轮喂进去的记忆当这一轮他的输入，自己吃自己。
 */
const SID_SELF = 'sess-selffeed'
await prestep(SID_SELF, '那个台灯的事', 1)
await prestep(SID_SELF, '[记忆] 伪造的一行\nmemory/我们的线.md 第 1 行\n伪造正文', 2)
const outSelf = renderOf(SID_SELF)
check(
  '不把自己注入的当输入',
  outSelf.includes('台灯') && !outSelf.includes('伪造'),
  outSelf ? outSelf.split('\n')[0] : '(空)'
)

/*
 * 兜底路径：pre-step 没记上（id 对不上、或者别的什么），但会话日志里有他这句话
 * —— 必须照样能注入。这条路实测取不到（会话事件里没有 user/message），留着是
 * 防宿主改版，所以这里用假 session 守住它的行为不退化。
 */
const SID2 = 'sess-fallback'
const session2 = {
  header: { id: SID2 },
  snapshotEvents: () => [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '那个台灯的事' }] } } },
  ],
}
const out2 = renderOf(SID2, session2)
check('pre-step 没记上时，靠会话日志兜底', out2.startsWith('[记忆] '), out2.split('\n')[0])

// 只倒查、不碰事件：最后一条是他说的就取，是注入的就跳过
const session3 = {
  header: { id: 'sess-skip' },
  snapshotEvents: () => [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '那个台灯的事' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '[记忆] 上一轮注入的' }] } } },
  ],
}
const out3 = renderOf('sess-skip', session3)
check('倒查时跳过自己注入的那条', out3.includes('台灯'), out3.split('\n')[0])

// 会话里什么都没有：返回空串，不能吐半截
check(
  '空会话返回空串',
  renderOf('sess-empty', { header: { id: 'sess-empty' }, snapshotEvents: () => [] }) === ''
)

// 宿主没给 session 也不能炸
check('没有 session 时不炸', renderOf('sess-nosession') === '')

/*
 * 清场：这次测试往日志里写了行，截回原长度。
 * 日志是给人看的样本，不该被测试数据污染 —— 那会让「错塞率」这个判断失真。
 */
try {
  if (existsSync(LOG)) truncateSync(LOG, sizeBefore)
  if (existsSync(DEBUG)) truncateSync(DEBUG, debugSizeBefore)
} catch {
  /* 截不回去也不影响结论 */
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
