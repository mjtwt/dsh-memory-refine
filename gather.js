/**
 * Session events -> refinement material.
 *
 * Pure functions only. This module never touches the filesystem, never opens a
 * session store, and never writes memory: it takes the event array that the
 * host hands it (ctx.sessionQuery) and returns text plus bookkeeping numbers.
 *
 * Staying pure is what makes it verifiable. The same array can be replayed from
 * a dumped session log in a sandbox, so a change here can be checked without
 * restarting the app — which matters, because a plugin code change only takes
 * effect after a full restart.
 *
 * No concrete user file name ever appears in here: a session id and a generic
 * source label are passed in, nothing is assumed.
 */

const pad2 = (n) => String(n).padStart(2, '0')

export function dayKey(time) {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function hhmmss(time) {
  return new Date(time).toTimeString().slice(0, 8)
}

export function hhmm(time) {
  return new Date(time).toTimeString().slice(0, 5).replace(':', '')
}

export function shortSessionId(sessionId) {
  const raw = String(sessionId ?? '').replace(/^session-/, '')
  return (raw.split('-')[0] || 'x').slice(0, 8)
}

/* --------------------------------------------------------------- injection */

/**
 * A user/message event can carry engine-injected text (the prompt-injection
 * file, a runtime snapshot) alongside what the human actually typed. That text
 * is not something the user said and must never end up in the material.
 */
export function stripInjection(text) {
  if (!text) return { text: '', dropped: 0 }
  let t = text
  let dropped = 0
  for (;;) {
    const start = t.indexOf('<system-reminder>')
    if (start < 0) break
    const endTag = '</system-reminder>'
    const end = t.indexOf(endTag, start)
    const cutEnd = end < 0 ? t.length : end + endTag.length
    dropped += cutEnd - start
    t = t.slice(0, start) + t.slice(cutEnd)
  }
  // A bare runtime snapshot block: no tags, recognised by its opening line.
  const rt = t.indexOf('Current runtime context.')
  if (rt >= 0) {
    dropped += t.length - rt
    t = t.slice(0, rt)
  }
  return { text: t.trim(), dropped }
}

/**
 * Clean one user content array: engine-injected text is stripped from its text
 * parts, and a message that turns out to be nothing but injection is dropped
 * entirely. Returns null when the human said nothing here.
 *
 * Both carriers of a user message run through this — `user/message` and the
 * `agent/inbox/spliced` fallback — because skipping it on either one lets an
 * AGENTS.md update notice land in the material as if the user had typed it.
 */
function cleanUserContent(content, stats) {
  if (!Array.isArray(content) || content.length === 0) {
    stats.droppedSystemMsg++
    return null
  }
  const cleaned = []
  let onlyInjection = true
  for (const c of content) {
    if (c?.type !== 'text') {
      cleaned.push(c)
      onlyInjection = false
      continue
    }
    const { text, dropped } = stripInjection(String(c.text ?? ''))
    stats.droppedInjection += dropped
    if (text) {
      cleaned.push({ ...c, text })
      onlyInjection = false
    }
  }
  if (onlyInjection || cleaned.length === 0) {
    stats.droppedSystemMsg++
    return null
  }
  return cleaned
}

/* --------------------------------------------------------------- watermark */

const WATERMARK_NAME = 'memory-refine:watermark'
const WATERMARK_RE = /<!--\s*memory-refine:watermark\s+([^>]*?)-->/g

/**
 * The marker a memory_gather result carries. It records how far the material
 * actually reached, which is the only durable place a watermark needs to live:
 * the session log already stores every tool result, so there is no state file
 * to grow without bound and nothing to keep in sync.
 */
export function formatWatermark({ session, seq, time, turns }) {
  return `<!--${WATERMARK_NAME} session=${session} seq=${seq} time=${time} turns=${turns}-->`
}

export function parseWatermark(text) {
  if (typeof text !== 'string' || text === '') return null
  const re = new RegExp(WATERMARK_RE.source, 'g')
  let last = null
  let m
  while ((m = re.exec(text)) !== null) {
    const attrs = {}
    for (const chunk of m[1].trim().split(/\s+/)) {
      const i = chunk.indexOf('=')
      if (i > 0) attrs[chunk.slice(0, i)] = chunk.slice(i + 1)
    }
    last = {
      session: attrs.session ?? '',
      seq: Number(attrs.seq ?? 0) || 0,
      time: Number(attrs.time ?? 0) || 0,
      turns: Number(attrs.turns ?? 0) || 0,
    }
  }
  return last
}

export function eventText(event) {
  const parts = []
  const msg = event?.data?.message
  const blocks = Array.isArray(msg?.content) ? msg.content : []
  for (const c of blocks) if (c?.type === 'text') parts.push(String(c.text ?? ''))
  return parts.join('\n')
}

/**
 * Find the watermark left by the previous gather run, read straight out of the
 * session log. Returns null when this session has never been gathered, which
 * means "no boundary yet: show everything".
 */
export function deriveWatermark(events, options = {}) {
  const wantSession = options.sessionId ? String(options.sessionId) : ''
  const byCallId = new Map()
  for (const e of events) {
    if (e?.type === 'tool/call' && e.data?.callId) byCallId.set(String(e.data.callId), String(e.data.name ?? ''))
  }

  let best = null
  for (const e of events) {
    if (e?.type !== 'tool/result') continue
    const msg = e.data?.message ?? {}
    const callId = String(msg.toolCallId ?? e.data?.toolCallId ?? '')
    const name = byCallId.get(callId) ?? ''
    if (name !== 'memory_gather') continue
    const wm = parseWatermark(eventText(e))
    if (!wm) continue
    if (wantSession && wm.session && wm.session !== wantSession) continue
    if (!best || wm.seq >= best.seq) best = wm
  }
  return best
}

/* ----------------------------------------------------------------- records */

export function collectRecords(events) {
  const stats = {
    droppedInjection: 0,
    droppedSystemMsg: 0,
    emptyAssistant: 0,
    reasoningChars: 0,
    myTurns: 0,
    replacedSurface: 0,
    toolCalls: 0,
  }
  const records = []

  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue
    if (e.surfaceOp && typeof e.surfaceOp === 'object') stats.replacedSurface++

    if (e.type === 'user/message') {
      const cleaned = cleanUserContent(e.data?.content, stats)
      if (cleaned) {
        records.push({ kind: 'user', time: e.time, seq: e.seq, content: cleaned, id: e.data?.id })
      }
    } else if (e.type === 'assistant/message') {
      records.push({
        kind: 'assistant',
        time: e.time,
        seq: e.seq,
        turn: e.data?.turn,
        step: e.data?.step,
        msg: e.data?.message,
        usage: e.data?.usage,
      })
    } else if (e.type === 'tool/call') {
      stats.toolCalls++
      records.push({
        kind: 'call',
        time: e.time,
        seq: e.seq,
        name: e.data?.name,
        callId: e.data?.callId,
        args: e.data?.arguments,
      })
    } else if (e.type === 'tool/result') {
      const m = e.data?.message ?? {}
      records.push({
        kind: 'result',
        time: e.time,
        seq: e.seq,
        callId: m.toolCallId ?? e.data?.toolCallId,
        isError: Boolean(e.data?.error) || Boolean(e.data?.isError) || Boolean(m.isError),
        text: eventText(e),
        meta: e.data?.meta,
      })
    } else if (e.type === 'agent/inbox/spliced') {
      // Only a fallback for when no user/message event was recorded.
      for (const ins of e.data?.inserted ?? []) {
        if (ins?.role !== 'user') continue
        const cleaned = cleanUserContent(ins.content, stats)
        if (!cleaned) continue
        records.push({ kind: 'user', time: e.time, seq: e.seq, content: cleaned, id: ins.id, viaSplice: true })
      }
    }
  }

  records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return { records: dedupe(records), stats }
}

