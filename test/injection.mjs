/**
 * 注入过滤的回归测试（T24–T29）。
 *
 *   node --test test/injection.mjs
 *
 * 主题单一：宿主注入事件不能作为「用户原话」进入检索结果或提炼素材。
 * 与 test/history.mjs 分开，是为了不往那份 35 条的验收用例里塞新主题，
 * 也避免一改过滤逻辑就牵动已验收的断言。
 *
 * 暗号约定（v2，复审要求）：不用 turn / 2026 这类普通词当零命中依据 ——
 * 普通词本来就可能搜不到，零命中证明不了任何事。全部用专门构造、在本文件中
 * 唯一的四字暗号：
 *   紫电鸮鸣 = 只出现在被过滤的注入正文里，任何查询都必须 0 命中
 *   蓝鲸回声 = 只出现在应保留的真实消息里，必须命中
 *   橙花回声 = 只出现在「未知来源」的应保留消息里，必须命中
 *   灰鹭低语 = 只出现在 spliced 载体里被过滤的条目，必须 0 命中
 *   苍山墨玉 = goal 正文（查原话要 0 命中；取素材要保留）
 *   白鹿衔枝 = tool-goal 正文（同上）
 *   赤陶小印 = user-approval 正文（两条路都要 0 命中）
 *   青石苔痕 = repeat-tool-reminder 正文（两条路都要 0 命中）
 *   砂金耳坠 = tool-jobs 正文（两条路都要 0 命中）
 *
 * 零命中必须能被反证：每条「搜不到」的断言前面，先用 tokenize() 确认这个词
 * 切得出来。否则「切不出词」和「被过滤掉」在结果上一样，测试就成了摆设。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectRecords, gatherEvents } from '../gather.js'
import { makeHistoryTool } from '../history.js'
import { tokenize } from '../search.js'

/* ------------------------------------------------------------------ 夹具 */

const T0 = Date.UTC(2026, 9, 24, 9, 24, 0)
const at = (seq) => T0 + seq * 1000

const INJ = '紫电鸮鸣'
const REAL = '蓝鲸回声'
const FUTURE = '橙花回声'
const SPLICE = '灰鹭低语'
const GOAL = '苍山墨玉'
const TOOLGOAL = '白鹿衔枝'
const APPROVAL = '赤陶小印'
const REPEAT = '青石苔痕'
const JOBS = '砂金耳坠'

/** 真实用户消息：没有 source 字段（和真实数据里 kind:'user' 之外的普通情形一致）。 */
const user = (seq, text) => ({
  type: 'user/message',
  seq,
  time: at(seq),
  surfaceOp: 'append',
  data: { id: `u-${seq}`, content: [{ type: 'text', text }] },
})

/** 带来源标记的用户消息：模拟宿主注入插件追加的那一条。 */
const sourced = (seq, kind, text) => ({
  type: 'user/message',
  seq,
  time: at(seq),
  surfaceOp: 'append',
  data: { id: `h-${seq}`, content: [{ type: 'text', text }], source: { kind, form: 'snapshot' } },
})

const assistant = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: at(seq),
  surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

/** agent/inbox/spliced 载体：inserted[] 里可以带也可以不带 source。 */
const spliced = (seq, entries) => ({
  type: 'agent/inbox/spliced',
  seq,
  time: at(seq),
  data: {
    inserted: entries.map((e, i) => ({
      role: 'user',
      id: `i-${seq}-${i}`,
      content: [{ type: 'text', text: e.text }],
      ...(e.kind ? { source: { kind: e.kind } } : {}),
    })),
  },
})

function makeFakeQuery(sessions) {
  const state = sessions.map((s) => ({ ...s, events: [...s.events] }))
  return {
    async listSessions() {
      return state.map((s) => ({
        header: { id: s.id, createdAt: s.createdAt, version: 4, isSeeded: false, delegationDepth: 0 },
        live: Boolean(s.live),
        persisted: true,
      }))
    },
    async readSurface(id) {
      const s = state.find((x) => x.id === id)
      if (!s) {
        const err = new Error(`没有这场会话 ${id}`)
        err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw err
      }
      return {
        session: { id: s.id, createdAt: s.createdAt },
        inheritedEventCount: 0,
        capturedThroughSeq: s.events.length ? s.events.at(-1).seq : null,
        events: structuredClone(s.events),
      }
    },
  }
}

function makeTool(query) {
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      return name === 'sessionQuery' ? query : undefined
    },
  }
  return makeHistoryTool(ctx)
}

const run = (tool, args) => tool.execute(args, {})

/** 一条 user 记录里的正文，用于判断「保留的是哪一条」。 */
const recordTexts = (records) =>
  records
    .filter((r) => r.kind === 'user')
    .map((r) => (Array.isArray(r.content) ? r.content.map((c) => String(c.text ?? '')).join('') : ''))

