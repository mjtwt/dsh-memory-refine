/**
 * memory_history 单元测试 —— 不依赖真实会话数据。
 *
 *   node --test test/history.mjs
 *
 * 做法：注入一个假的 sessionQuery（listSessions / readSurface 都是假的，readSurface
 * 还带调用计数器），把 memory_history 当成一个普通对象直接 execute。这样缓存失效、
 * 配额、预算这些「不看真实数据就验不了」的地方全部可以断言，也不会因为真实会话
 * 被删而变红。
 *
 * 真实的 T1/T2（在真会话里查「内核」「workbuddy」）必须手工跑，见 README。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHistoryTool } from '../history.js'

/* ------------------------------------------------------------ 假事件构造 */

const T0 = Date.UTC(2026, 9, 24, 9, 24, 0)
const at = (seq) => T0 + seq * 1000

const user = (seq, text) => ({
  type: 'user/message',
  seq,
  time: at(seq),
  surfaceOp: 'append',
  data: { id: `u-${seq}`, content: [{ type: 'text', text }] },
})

const assistant = (seq, text, turn = 1) => ({
  type: 'assistant/message',
  seq,
  time: at(seq),
  surfaceOp: 'append',
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

const reasoningOnly = (seq) => ({
  type: 'assistant/message',
  seq,
  time: at(seq),
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'reasoning', text: '内核 内核 内核' }] },
  },
})

const toolCall = (seq, name) => ({
  type: 'tool/call',
  seq,
  time: at(seq),
  data: { name, callId: `c-${seq}`, arguments: '{}' },
})

const inboxSpliced = (seq, text) => ({
  type: 'agent/inbox/spliced',
  seq,
  time: at(seq),
  data: { inserted: [{ role: 'user', id: `i-${seq}`, content: [{ type: 'text', text }] }] },
})

/* ------------------------------------------------------------ 假 sessionQuery */

/**
 * sessions: [{ id, createdAt, live, events, fail? }]
 *   fail 非空时 readSurface 抛一个带 code 的错误（模拟 CORRUPT / NOT_FOUND）。
 */