function dedupe(records) {
  const seen = new Set()
  const out = []
  for (const r of records) {
    let key = null
    if (r.kind === 'user') key = r.id || `u:${JSON.stringify(r.content).slice(0, 200)}`
    else if (r.kind === 'call') key = `c:${r.callId}`
    else if (r.kind === 'result') key = `r:${r.callId}`
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(r)
  }
  return out
}

/**
 * A turn is one thing the user said plus everything the assistant did before
 * the next thing the user said. Grouping by turn is what keeps an incremental
 * boundary from landing mid-turn and re-showing half of an exchange.
 */
export function groupTurns(records) {
  const turns = []
  for (const r of records) {
    if (r.kind === 'user' || turns.length === 0) {
      turns.push({ user: r.kind === 'user' ? r : null, items: [] })
    }
    const t = turns[turns.length - 1]
    if (r.kind !== 'user') t.items.push(r)
  }
  return turns
}

export const turnMaxSeq = (t) => Math.max(t.user?.seq ?? -1, ...t.items.map((x) => x.seq ?? -1))
export const turnTime = (t) => Math.max(t.user?.time ?? 0, ...t.items.map((x) => x.time ?? 0))

/** Boundary test: a turn counts as new only when what the user said is past it. */
export const isTurnFresh = (t, boundarySeq) => t.user != null && (t.user.seq ?? 0) > boundarySeq