/* ------------------------------------------------------------------ T24 */

test('T24 来源为 time-context 的事件整条不进索引，统计只记条数', async () => {
  const events = [user(1, `我要查的是${REAL}`), sourced(2, 'time-context', `${INJ} 时间快照正文`), assistant(3, '好')]

  // ① 记录层：只剩那一条真实消息
  const { records, stats } = collectRecords(events)
  assert.equal(records.filter((r) => r.kind === 'user').length, 1)
  assert.ok(recordTexts(records)[0].includes(REAL))

  // ② 统计：条数 +1、细分 +1、字符数不动
  assert.equal(stats.droppedSystemMsg, 1, '整条丢弃记进 droppedSystemMsg（条数）')
  assert.equal(stats.droppedBySource['time-context'], 1)
  assert.equal(stats.droppedInjection, 0, '按来源排除不产生字符剥离，不能混进字符计数')

  // ③ 检索层：注入暗号零命中，真实暗号命中
  const tool = makeTool(makeFakeQuery([{ id: 'session-aaaa1111', createdAt: new Date(T0).toISOString(), live: false, events }]))
  assert.equal((await run(tool, { query: INJ })).total_hits, 0, `注入暗号 ${INJ} 不该被搜到`)
  assert.equal((await run(tool, { query: REAL })).total_hits, 1, `真实暗号 ${REAL} 必须能搜到`)
})

/* ------------------------------------------------------------------ T25 */

test('T25 注入正文被完全改写时，仍按来源被过滤（不依赖文本特征）', async () => {
  // 正文里既没有 Time sampled，也没有任何已知前缀 —— 旧实现必然漏。
  const events = [
    user(1, `我要查的是${REAL}`),
    sourced(2, 'time-context', `这段是被改写的快照正文，${INJ}，换个说法也照样进来`),
  ]

  const { records, stats } = collectRecords(events)
  assert.equal(records.filter((r) => r.kind === 'user').length, 1, '只有真实那条留下')
  assert.equal(stats.droppedBySource['time-context'], 1)

  const tool = makeTool(makeFakeQuery([{ id: 'session-aaaa1111', createdAt: new Date(T0).toISOString(), live: false, events }]))
  assert.equal((await run(tool, { query: INJ })).total_hits, 0, '改写正文也不该漏网 —— 判据是来源不是文字')
})

/* ------------------------------------------------------------------ T26 */

test('T26 短消息、无 source、未知 kind 都不会被误删', async () => {
  const events = [
    user(1, '嗯'), // 短消息：只要求在记录层保留，不要求可检索（单字切不出 2-gram）
    user(2, `我要查的是${REAL}`), // 无 source
    sourced(3, 'some-future-kind', `${FUTURE} 将来才有的来源`), // 未知 kind
  ]

  const { records, stats } = collectRecords(events)
  assert.equal(records.filter((r) => r.kind === 'user').length, 3, '三条都必须留在记录层')
  assert.equal(stats.droppedSystemMsg, 0, '没有任何一条该被当成注入')
  assert.deepEqual(stats.droppedBySource, {}, '细分计数不该凭空出现')
  assert.ok(recordTexts(records).includes('嗯'), '短消息保留在记录层即可')

  // 可检索性用符合现有切词规则的独特内容来验，而不是拿「嗯」为难切词
  const tool = makeTool(makeFakeQuery([{ id: 'session-aaaa1111', createdAt: new Date(T0).toISOString(), live: false, events }]))
  assert.equal((await run(tool, { query: REAL })).total_hits, 1, '无 source 的消息必须可检索')
  assert.equal((await run(tool, { query: FUTURE })).total_hits, 1, '未知 kind 的消息必须可检索')
})

/* ------------------------------------------------------------------ T27 */

test('T27 runtime-context 不退化：标准正文与改写正文都按来源排除', async () => {
  const events = [
    user(1, `我要查的是${REAL}`),
    sourced(2, 'runtime-context', `Current runtime context. This snapshot supersedes earlier ones. ${INJ}`),
    // 旧实现靠 "Current runtime context." 这个前缀识别；换个措辞就漏了。
    sourced(3, 'runtime-context', `${INJ} 改写过的运行时上下文，没有那句前缀`),
  ]

  const { records, stats } = collectRecords(events)
  assert.equal(records.filter((r) => r.kind === 'user').length, 1)
  assert.equal(stats.droppedSystemMsg, 2, '两条都要计')
  assert.equal(stats.droppedBySource['runtime-context'], 2)
  assert.equal(stats.droppedInjection, 0, '按来源排除不产生字符剥离')

  const tool = makeTool(makeFakeQuery([{ id: 'session-aaaa1111', createdAt: new Date(T0).toISOString(), live: false, events }]))
  assert.equal((await run(tool, { query: INJ })).total_hits, 0)
})