function makeFakeQuery(sessions) {
  const state = sessions.map((s) => ({ ...s, events: [...s.events] }))
  const reads = new Map()

  const find = (id) => state.find((s) => s.id === id)

  return {
    state,
    reads,
    calls: (id) => reads.get(id) ?? 0,
    totalCalls: () => [...reads.values()].reduce((a, b) => a + b, 0),
    /** 给某场会话追加事件，模拟「活跃会话又说了新话」。 */
    push(id, ...events) {
      find(id).events.push(...events)
    },
    async listSessions() {
      return state.map((s) => ({
        header: { id: s.id, createdAt: s.createdAt, version: 4, isSeeded: false, delegationDepth: 0 },
        live: Boolean(s.live),
        persisted: true,
      }))
    },
    async readSurface(id) {
      reads.set(id, (reads.get(id) ?? 0) + 1)
      const s = find(id)
      if (!s) {
        const err = new Error(`fatal: 没有这场会话 ${id}`)
        err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw err
      }
      if (s.fail) {
        const err = new Error(`fatal: ${s.fail}`)
        err.code = s.fail
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
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      return name === 'sessionQuery' ? query : undefined
    },
  }
  return { tool: makeHistoryTool(ctx), effects }
}

const run = (tool, args, exec = {}) => tool.execute(args, exec)

/** 返回正文总码点数：只算原文，不含标题与统计——与 max_chars 的口径一致。 */
function bodyChars(value) {
  let n = 0
  for (const hit of value.hits) {
    n += Array.from(hit.text).length
    for (const c of [...(hit.context_before ?? []), ...(hit.context_after ?? [])]) {
      n += Array.from(c.text).length
    }
  }
  return n
}

/* ------------------------------------------------------------ 基础语料 */

function baseSessions() {
  return [
    {
      id: 'session-aaaa1111',
      createdAt: '2026-10-24T09:24:00.000Z',
      live: false,
      events: [
        user(1, '为什么这些人就是看不懂内核的意思'),
        assistant(2, '我说的是内核本身，不是表层的意思。'),
        user(3, '那就换个说法'),
        assistant(4, '好，换个说法。'),
      ],
    },
    {
      id: 'session-bbbb2222',
      createdAt: '2026-10-17T12:28:00.000Z',
      live: false,
      events: [user(1, 'workbuddy 这次更新把侧边栏改坏了'), assistant(2, '那是 workbuddy 的缓存问题。')],
    },
  ]
}

/* ------------------------------------------------------------------ T3 */

test('T3 查不到就返回空 + 说清楚，不拿相近结果凑数', async () => {
  const { tool } = makeTool(makeFakeQuery(baseSessions()))
  const r = await run(tool, { query: 'zzzqqq' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.hits, [])
  assert.equal(r.total_hits, 0)
  assert.equal(r.returned, 0)
  assert.match(r.note, /没有命中/)
})

/* ------------------------------------------------------------------ T4 */

test('T4 session_id 限定只扫那一场', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  const r = await run(tool, { query: '内核', session_id: 'session-aaaa1111' })
  assert.equal(r.stats.sessions_scanned, 1)
  assert.ok(r.hits.length >= 1)
  assert.ok(r.hits.every((h) => h.session_id === 'session-aaaa1111'))
  assert.equal(query.calls('session-bbbb2222'), 0, '不该去读没被点名的会话')
})

test('T4b session_id 不存在 → skipped not_found，不抛异常', async () => {
  const { tool } = makeTool(makeFakeQuery(baseSessions()))
  const r = await run(tool, { query: '内核', session_id: 'session-nope' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.hits, [])
  assert.deepEqual(r.skipped, [{ session_id: 'session-nope', reason: 'not_found' }])
})

/* ------------------------------------------------------------------ T5 */

test('T5 context 带相邻上下文，只含 user/assistant，各不超过 context 条', async () => {
  const sessions = [
    {
      id: 'session-ctx0001',
      createdAt: '2026-10-20T00:00:00.000Z',
      live: false,
      events: [
        user(1, '第一句话说别的'),
        assistant(2, '第一句的回答'),
        user(3, '中间这条提到内核'),
        assistant(4, '内核这块我说两句'),
        user(5, '后面又聊别的'),
        assistant(6, '后面这句也是别的'),
      ],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核', context: 2 })
  assert.ok(r.hits.length >= 1)
  for (const hit of r.hits) {
    assert.ok(Array.isArray(hit.context_before))
    assert.ok(Array.isArray(hit.context_after))
    assert.ok(hit.context_before.length <= 2, `before ${hit.context_before.length}`)
    assert.ok(hit.context_after.length <= 2, `after ${hit.context_after.length}`)
    for (const c of [...hit.context_before, ...hit.context_after]) {
      assert.ok(['user', 'assistant'].includes(c.role))
      assert.ok(typeof c.seq === 'number')
    }
    // 上下文必须按 seq 时间正序，且不与命中自身重叠
    const before = hit.context_before.map((c) => c.seq)
    assert.deepEqual(before, [...before].sort((a, b) => a - b))
    assert.ok(hit.context_before.every((c) => c.seq < hit.seq))
    assert.ok(hit.context_after.every((c) => c.seq > hit.seq))
  }
})

test('T5b context=0 时不带上下文字段', async () => {
  const { tool } = makeTool(makeFakeQuery(baseSessions()))
  const r = await run(tool, { query: '内核' })
  for (const hit of r.hits) {
    assert.equal(hit.context_before, undefined)
    assert.equal(hit.context_after, undefined)
  }
})

/* ------------------------------------------------------------------ T6 */

test('T6 单条截到 200 码点，总正文不超 max_chars', async () => {
  const long = '内核'.repeat(300) // 600 码点
  const sessions = [
    {
      id: 'session-long001',
      createdAt: '2026-10-21T00:00:00.000Z',
      live: false,
      events: [user(1, long), user(3, `另一条也提内核 ${'填充'.repeat(300)}`)],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))

  const wide = await run(tool, { query: '内核', max_chars: 4000 })
  assert.equal(wide.hits.length, 2)
  assert.equal(Array.from(wide.hits[0].text).length, 200)
  assert.equal(wide.hits[0].truncated, true)

  const tight = await run(tool, { query: '内核', max_chars: 250 })
  assert.ok(bodyChars(tight) <= 250, `正文 ${bodyChars(tight)} 字 > 250`)
  assert.ok(tight.hits.length >= 1)
  assert.equal(tight.total_hits, wide.total_hits, 'total_hits 不受预算截断影响')
})

test('T6b 预算紧张时优先 hits，其次 context_before，最后 context_after', async () => {
  const sessions = [
    {
      id: 'session-budget1',
      createdAt: '2026-10-22T00:00:00.000Z',
      live: false,
      events: [
        user(1, `上文一 ${'甲'.repeat(110)}`),
        assistant(2, `上文二 ${'乙'.repeat(110)}`),
        user(3, `内核在这里 ${'丙'.repeat(180)}`),
        assistant(4, `下文一 ${'丁'.repeat(110)}`),
      ],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核', context: 2, max_chars: 400 })
  assert.ok(bodyChars(r) <= 400, `正文 ${bodyChars(r)} 字 > 400`)
  const hit = r.hits[0]
  assert.ok(hit, '命中本身必须留得下')
  if ((hit.context_after ?? []).length) {
    assert.ok((hit.context_before ?? []).length > 0, '既然给得下下文，上文就不能是空的')
  }
})

test('T6c 空查询：空串 / 纯空白 / 切不出词 都有明确处理', async () => {
  const { tool } = makeTool(makeFakeQuery(baseSessions()))
  for (const bad of ['', '   ', '\n\t ']) {
    const r = await run(tool, { query: bad })
    assert.equal(r.ok, false)
    assert.match(r.error, /query 不能为空/)
  }
  // 有字但一个字都切不出来：不报错，也不扫会话，明确说是分词问题
  for (const blank of ['的', '12']) {
    const r = await run(tool, { query: blank })
    assert.equal(r.ok, true)
    assert.deepEqual(r.hits, [])
    assert.match(r.note, /没有可检索的词/)
    assert.equal(r.stats.sessions_listed, 0, '切不出词就不该白跑 listSessions')
  }
})

/* ------------------------------------------------------------------ T7 */

test('T7 同 query 连查两次：第二次全走缓存', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  const first = await run(tool, { query: '内核' })
  assert.equal(first.stats.sessions_from_cache, 0)
  assert.equal(first.stats.sessions_scanned, 2)
  assert.equal(query.totalCalls(), 2)

  const second = await run(tool, { query: '内核' })
  assert.equal(second.stats.sessions_from_cache, 2)
  assert.equal(second.stats.sessions_scanned, 0)
  assert.equal(query.totalCalls(), 2, '非活跃会话第二次不该再读')
  assert.equal(second.total_hits, first.total_hits)
  // 不断言 elapsed_ms 一定更小：这是微秒级操作，计时抖动比差值大。
  // 不变的是「少读了 2 场全量读盘」，那才是缓存省下来的东西。
})

/* ------------------------------------------------------------------ T8 */

test('T8 sessionQuery 不可用 → ok:false + 文案，不抛异常', async () => {
  const ctx = {
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    get: () => undefined,
  }
  const tool = makeHistoryTool(ctx)
  await assert.doesNotReject(async () => {
    const r = await run(tool, { query: '内核' })
    assert.equal(r.ok, false)
    assert.match(r.error, /sessionQuery/)
  })
})

test('T8b 只有 readSession 没有 readSurface 也算不可用', async () => {
  const { tool } = makeTool({ listSessions: async () => [], readSession: async () => ({}) })
  const r = await run(tool, { query: '内核' })
  assert.equal(r.ok, false)
  assert.match(r.error, /sessionQuery/)
})

/* ------------------------------------------------------------------ T9 */

test('T9 单场读取失败进 skipped，其余照常返回', async () => {
  const sessions = baseSessions()
  sessions[1].fail = 'SESSION_QUERY_CORRUPT_SESSION'
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核' })
  assert.equal(r.ok, true)
  assert.equal(r.stats.sessions_failed, 1)
  assert.deepEqual(r.skipped, [
    { session_id: 'session-bbbb2222', reason: 'error:SESSION_QUERY_CORRUPT_SESSION' },
  ])
  assert.ok(r.hits.length >= 1, '另一场仍然要出结果')
  assert.match(r.note, /部分的/)
})

test('T9b 读失败但有旧缓存时用旧内容顶上，统计不重复计数', async () => {
  const sessions = baseSessions()
  // 必须是活跃会话：非活跃会话有缓存时压根不会去读，也就不会有「读失败」。
  sessions[1].live = true
  const query = makeFakeQuery(sessions)
  const { tool } = makeTool(query)

  await run(tool, { query: 'workbuddy' }) // 先把两场都装进缓存
  query.state[1].fail = 'SESSION_QUERY_CORRUPT_SESSION'

  const r = await run(tool, { query: 'workbuddy' })
  assert.equal(r.ok, true)
  assert.equal(r.stats.sessions_failed, 1)
  assert.equal(r.stats.sessions_from_cache, 1, '失败的那场不算 from_cache，否则三个数加起来超了')
  assert.equal(
    r.stats.sessions_scanned + r.stats.sessions_from_cache + r.stats.sessions_failed,
    2,
    '扫描 / 缓存 / 失败三类必须正好等于参与场数',
  )
  assert.ok(r.hits.length >= 1, '旧缓存里的内容仍然参与检索')
  assert.ok(r.hits.every((h) => h.session_id === 'session-bbbb2222'))
})

/* ------------------------------------------------------------------ T10 */

test('T10 tool/call 与 agent/inbox/spliced 都不进 hits', async () => {
  const sessions = [
    {
      id: 'session-noise01',
      createdAt: '2026-10-23T00:00:00.000Z',
      live: false,
      events: [
        toolCall(1, '内核搜索工具'),
        inboxSpliced(2, '内核 这条来自待消费收件箱'),
        user(3, '真正的原话里有内核'),
        assistant(4, '好，收到。'),
      ],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核' })
  assert.ok(r.hits.length >= 1)
  assert.equal(r.hits.length, 1, '只该有真正的 user/message 那一条')
  assert.ok(!r.hits.some((h) => h.text.includes('待消费收件箱')))
  assert.ok(!r.hits.some((h) => h.text.includes('搜索工具')))
})

/* ------------------------------------------------------------------ T11 */

test('T11 整条都是 <system-reminder> 的用户消息被丢弃', async () => {
  const sessions = [
    {
      id: 'session-inject',
      createdAt: '2026-10-23T01:00:00.000Z',
      live: false,
      events: [
        user(1, '<system-reminder>内核 更新了 AGENTS.md</system-reminder>'),
        user(2, '内核 这句才是他说的'),
      ],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核' })
  assert.equal(r.hits.length, 1)
  assert.ok(!r.hits[0].text.includes('system-reminder'))
  assert.ok(!r.hits[0].text.includes('AGENTS.md'))
})

test('T11b 消息里夹着注入时只剥掉注入，原话保留', async () => {
  const sessions = [
    {
      id: 'session-inject2',
      createdAt: '2026-10-23T02:00:00.000Z',
      live: false,
      events: [user(1, '内核 这句是原话<system-reminder>这段是注入</system-reminder>')],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核' })
  assert.equal(r.hits.length, 1)
  assert.ok(r.hits[0].text.includes('这句是原话'))
  assert.ok(!r.hits[0].text.includes('这段是注入'))
})

/* ------------------------------------------------------------------ T12 */

test('T12 只有 reasoning 的 assistant 消息被丢弃', async () => {
  const sessions = [
    {
      id: 'session-reason',
      createdAt: '2026-10-23T03:00:00.000Z',
      live: false,
      events: [reasoningOnly(1), user(2, '内核 这句是用户说的')],
    },
  ]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核' })
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].role, 'user')
})

/* ------------------------------------------------------------------ T13 */

test('T13 每场会话最多 2 条，哪怕分都很接近', async () => {
  const mk = (id, prefix) => ({
    id,
    createdAt: '2026-10-19T00:00:00.000Z',
    live: false,
    events: [1, 2, 3].map((i) => user(i, `${prefix} 内核 第${i}条 说的是同一件事`)),
  })
  const sessions = [mk('session-cap0001', '甲'), mk('session-cap0002', '乙'), mk('session-cap0003', '丙')]
  const { tool } = makeTool(makeFakeQuery(sessions))
  const r = await run(tool, { query: '内核', limit: 10 })
  const per = new Map()
  for (const hit of r.hits) per.set(hit.session_id, (per.get(hit.session_id) ?? 0) + 1)
  for (const [id, n] of per) assert.ok(n <= 2, `${id} 出了 ${n} 条`)
  assert.equal(r.total_hits, 6, '过滤后总数是 3 场 × 2 条')
})

test('T13b limit 上限 10，超出被夹住', async () => {
  const { tool } = makeTool(makeFakeQuery(baseSessions()))
  const r = await run(tool, { query: '内核', limit: 999 })
  assert.ok(r.hits.length <= 10)
})

/* ------------------------------------------------------------------ T14 */

test('T14 非活跃会话第二次查询不调 readSurface', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  await run(tool, { query: '内核' })
  const before = query.calls('session-aaaa1111')
  assert.equal(before, 1)

  const r = await run(tool, { query: '内核' })
  assert.equal(query.calls('session-aaaa1111'), before, 'readSurface 调用次数必须为 0 增长')
  assert.equal(r.stats.sessions_from_cache, 2)
  assert.ok(r.stats.sessions_from_cache > 0)
})

/* ------------------------------------------------------------------ T15 */

test('T15 refresh:<id> 只重建这一场，并能检索到新加的内容', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  await run(tool, { query: '内核' })
  assert.equal(query.calls('session-aaaa1111'), 1)

  // 旧会话被重新启用、追加了新内容（createdAt 不变，只有 refresh 能发现）
  query.push('session-aaaa1111', user(5, '后来又说到了银色长笛这个暗号'))

  const stale = await run(tool, { query: '银色长笛' })
  assert.equal(stale.total_hits, 0, '不刷新就该看不到新内容——这是使用约定的代价')

  const r = await run(tool, { query: '银色长笛', refresh: 'session-aaaa1111' })
  assert.deepEqual(r.stats.refreshed, ['session-aaaa1111'])
  assert.equal(query.calls('session-aaaa1111'), 2, '被点名的那场要重读一次')
  assert.equal(r.total_hits, 1)
  assert.ok(r.hits[0].text.includes('银色长笛'))
})

/* ------------------------------------------------------------------ T16 */

test('T16 refresh:all 清空缓存后全部重读，sessions_from_cache 为 0', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  await run(tool, { query: '内核' })
  assert.equal(query.totalCalls(), 2)

  const r = await run(tool, { query: '内核', refresh: 'all' })
  assert.deepEqual(r.stats.refreshed, ['all'])
  assert.equal(r.stats.sessions_from_cache, 0)
  assert.equal(r.stats.sessions_scanned, 2)
  assert.equal(query.totalCalls(), 4, '两场都重新读了')
})

test('T16b refresh:all 仍受 scan_limit 约束（只清缓存，不扩大扫描范围）', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  await run(tool, { query: '内核' })
  assert.equal(query.totalCalls(), 2)

  const r = await run(tool, { query: '内核', refresh: 'all', scan_limit: 1 })
  assert.deepEqual(r.stats.refreshed, ['all'])
  assert.equal(r.stats.sessions_from_cache, 0, '缓存已清空，不可能有命中')
  assert.equal(r.stats.sessions_scanned, 1, 'scan_limit 是硬上限，refresh 不突破它')
  assert.equal(query.totalCalls(), 3, '只多读了被扫到的那一场')
  assert.match(r.note, /本次实际重建 1 场/)
})

/* ------------------------------------------------------------------ T17 */

test('T17 refresh 指向不存在的 id：不抛异常，进 skipped', async () => {
  const { tool } = makeTool(makeFakeQuery(baseSessions()))
  const r = await run(tool, { query: '内核', refresh: 'session-ghost' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.stats.refreshed, ['session-ghost'])
  assert.deepEqual(r.skipped, [{ session_id: 'session-ghost', reason: 'not_found' }])
  assert.ok(r.hits.length >= 1, '其余会话照常出结果')
})

/* ------------------------------------------------------------------ T18 */

test('T18 活跃会话新增消息后，缓存会重建（新话能被检索到）', async () => {
  const sessions = baseSessions()
  sessions[0].live = true
  const query = makeFakeQuery(sessions)
  const { tool } = makeTool(query)

  const first = await run(tool, { query: '内核' })
  assert.equal(first.stats.sessions_scanned, 2)
  assert.equal(query.calls('session-aaaa1111'), 1)
  const readsAfterFirst = query.calls('session-aaaa1111')

  // 换一个词查一次：活跃会话会被重读一次（这是设计），但还查不到新话
  const stale = await run(tool, { query: '银色长笛' })
  assert.equal(stale.total_hits, 0)
  assert.equal(query.calls('session-aaaa1111'), readsAfterFirst + 1)

  // 同一场仍然活跃，又说了新话：capturedThroughSeq 随之变大
  query.push('session-aaaa1111', user(5, '刚才漏了一句：银色长笛'))
  const before = query.calls('session-aaaa1111')

  const r = await run(tool, { query: '银色长笛' })
  assert.equal(query.calls('session-aaaa1111'), before + 1, '活跃会话每次都要重读并核对版本号')
  assert.equal(r.stats.sessions_scanned, 1, '只有活跃的那场被重读')
  assert.equal(r.stats.sessions_from_cache, 1, '非活跃的那场照常走缓存')
  assert.equal(r.total_hits, 1, '新加的消息必须能被检索到（说明索引重建了）')
  assert.ok(r.hits[0].text.includes('银色长笛'))

  // 再查一次仍然能查到：重建后的索引已经落到缓存里，不是每次都在现算
  const again = await run(tool, { query: '银色长笛' })
  assert.equal(again.total_hits, 1)
  assert.equal(query.calls('session-aaaa1111'), before + 2, '活跃会话每次仍要核对一次版本号')
})

test('T18b 活跃会话没有新增时也照常工作（重读但不该丢内容）', async () => {
  const sessions = baseSessions()
  sessions[0].live = true
  const query = makeFakeQuery(sessions)
  const { tool } = makeTool(query)
  const first = await run(tool, { query: '内核' })
  const second = await run(tool, { query: '内核' })
  assert.equal(query.calls('session-aaaa1111'), 2, '活跃会话每次都读，这是设计')
  assert.deepEqual(
    second.hits.map((h) => [h.session_id, h.seq]),
    first.hits.map((h) => [h.session_id, h.seq]),
    '内容没变，结果就该一模一样',
  )
})

/* ------------------------------------------------------------------ 其他 */

test('会话被删掉后缓存条目会被清掉', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  await run(tool, { query: '内核' })
  query.state.splice(1, 1) // session-bbbb2222 没了
  const r = await run(tool, { query: '内核' })
  assert.equal(r.stats.sessions_listed, 1)
  assert.ok(r.hits.every((h) => h.session_id !== 'session-bbbb2222'))
})

test('命中的 seq 是原始事件 seq，可以直接喂给 readEvent', async () => {
  const query = makeFakeQuery(baseSessions())
  const { tool } = makeTool(query)
  const r = await run(tool, { query: '内核' })
  for (const hit of r.hits) {
    const s = query.state.find((x) => x.id === hit.session_id)
    const ev = s.events.find((e) => e.seq === hit.seq)
    assert.ok(ev, `seq ${hit.seq} 必须对应一条真实事件`)
    assert.equal(ev.type, hit.role === 'user' ? 'user/message' : 'assistant/message')
  }
})

test('注册了缓存清理 effect', async () => {
  const { effects } = makeTool(makeFakeQuery(baseSessions()))
  assert.ok(effects.includes('memory-refine: history cache'))
})

/* ------------------------------------------------------------------ T19 */

/** 一次带调用方身份的调用：运行时保证 agent.id === agent.session.id，两种写法都认。 */
const asSession = (id) => ({ agent: { id, session: { id } } })

/** 当前会话（live，含自指噪音）+ 一场历史，两场都含「内核」。 */
function selfNoiseSessions() {
  return [
    {
      id: 'session-current',
      createdAt: '2026-10-26T12:00:00.000Z',
      live: true,
      events: [user(1, '用 memory_history 查一下内核'), assistant(2, '好，我去查内核。')],
    },
    {
      id: 'session-old',
      createdAt: '2026-10-24T09:24:00.000Z',
      live: false,
      events: [user(1, '为什么这些人就是看不懂真正的内核呢'), assistant(2, '因为他们只看表层。')],
    },
  ]
}

test('T19 不带 session_id 时排除调用方自己的会话，统计记 1', async () => {
  const { tool } = makeTool(makeFakeQuery(selfNoiseSessions()))
  const value = await run(tool, { query: '内核' }, asSession('session-current'))
  assert.equal(value.ok, true)
  assert.deepEqual([...new Set(value.hits.map((h) => h.session_id))], ['session-old'])
  assert.equal(value.stats.sessions_excluded_self, 1)
  // 排除只发生在结果阶段：两场都照常参与扫描
  assert.equal(value.stats.sessions_scanned, 2)
  // 当前会话原本有 user + assistant 两条命中，被排除后只剩历史那条
  assert.equal(value.total_hits, 1)
})

test('T19b 当前会话没有命中时统计仍是 1（不随关键词波动）', async () => {
  const { tool } = makeTool(makeFakeQuery(selfNoiseSessions()))
  const value = await run(tool, { query: '表层' }, asSession('session-current'))
  // 「表层」只出现在历史会话里，当前会话一条都没命中——但排除规则确实生效了
  assert.equal(value.stats.sessions_excluded_self, 1)
  assert.equal(value.hits.every((h) => h.session_id !== 'session-current'), true)
})

test('T20 显式传自己的 session_id 时放行（与官方 targetId 一致）', async () => {
  const { tool } = makeTool(makeFakeQuery(selfNoiseSessions()))
  const value = await run(tool, { query: '内核', session_id: 'session-current' }, asSession('session-current'))
  assert.equal(value.ok, true)
  assert.deepEqual([...new Set(value.hits.map((h) => h.session_id))], ['session-current'])
  assert.equal(value.stats.sessions_excluded_self, 0)
})

test('T21 认不出调用方（exec 里没有 agent）时不排除，行为与旧版一致', async () => {
  const { tool } = makeTool(makeFakeQuery(selfNoiseSessions()))
  const value = await run(tool, { query: '内核' })
  assert.equal(value.stats.sessions_excluded_self, 0)
  const ids = new Set(value.hits.map((h) => h.session_id))
  assert.equal(ids.has('session-current'), true)
  assert.equal(ids.has('session-old'), true)
})

test('T22 refresh 与排除共存：缓存照清、统计照记', async () => {
  const query = makeFakeQuery(selfNoiseSessions())
  const { tool } = makeTool(query)
  const exec = asSession('session-current')

  await run(tool, { query: '内核' }, exec)
  const before = query.totalCalls()
  const value = await run(tool, { query: '内核', refresh: 'all' }, exec)

  assert.deepEqual(value.stats.refreshed, ['all'])
  assert.equal(value.stats.sessions_from_cache, 0)
  assert.equal(value.stats.sessions_excluded_self, 1)
  assert.equal(query.totalCalls() > before, true, 'refresh 之后必须真的重读')
})

test('T23 排除当前会话不影响召回与原文：历史仍命中、一字不差、缓存统计不变', async () => {
  const query = makeFakeQuery(selfNoiseSessions())
  const { tool } = makeTool(query)
  const exec = asSession('session-current')

  const first = await run(tool, { query: '内核' }, exec)
  const old = first.hits.filter((h) => h.session_id === 'session-old')
  assert.equal(old.length, 1, '历史那条必须还在——排名提前不能拿召回换')
  assert.equal(old[0].text, '为什么这些人就是看不懂真正的内核呢', '原文必须一字不差')
  assert.equal(
    first.stats.sessions_scanned + first.stats.sessions_from_cache + first.stats.sessions_failed,
    2,
    '统计自洽：三者之和 = 参与场数',
  )

  const second = await run(tool, { query: '内核' }, exec)
  assert.equal(second.hits[0].text, old[0].text, '第二次原文不变')
  // 排除不碰缓存：非活跃那场照常复用，live 那场照常重读（规则 1 不受影响）
  assert.equal(second.stats.sessions_scanned, 1)
  assert.equal(second.stats.sessions_from_cache, 1)
  assert.equal(
    second.stats.sessions_scanned + second.stats.sessions_from_cache + second.stats.sessions_failed,
    2,
  )
  assert.equal(second.stats.sessions_excluded_self, 1)
})