/* ------------------------------------------------------------------ render */

const demoteHeadings = (s) => s.replace(/^(#{1,5}) /gm, '$1# ')

const reasonPlaceholder = (items) => {
  const chars = items.reduce((s, it) => s + it.raw.length, 0)
  return `<!-- 推理已省略：本段 ${items.length} 处共 ${chars} 字 -->`
}

const clip = (s, max) =>
  s == null ? '' : s.length > max ? `${s.slice(0, max)}\n  …[此处省略 ${s.length - max} 字]` : s

function renderTurns(dedup, { maxReasoning, stats }) {
  const md = []
  const results = new Map()
  for (const r of dedup) if (r.kind === 'result') results.set(r.callId, r)

  let cur = null
  const flush = () => {
    if (!cur) return
    const parts = []
    if (cur.reason.length) {
      if (maxReasoning <= 0) {
        parts.push(`\n${reasonPlaceholder(cur.reason)}`)
      } else {
        const body = cur.reason.map((it) => it.truncated ?? it.text).join('\n\n').trim()
        const dropped = cur.reason.reduce((s, it) => s + (it.truncated ? it.raw.length - maxReasoning : 0), 0)
        parts.push(`\n<details>推理：\n\n${body}${dropped ? `\n\n…[共省略 ${dropped} 字]` : ''}\n</details>`)
      }
    }
    if (cur.said.length) parts.push(`\n${cur.said.join('\n\n').trim()}`)
    if (parts.length) {
      let block = `\n### 🐋 我 · ${hhmmss(cur.time)}`
      if (cur.tools.length) block += `  _(工具: ${[...new Set(cur.tools)].join(', ')})_`
      md.push(block + parts.join('\n'))
      stats.myTurns++
    }
    cur = null
  }

  for (const r of dedup) {
    if (r.kind === 'user') {
      flush()
      const texts = []
      for (const c of r.content) {
        if (c?.type === 'text') texts.push(String(c.text ?? '').trim())
        else texts.push(`[非文本内容: ${c?.type ?? 'unknown'}]`)
      }
      md.push(`\n### 👤 他 · ${hhmmss(r.time)}\n${texts.filter(Boolean).join('\n')}`)
    } else if (r.kind === 'assistant') {
      const content = Array.isArray(r.msg?.content) ? r.msg.content : []
      const reason = content.filter((c) => c?.type === 'reasoning').map((c) => String(c.text ?? '')).join('\n').trim()
      const said = content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('\n').trim()
      const tools = content.filter((c) => c?.type === 'tool-call').map((c) => String(c.name ?? ''))
      const turn = r.turn ?? `seq${r.seq}`
      if (!cur || cur.turn !== turn) {
        flush()
        cur = { turn, time: r.time, reason: [], said: [], tools: [] }
      }
      if (!reason && !said && !tools.length) {
        stats.emptyAssistant++
        continue
      }
      if (reason) {
        stats.reasoningChars += reason.length
        cur.reason.push(reason.length > maxReasoning ? { raw: reason, truncated: clip(reason, maxReasoning) } : { raw: reason, text: reason })
      }
      if (said) cur.said.push(demoteHeadings(said))
      cur.tools.push(...tools)
    } else if (r.kind === 'call') {
      if (cur) cur.tools.push(r.name)
    }
  }
  flush()
  return { md, results }
}

function renderToolDigest(dedup, results) {
  const lines = []
  for (const r of dedup) {
    if (r.kind !== 'call') continue
    const res = results.get(r.callId)
    const outLen = res ? res.text.length : 0
    const flag = res?.isError ? ' ❌' : ''
    let arg = r.args
    try {
      const a = JSON.parse(r.args)
      arg = a.description || a.command || a.file_path || r.args
    } catch {
      /* keep the raw arguments string */
    }
    lines.push(`${hhmmss(r.time)} | ${r.name}${flag} | ${String(arg).replace(/\s+/g, ' ').slice(0, 200)} | 输出${outLen}字`)
  }
  return lines
}

/* ------------------------------------------------------------------- entry */

/**
 * Turn one session's event stream into refinement material.
 *
 * options:
 *   sessionId     logical session id, used for labelling and the watermark
 *   sourceLabel   how the source is described in the header (defaults to id)
 *   mode          'incremental' (default) | 'full'
 *   boundarySeq   watermark seq; turns at or before it are skipped
 *   maxReasoning  reasoning kept per block; 0 (default) drops it to a marker
 *   now           clock override, for deterministic tests
 */
export function gatherEvents(events, options = {}) {
  const sessionId = String(options.sessionId ?? '')
  const sourceLabel = String(options.sourceLabel ?? sessionId)
  const mode = String(options.mode ?? 'incremental') === 'full' ? 'full' : 'incremental'
  const boundarySeq = Math.max(0, Number(options.boundarySeq ?? 0) || 0)
  // 空素材时要沿用上次水印的 time/turns，否则会写出一条 time=0 turns=0 的水印把上次那条
  // 盖掉，「此前已提炼 N 轮」就凭空归零了。手动指定 boundary_seq 时拿不到这两个值，传 null。
  const boundaryTime = Number(options.boundaryTime ?? 0) || 0
  const boundaryTurns =
    options.boundaryTurns === null || options.boundaryTurns === undefined
      ? null
      : Math.max(0, Number(options.boundaryTurns) || 0)
  const maxReasoning = Math.max(0, Number(options.maxReasoning ?? 0) || 0)
  const now = Number(options.now ?? Date.now())

  const { records, stats } = collectRecords(events)
  const turns = groupTurns(records)
  const freshTurns = mode === 'full' ? turns : turns.filter((t) => isTurnFresh(t, boundarySeq))
  const staleTurns = turns.length - freshTurns.length
  const dedup = freshTurns.flatMap((t) => (t.user ? [t.user] : []).concat(t.items))

  const times = dedup.map((r) => r.time).filter(Boolean).sort((a, b) => a - b)
  const lastSeq = dedup.reduce((s, r) => Math.max(s, r.seq ?? 0), 0)
  const lastTime = times.length ? times[times.length - 1] : 0
  const windowTag = times.length ? `${hhmm(times[0])}-${hhmm(times[times.length - 1])}` : '0000-0000'
  const stamp = dayKey(times[0] ?? now)
  // 精确到秒并去掉冒号：同一分钟连跑两次取料不会再把上一份素材覆盖掉，
  // 文件名也仍然是 Windows 允许的字符集（`:` 是非法字符）。
  const runTag = hhmmss(now).replace(/:/g, '')

  const empty = dedup.length === 0
  // turns 记的是「到这条水印为止累计提炼过多少轮」，不是本次新增：增量时在边界上累加，
  // 全量时边界是 0 —— 两种情况都对。手动指定边界（boundaryTurns === null）时退化成会话总轮数。
  const totalTurns = boundaryTurns === null ? turns.length : boundaryTurns + freshTurns.length
  const watermark = {
    session: sessionId,
    seq: empty ? boundarySeq : lastSeq,
    time: empty ? boundaryTime : lastTime,
    turns: totalTurns,
  }
  const watermarkLine = formatWatermark(watermark)

  const { md, results } = renderTurns(dedup, { maxReasoning, stats })

  // header 必须等 renderTurns 跑完再拼：stats.myTurns 是那里面数出来的，
  // 先拼 header 会把「我回 N 轮」永远写成 0。
  const header = [
    `# 会话素材 · ${stamp} · ${windowTag}`,
    '',
    `- 来源: \`${sourceLabel}\``,
    `- 会话: \`${sessionId}\``,
    `- 模式: ${mode === 'full' ? '**全量**' : '增量'}`,
    mode === 'full'
      ? `- 本次新增: **${freshTurns.length} 轮**（全量重取，不按边界过滤）`
      : `- 本次新增: **${freshTurns.length} 轮** / 此处此前已提炼过: ${staleTurns} 轮${boundarySeq ? `（上次边界 seq=${boundarySeq}）` : ''}`,
    `- 内容: 他说 ${dedup.filter((r) => r.kind === 'user').length} 次 / 我回 ${stats.myTurns} 轮 / 工具调用 ${dedup.filter((r) => r.kind === 'call').length} 次（原始事件 ${events.length} 条）`,
    `- 时间窗口: ${times.length ? new Date(times[0]).toLocaleString('zh-CN', { hour12: false }) : '—'} → ${times.length ? new Date(times[times.length - 1]).toLocaleString('zh-CN', { hour12: false }) : '—'}`,
    `- 生成: ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '---',
    '',
  ].join('\n')

  const markdown = empty
    ? `${watermarkLine}\n# 会话素材 · 空\n\n- 来源: \`${sourceLabel}\`\n- 会话: \`${sessionId}\`\n- 模式: ${mode === 'full' ? '全量' : '增量'}\n- 没有任何新内容：此前的边界之后没有出现新的轮次。\n`
    : `${watermarkLine}\n${header}${md.join('\n')}\n`

  const digestLines = renderToolDigest(dedup, results)
  const digest =
    digestLines.length === 0
      ? ''
      : `# 工具调用摘要 · ${stamp} · ${windowTag} · 运行${runTag}\n\n每行: 时间 | 工具 | 意图 | 输出体量\n\n${digestLines.join('\n')}\n`

  return {
    sessionId,
    mode,
    empty,
    markdown,
    digest,
    watermark,
    watermarkLine,
    freshTurns: freshTurns.length,
    staleTurns,
    eventCount: events.length,
    windowTag,
    stamp,
    runTag,
    stats: {
      ...stats,
      droppedInjectionKB: Number((stats.droppedInjection / 1024).toFixed(1)),
      reasoningKB: Number((stats.reasoningChars / 1024).toFixed(1)),
      requestHeaderKB: Number(
        (
          events.filter((e) => e?.type === 'request/header').reduce((s, e) => s + JSON.stringify(e.data ?? {}).length, 0) / 1024
        ).toFixed(1),
      ),
    },
  }
}