/* ------------------------------------------------------------------ T28 */

test('T28 memory_gather 路径同样被保护：素材里不含注入正文', async () => {
  const events = [
    user(1, `我要查的是${REAL}`),
    sourced(2, 'time-context', `${INJ} 时间快照`),
    assistant(3, '我看到了'),
  ]

  const out = gatherEvents(events, { sessionId: 'session-aaaa1111', mode: 'full' })
  assert.equal(typeof out.markdown, 'string')
  assert.ok(!out.markdown.includes(INJ), '素材里不能出现注入暗号')
  assert.ok(out.markdown.includes(REAL), '真实内容必须留下')
  assert.equal(out.stats.droppedSystemMsg, 1, '统计与丢弃条数一致')
  assert.equal(out.stats.droppedBySource['time-context'], 1)
})

/* ------------------------------------------------------------------ T29 */

test('T29 spliced 载体：有来源才记账，没来源不臆测', async () => {
  const events = [
    spliced(4, [{ text: `${SPLICE} 收件箱里的注入副本`, kind: 'time-context' }]),
    spliced(5, [{ text: `收件箱里的真实发言 ${REAL}` }]), // 无 source
  ]

  const { records, stats } = collectRecords(events)
  assert.equal(records.filter((r) => r.kind === 'user').length, 1, '只有无来源那条留下')
  assert.ok(recordTexts(records)[0].includes(REAL))
  assert.equal(stats.droppedSystemMsg, 1)
  assert.equal(stats.droppedBySource['time-context'], 1, '有来源时细分也要记')
  assert.equal(
    Object.values(stats.droppedBySource).reduce((a, b) => a + b, 0),
    stats.droppedSystemMsg,
    '细分之和必须等于总数（两条载体口径一致）',
  )
})

/* ------------------------------------------------------------------ T30 */

test('T30 goal / tool-goal：查原话时排除，取素材时保留', async () => {
  const events = [
    user(1, `我要查的是${REAL}`),
    sourced(2, 'goal', `${GOAL} 这场的目标是把过滤口径拆开`),
    sourced(3, 'tool-goal', `${TOOLGOAL} 工具侧的目标说明`),
    assistant(4, '好'),
  ]

  // 反证前提：这两个词切得出来。否则「零命中」和「根本切不出词」结果一样，
  // 后面的断言就成了摆设。
  assert.ok(tokenize(GOAL).length > 0, `${GOAL} 必须能被切词`)
  assert.ok(tokenize(TOOLGOAL).length > 0, `${TOOLGOAL} 必须能被切词`)

  // ① 取素材：都留着 —— 删了提炼时就不知道这场在忙什么
  const material = collectRecords(events)
  assert.equal(material.records.filter((r) => r.kind === 'user').length, 3, 'gather 口径保留 goal / tool-goal')
  assert.equal(material.stats.droppedSystemMsg, 0, 'gather 口径不丢这两类')

  // ② 查原话：只留真实那条 —— 宿主替用户写的摘要不是用户说的话
  const dialog = collectRecords(events, { purpose: 'history' })
  assert.equal(dialog.records.filter((r) => r.kind === 'user').length, 1, 'history 口径只留真实那条')
  assert.equal(dialog.stats.droppedBySource.goal, 1, 'goal 要记账')
  assert.equal(dialog.stats.droppedBySource['tool-goal'], 1, 'tool-goal 要记账')

  // ③ 检索层：同一份事件，目标正文搜不到，真实内容搜得到
  const tool = makeTool(
    makeFakeQuery([{ id: 'session-aaaa1111', createdAt: new Date(T0).toISOString(), live: false, events }]),
  )
  assert.equal((await run(tool, { query: GOAL })).total_hits, 0, `${GOAL} 是宿主写的目标，不该被当原话搜到`)
  assert.equal((await run(tool, { query: TOOLGOAL })).total_hits, 0, `${TOOLGOAL} 同理`)
  assert.equal((await run(tool, { query: REAL })).total_hits, 1, '真实内容必须还能搜到')

  // ④ 素材层：目标正文确实留在素材里 —— 这是③零命中的对照，证明过滤按用途走
  const out = gatherEvents(events, { sessionId: 'session-aaaa1111', mode: 'full' })
  assert.ok(out.markdown.includes(GOAL), '素材里必须有目标正文')
  assert.ok(out.markdown.includes(TOOLGOAL), '素材里必须有工具目标正文')

  // ⑤ 反证：同样一段文字，只把来源换成 user，就该搜得到。这样③的零命中
  //    只能归因于来源标记，不能归因于文字本身（切不出词、覆盖度不够都不成立）。
  const control = [user(1, `我要查的是${REAL}`), user(2, `${GOAL} 同一段字，来源换成 user`)]
  const controlTool = makeTool(
    makeFakeQuery([{ id: 'session-bbbb2222', createdAt: new Date(T0).toISOString(), live: false, events: control }]),
  )
  assert.equal((await run(controlTool, { query: GOAL })).total_hits, 1, '同样的字换成 user 来源就该搜到')
})

/* ------------------------------------------------------------------ T31 */

test('T31 批准提示 / 重复提醒 / 后台通知：查原话时同样排除', async () => {
  const cases = [
    ['user-approval', APPROVAL],
    ['repeat-tool-reminder', REPEAT],
    ['tool-jobs', JOBS],
  ]
  const events = [user(1, `我要查的是${REAL}`)]
  cases.forEach(([kind, mark], i) => {
    events.push(sourced(i + 2, kind, `${mark} 宿主生成的提示正文`))
    assert.ok(tokenize(mark).length > 0, `${mark} 必须能被切词`)
  })

  const { records, stats } = collectRecords(events, { purpose: 'history' })
  assert.equal(records.filter((r) => r.kind === 'user').length, 1, '三类都不该留下')
  for (const [kind] of cases) assert.equal(stats.droppedBySource[kind], 1, `${kind} 要记账`)

  const tool = makeTool(
    makeFakeQuery([{ id: 'session-aaaa1111', createdAt: new Date(T0).toISOString(), live: false, events }]),
  )
  for (const [, mark] of cases) {
    assert.equal((await run(tool, { query: mark })).total_hits, 0, `${mark} 不该被当原话搜到`)
  }
})

/* ------------------------------------------------------------------ T32 */

test('T32 取素材时这三类也丢掉，但 goal 留下', async () => {
  const events = [
    user(1, `我要查的是${REAL}`),
    sourced(2, 'goal', `${GOAL} 这场的目标`),
    sourced(3, 'user-approval', `${APPROVAL} 批准提示`),
    sourced(4, 'repeat-tool-reminder', `${REPEAT} 重复调用提醒`),
    sourced(5, 'tool-jobs', `${JOBS} 后台任务完成`),
    sourced(6, 'some-future-kind', `${FUTURE} 名单外的来源`),
    assistant(7, '好'),
  ]

  const out = gatherEvents(events, { sessionId: 'session-aaaa1111', mode: 'full' })
  assert.ok(out.markdown.includes(GOAL), '目标正文要留')
  assert.ok(out.markdown.includes(FUTURE), '名单外的来源要留（宁可漏一次新注入，也不误删真话）')
  for (const mark of [APPROVAL, REPEAT, JOBS]) {
    assert.ok(!out.markdown.includes(mark), `${mark} 不该进素材`)
  }
  assert.equal(out.stats.droppedBySource['user-approval'], 1)
  assert.equal(out.stats.droppedBySource['repeat-tool-reminder'], 1)
  assert.equal(out.stats.droppedBySource['tool-jobs'], 1)
  // 统计必须透到渲染层：index.js 的 renderGather 靠这个字段提示「出现了名单外的来源」，
  // 透不出去，这套过滤就再也没有预警了。
  assert.equal(out.stats.unknownKinds['some-future-kind'], 1, '陌生来源要能从 gatherEvents 的 stats 里读到')
})

/* ------------------------------------------------------------------ T33 */

test('T33 两种口径都满足「细分之和 = 总数」，陌生来源留痕', async () => {
  const events = [
    user(1, `我要查的是${REAL}`),
    sourced(2, 'time-context', '时间快照'),
    sourced(3, 'goal', '这一场的目标'),
    sourced(4, 'user-approval', '批准提示'),
    sourced(5, 'some-future-kind', `${FUTURE} 还没见过的来源`),
  ]

  const counts = {}
  for (const purpose of ['gather', 'history']) {
    const { stats } = collectRecords(events, { purpose })
    const sum = Object.values(stats.droppedBySource).reduce((a, b) => a + b, 0)
    assert.equal(sum, stats.droppedSystemMsg, `${purpose}：细分之和必须等于总数`)
    assert.equal(stats.unknownKinds['some-future-kind'], 1, `${purpose}：陌生来源要被记下来，这是唯一的预警`)
    counts[purpose] = stats.droppedSystemMsg
  }
  // gather 拦 time-context + user-approval = 2；history 多拦一个 goal = 3
  assert.equal(counts.gather, 2, 'gather 只拦两类')
  assert.equal(counts.history, 3, 'history 多拦 goal')
})
