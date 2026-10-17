/**
 * Host half of the memory-refine bundle.
 *
 * Two layers live here:
 *   1. a runtime skill carrying the refinement protocol (no disk effect);
 *   2. five tools: four are the only path through which this plugin can touch
 *      the user's memory files or the prompt-injection layer, and one turns a
 *      session log into refinement material (read-only).
 *
 * The write path is deliberately paranoid, because the thing it edits is the
 * one file the user cannot regenerate. Every write goes through:
 *   read -> version check -> dry diff -> **the user is asked, in a real dialog**
 *   -> backup -> write -> read back and compare.
 * If the dialog is unavailable the write is refused outright rather than
 * silently downgraded to an unattended save.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { PROTOCOL } from './protocol.js'
import { deriveWatermark, gatherEvents, shortSessionId } from './gather.js'
import {
  DSH_HOME,
  MEMORY_DIR,
  diffSummary,
  dropBackup,
  list,
  read,
  readRaw,
  relPath,
  remove,
  resolveTarget,
  versionOf,
  write,
} from './memory.js'

export const inject = ['skills', 'tools', 'commands']

const SKILL = {
  name: 'memory-refine',
  description:
    '提炼长期记忆：把长对话里的偏好、约定、稳定事实、行为规则整理成候选条目，由用户逐条点头后才写进记忆文件。',
  whenToUse:
    '当用户说「提炼」「记一下」「更新记忆」「整理一下我们聊过的」，或一轮很长的对话告一段落、出现值得长期保留的内容时。不要每轮对话都调用。',
  source: 'runtime',
  content: PROTOCOL,
  invocation: { modelInvocable: true, userInvocable: true },
}

const LAYER_LABEL = { inject: '注入层', index: '索引', topic: '常记', archive: '存档' }
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

/* ------------------------------------------------------------------ list */

const LIST_TOOL = {
  name: 'memory_list',
  description:
    '列出记忆文件与注入层（AGENTS.md）的层级、大小、行数、修改时间和版本号。改任何记忆之前先用它确认目标文件和版本号。',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'inject', 'memory'],
        description: 'all=全部（默认）；inject=只看注入层；memory=只看记忆文件',
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        home: { type: 'string' },
        memoryDir: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              layer: { type: 'string' },
              size: { type: 'integer' },
              lines: { type: 'integer' },
              mtime: { type: 'string' },
              version: { type: 'string' },
            },
            required: ['path', 'layer', 'size', 'lines', 'mtime', 'version'],
            additionalProperties: false,
          },
        },
      },
      required: ['home', 'memoryDir', 'files'],
      additionalProperties: false,
    },
    render(_args, value) {
      const rows = value.files.map((f) => {
        const label = LAYER_LABEL[f.layer] ?? f.layer
        return `${label}  ${f.path}  ·  ${f.size}B  ${f.lines}行  ${f.mtime}  ${f.version}`
      })
      return [
        {
          type: 'text',
          text: [`DSH_HOME: ${value.home}`, `记忆目录: ${value.memoryDir}`, '', ...rows].join('\n'),
        },
      ]
    },
  },
  async execute(args) {
    return { home: DSH_HOME, memoryDir: MEMORY_DIR, files: list(args?.scope ?? 'all') }
  },
}

/* ------------------------------------------------------------------ read */

const READ_TOOL = {
  name: 'memory_read',
  description:
    '读取某个记忆文件或注入层文件的正文（分页，默认 250 行）。返回的 version 要原样带进 memory_write，用来防止覆盖掉你看过之后别人做的改动。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '如 memory/示例主题.md，或 AGENTS.md' },
      offset: { type: 'integer', description: '起始行（从 1 起），默认 1' },
      limit: { type: 'integer', description: '读多少行，默认 250，上限 2000' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        version: { type: 'string' },
        size: { type: 'integer' },
        lines: { type: 'integer' },
        offset: { type: 'integer' },
        returned: { type: 'integer' },
        truncated: { type: 'boolean' },
        content: { type: 'string' },
      },
      required: ['path', 'version', 'size', 'lines', 'offset', 'returned', 'truncated', 'content'],
      additionalProperties: false,
    },
    render(_args, value) {
      const last = value.offset + value.returned - 1
      const tail = value.truncated ? '（后面还有，用 offset 继续）' : '（已到末尾）'
      const head = `# ${value.path} · ${value.size}B · 全文 ${value.lines} 行 · 版本 ${value.version} · 本次第 ${value.offset}–${last} 行 ${tail}`
      return [{ type: 'text', text: `${head}\n\n${value.content}` }]
    },
  },
  async execute(args) {
    const abs = resolveTarget(args?.path)
    if (!existsSync(abs)) throw new Error(`文件不存在：${relPath(abs)}`)
    return read(abs, { offset: args?.offset, limit: args?.limit })
  },
}

/* ------------------------------------------------- shared commit machinery */

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    applied: { type: 'boolean' },
    path: { type: 'string' },
    reason: { type: 'string' },
    added: { type: 'integer' },
    removed: { type: 'integer' },
    created: { type: 'boolean' },
    beforeVersion: { type: 'string' },
    version: { type: 'string' },
    backup: { type: 'string' },
    verified: { type: 'boolean' },
    size: { type: 'integer' },
    lines: { type: 'integer' },
    picked: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: false,
}

function renderCommit(_args, value) {
  if (!value?.ok) {
    const tag = value?.applied === false ? '未写入' : '写入失败'
    return [{ type: 'text', text: `${tag}：${value?.error ?? '未知原因'}` }]
  }
  const head = `已写入 ${value.path}：${value.created ? '新建' : `${value.beforeVersion} → `}${value.version} · +${value.added ?? 0}/−${value.removed ?? 0} 行 · 现在 ${value.lines} 行 ${value.size}B`
  const lines = [head]
  if (value.backup) lines.push(`备份：${value.backup}`)
  lines.push(
    value.verified
      ? '读回核验：通过（磁盘内容与预期逐字一致）'
      : '读回核验：**失败** —— 磁盘内容与预期不一致，请立刻 memory_read 检查！',
  )
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 唯一的落盘出口。任何写都必须经过这里：确认框拿不到就拒绝，用户不点头就不写。
 */
async function confirmAndWrite(ctx, { abs, before, nextText, expectedVersion, reason, exec, confirmed = false }) {
  const current = before === '' ? '' : versionOf(before)
  if (expectedVersion && current !== expectedVersion) {
    return {
      ok: false,
      path: relPath(abs),
      error: `中止：${relPath(abs)} 在你看过之后被改动过（磁盘上是 ${current}，你手上的是 ${expectedVersion}）。没有弹确认框，也没有写入。请重新 memory_read 再试。`,
    }
  }

  const diff = diffSummary(before, nextText)
  const target = relPath(abs)
  const existed = before !== '' || existsSync(abs)
  const action = !existed ? '新建' : '写入'

  // confirmed=true 只出现在插件界面那条路上：用户在界面上按下「保存」本身就是
  // 那一次点头，不必再弹一次同样的对话框。备份与读回核验在这条路上一次都不少。
  if (!confirmed) {
    const questions = ctx.get('userQuestions')
    if (!questions || typeof questions.ask !== 'function') {
      return {
        ok: false,
        error: 'userQuestions 服务不可用。按「没有用户点头就绝不落盘」的原则，本次写入被拒绝。',
      }
    }

    let answer
    try {
      answer = await questions.ask({
        agent: exec?.agent,
        signal: exec?.signal,
        questions: [
          {
            id: 'commit',
            header: '记忆落盘确认',
            question: `要${action} ${target} 吗？（+${diff.added} 行 / −${diff.removed} 行）`,
            detail: `改动理由：${reason}\n\n${diff.text}`,
            options: [
              { label: '确认写入', description: '先整份备份，再写入，最后读回核验' },
              { label: '不写', description: '放弃这次改动，文件保持原样' },
            ],
          },
        ],
      })
    } catch (err) {
      return { ok: false, error: `确认框调用失败（${err?.message ?? err}），没有写入任何内容。` }
    }

    // 用户可能点选项，也可能直接在输入框里写答案（「1」「确认」这类）。
    // 只认明确的肯定；「不写」「跳过」以及没法判定的文字一律当作没确认。
    const first = answer?.answers?.[0]
    const selected = Array.isArray(first?.selected) ? first.selected.map((x) => String(x).trim()) : []
    const custom = String(first?.custom ?? '').trim()
    const picked = selected[0] ?? custom
    const norm = String(picked).trim().toLowerCase()
    const YES = new Set(['确认写入', '确认', '写入', '确定', 'ok', 'yes', 'y', '1'])
    const NO = new Set(['', '不写', '跳过', '取消', 'no', 'n', '0', '2'])
    if (NO.has(norm) || !YES.has(norm)) {
      return {
        ok: false,
        applied: false,
        picked,
        path: target,
        error:
          `用户没有确认（收到的是「${picked || '空'}」），文件未改动。` +
          '如果刚才点的是第一个选项，请直接点选项前面的圆圈再按提交；' +
          '在输入框里打字会被当成自定义答案。',
      }
    }
  }

  let result
  try {
    result = write(abs, nextText, { expectedVersion })
  } catch (err) {
    return { ok: false, path: target, error: err?.message ?? String(err) }
  }

  return {
    ok: true,
    applied: true,
    path: result.path,
    reason,
    added: diff.added,
    removed: diff.removed,
    created: result.created,
    beforeVersion: result.beforeVersion ?? '',
    version: result.version,
    backup: result.backup ?? '',
    verified: result.verified,
    size: result.size,
    lines: result.lines,
  }
}

function parseExpectedVersion(args) {
  const raw = args?.expected_version
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw)
}

/* ----------------------------------------------------------------- write */

function makeWriteTool(ctx) {
  return {
    name: 'memory_write',
    description:
      '修改记忆文件或注入层文件；目标不存在时会新建（`memory/` 目录也一并创建）。落盘前会弹出确认框，只有用户亲自点头才会真的写入；改现有文件时写前自动整份备份，写后读回核验。改现有文件必须带 expected_version（来自 memory_read），新建时省略。返回 applied=false 表示用户没点头，此时**什么都没写**，不要当成已落盘。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '如 memory/示例主题.md，或 AGENTS.md；不存在时新建' },
        mode: {
          type: 'string',
          enum: ['replace', 'replace_string', 'append'],
          description:
            'replace_string=替换其中一段（推荐，改动最小）；append=追加到文件末尾；replace=整篇替换（危险，尽量别用）',
        },
        content: { type: 'string', description: 'mode=replace / append 时的新内容' },
        old_string: {
          type: 'string',
          description: 'mode=replace_string 时，要被替换掉的原文；必须与文件里逐字一致，且全文唯一',
        },
        new_string: { type: 'string', description: 'mode=replace_string 时替换成的内容' },
        expected_version: {
          type: 'string',
          description: 'memory_read 拿到的版本号；新建文件时省略',
        },
        reason: { type: 'string', description: '为什么要改（会显示在确认框里给用户判断，必填）' },
      },
      required: ['path', 'mode', 'reason'],
      additionalProperties: false,
    },
    output: { schema: COMMIT_SCHEMA, render: renderCommit },
    async execute(args, exec) {
      const reason = String(args?.reason ?? '').trim()
      if (!reason) return { ok: false, error: 'reason 必填：确认框里要让用户看到你为什么改。' }

      let abs
      try {
        abs = resolveTarget(args?.path)
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) }
      }

      const before = readRaw(abs)
      const expectedVersion = parseExpectedVersion(args)
      const mode = String(args?.mode ?? '')

      let nextText
      try {
        if (mode === 'replace') {
          if (typeof args?.content !== 'string') throw new Error('mode=replace 需要 content')
          nextText = args.content
        } else if (mode === 'append') {
          if (typeof args?.content !== 'string') throw new Error('mode=append 需要 content')
          const base = before === '' || before.endsWith('\n') ? before : `${before}\n`
          nextText = `${base}${args.content}`
          if (!nextText.endsWith('\n')) nextText += '\n'
        } else if (mode === 'replace_string') {
          const oldString = String(args?.old_string ?? '')
          const newString = String(args?.new_string ?? '')
          if (!oldString) throw new Error('mode=replace_string 需要 old_string')
          const hits = before.split(oldString).length - 1
          if (hits === 0) throw new Error('old_string 在文件里找不到：必须逐字一致（含空格与换行）。')
          if (hits > 1) {
            throw new Error(`old_string 在文件里出现了 ${hits} 次，不唯一，拒绝盲替换。请多带几行上下文。`)
          }
          nextText = before.replace(oldString, newString)
        } else {
          throw new Error(`未知 mode：${mode || '(空)'}`)
        }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) }
      }

      if (nextText === before) {
        return { ok: false, error: '改动后与原文完全一致，不需要写入。' }
      }
      return confirmAndWrite(ctx, { abs, before, nextText, expectedVersion, reason, exec })
    },
  }
}

/* ---------------------------------------------------------------- import */

/**
 * 解析导入内容的来源。
 *
 * 面板上那个大框既能贴正文，也能贴一个文件的绝对路径 —— 想搬旧笔记时，与其把
 * 几万字粘进去，不如直接写路径。判定刻意收得很紧：**必须是绝对路径**（相对路径
 * 在 Host 里没有确定的基准目录，猜错了会读到别的文件），而且真的存在、是普通文件。
 * 任何一条不满足就退回「当正文处理」。
 */
function readImportSource(raw) {
  const text = String(raw ?? '')
  const trimmed = text.trim()
  if (!trimmed) throw new Error('导入内容为空。')

  const single = !/[\r\n]/.test(trimmed) && trimmed.length <= 4096
  if (single && isAbsolute(trimmed)) {
    let st
    try {
      st = statSync(trimmed)
    } catch (err) {
      // 写得像个路径但文件不在：明确报错，不要悄悄当正文导进去（那会存一堆路径字符串）
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        throw new Error(`找不到这个文件：${trimmed}`)
      }
      throw err
    }
    if (!st.isFile()) throw new Error(`这个路径不是文件：${trimmed}`)
    if (st.size > MAX_IMPORT_BYTES) {
      throw new Error(
        `来源文件 ${(st.size / 1048576).toFixed(1)}MB，超过 ${MAX_IMPORT_BYTES / 1048576}MB 上限。请先裁剪。`,
      )
    }
    return { text: readFileSync(trimmed, 'utf8'), fromPath: trimmed }
  }

  return { text, fromPath: null }
}

function makeImportTool(ctx) {
  return {
    name: 'memory_import',
    description:
      '把外部内容导入记忆文件：来源可以是别的软件的导出文件（source_path）或直接粘贴的原文（source_text）。会先算出 diff 再弹确认框，用户点头才写入。用来把旧记忆、别处的笔记搬进来。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '目标记忆文件，如 memory/示例主题.md；不存在时会新建',
        },
        source_path: { type: 'string', description: '来源文件的绝对路径（与 source_text 二选一）' },
        source_text: { type: 'string', description: '直接粘贴的原文（与 source_path 二选一）' },
        mode: {
          type: 'string',
          enum: ['section', 'append'],
          description: 'section=新起一个二级标题章节（默认）；append=直接接到文件末尾',
        },
        title: { type: 'string', description: 'mode=section 时的章节标题' },
        expected_version: { type: 'string', description: '目标文件的当前版本；新建时省略' },
        reason: { type: 'string', description: '为什么导入（会显示在确认框里，必填）' },
      },
      required: ['target', 'reason'],
      additionalProperties: false,
    },
    output: { schema: COMMIT_SCHEMA, render: renderCommit },
    async execute(args, exec) {
      const reason = String(args?.reason ?? '').trim()
      if (!reason) return { ok: false, error: 'reason 必填：确认框里要让用户看到你为什么导入。' }

      let abs
      try {
        abs = resolveTarget(args?.target)
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) }
      }

      let source = ''
      try {
        if (typeof args?.source_text === 'string' && args.source_text.trim() !== '') {
          source = args.source_text
        } else if (typeof args?.source_path === 'string' && args.source_path.trim() !== '') {
          source = readImportSource(String(args.source_path)).text
        } else {
          throw new Error('必须提供 source_path 或 source_text 之一。')
        }
      } catch (err) {
        return { ok: false, error: `读取来源失败：${err?.message ?? err}` }
      }

      const body = source.trim()
      if (!body) return { ok: false, error: '来源内容为空，没有可导入的东西。' }

      const before = readRaw(abs)
      const mode = String(args?.mode ?? 'section')
      const heading = String(args?.title ?? '').trim() || basename(abs, '.md')
      const block =
        mode === 'append'
          ? `${body}\n`
          : `\n## ${heading}\n\n${body}\n`
      const base = before === '' || before.endsWith('\n') ? before : `${before}\n`
      const nextText = `${base}${mode === 'append' ? '' : '\n'}${block}`

      return confirmAndWrite(ctx, {
        abs,
        before,
        nextText,
        expectedVersion: parseExpectedVersion(args),
        reason,
        exec,
      })
    },
  }
}

/* ---------------------------------------------------------------- gather */

const GATHER_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    sessionId: { type: 'string' },
    mode: { type: 'string' },
    empty: { type: 'boolean' },
    boundarySeq: { type: 'integer' },
    freshTurns: { type: 'integer' },
    staleTurns: { type: 'integer' },
    eventCount: { type: 'integer' },
    materialPath: { type: 'string' },
    digestPath: { type: 'string' },
    watermarkLine: { type: 'string' },
    preview: { type: 'string' },
    stats: { type: 'object', additionalProperties: true },
  },
  required: ['ok'],
  additionalProperties: false,
}

const PREVIEW_CHARS = 1600

function renderGather(_args, value) {
  if (!value?.ok) return [{ type: 'text', text: `取料失败：${value?.error ?? '未知原因'}` }]
  const s = value.stats ?? {}
  const lines = [
    `素材已生成：${value.materialPath}`,
    `会话 ${value.sessionId} · ${value.mode === 'full' ? '全量' : '增量'} · 本次新增 ${value.freshTurns} 轮（此前已提炼 ${value.staleTurns} 轮）· 原始事件 ${value.eventCount} 条`,
  ]
  if (value.empty) lines.push('⚠️ 边界之后没有新内容，素材是空的。')
  if (value.digestPath) lines.push(`工具调用摘要：${value.digestPath}`)
  lines.push(`水位线：${value.watermarkLine}`)
  lines.push(
    `已丢弃：注入文本 ${s.droppedInjectionKB ?? 0}KB · 纯注入消息 ${s.droppedSystemMsg ?? 0} 条 · 推理 ${s.reasoningKB ?? 0}KB · request-header ${s.requestHeaderKB ?? 0}KB`,
  )
  lines.push('', `预览（前 ${PREVIEW_CHARS} 字）：`, '', value.preview ?? '')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 素材落点：默认写在会话自己的工作区下，不往 DSH_HOME 里堆垃圾；
 * 拿不到 cwd 时才退回 DSH_HOME。out_dir 可以覆盖。
 */
function scratchDir(explicit, cwd) {
  const raw = String(explicit ?? '').trim()
  if (raw) return resolve(raw)
  const base = String(cwd ?? '').trim()
  return base ? join(resolve(base), 'memory-refine-scratch') : join(DSH_HOME, 'memory-refine-scratch')
}

/**
 * 清理素材：只动会话工作区下 memory-refine-scratch/ 里由本插件产出的
 * `material-*.md` 与 `tools-*.md`。别的一概不碰，也不递归进子目录。
 * 删之前把每个文件的字节数加起来，删完如实报「删了几个、释放了多少」。
 */
async function cleanScratch(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery) throw new Error('sessionQuery 不可用，拿不到会话工作目录。')
  let snapshot
  try {
    snapshot = await sessionQuery.readSession(sessionId)
  } catch (err) {
    throw new Error(`读会话 ${sessionId} 失败：${err?.message ?? err}`)
  }
  const cwd = String(snapshot?.session?.cwd ?? '').trim()
  if (!cwd) throw new Error('这个会话没有记录工作目录，找不到素材该在哪。')
  const dir = join(resolve(cwd), 'memory-refine-scratch')
  if (!existsSync(dir)) return { dir, removed: 0, freed: 0, files: [], kept: 0 }

  let names = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    throw new Error(`列目录 ${dir} 失败：${err?.message ?? err}`)
  }
  const targets = names.filter((n) => /^(material|tools)-.+\.md$/.test(n))
  const kept = names.length - targets.length
  let freed = 0
  const removedFiles = []
  for (const name of targets) {
    const abs = join(dir, name)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      unlinkSync(abs)
      freed += st.size
      removedFiles.push(name)
    } catch {
      // 单个文件删不掉就跳过，不让整批失败
    }
  }
  return { dir, removed: removedFiles.length, freed, files: removedFiles, kept }
}

function makeGatherTool(ctx) {
  return {
    name: 'memory_gather',
    description:
      '把一场会话的对话取成提炼素材（markdown 落盘）。会丢掉引擎注入的消息、消息内嵌的 system-reminder、request/header 提示词清单、运行时快照与推理正文，只留他说的话、我的回复和工具调用摘要。默认增量：从前一条 memory_gather 留下的水印之后接着取；水印写在素材首行，下次自动接上，所以不需要任何外部状态文件。只读会话日志，不碰记忆文件。',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '要提炼的会话 id；省略 = 当前会话' },
        mode: {
          type: 'string',
          enum: ['incremental', 'full'],
          description: 'incremental（默认）只取水印之后的新轮次；full 取全程',
        },
        boundary_seq: {
          type: 'integer',
          description: '手动指定边界 seq；省略则从会话日志里上一次 memory_gather 的水印派生',
        },
        max_reasoning: {
          type: 'integer',
          description: '每段保留多少推理字符；0（默认）整段砍掉只留一行占位',
        },
        out_dir: { type: 'string', description: '素材落点目录；省略 = 会话工作区下的 memory-refine-scratch/' },
      },
      additionalProperties: false,
    },
    output: { schema: GATHER_SCHEMA, render: renderGather },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // 故意用可选的 ctx.get 而不是写进 inject：sessionQuery 缺席时只有这一个
      // 工具失效，另外四个照常活，插件的其余部分不受拖累。
      const sessionQuery = ctx.get('sessionQuery')
      if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
        return { ok: false, error: 'sessionQuery 服务不可用：取料需要它来读会话日志。' }
      }

      const sessionId = String(args?.session_id ?? '').trim() || String(exec?.agent?.id ?? '')
      if (!sessionId) {
        return { ok: false, error: '拿不到会话 id：宿主没有把 agent 传进来，请显式传 session_id。' }
      }

      let snapshot
      try {
        snapshot = await sessionQuery.readSession(sessionId)
      } catch (err) {
        return { ok: false, error: `读会话 ${sessionId} 失败：${err?.message ?? err}` }
      }
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      if (events.length === 0) return { ok: false, error: `会话 ${sessionId} 里没有事件。` }

      const mode = String(args?.mode ?? 'incremental') === 'full' ? 'full' : 'incremental'
      const rawBoundary = args?.boundary_seq
      const manual = rawBoundary !== undefined && rawBoundary !== null && rawBoundary !== ''
      // 派生出来的水印要整条带上：空素材时得原样写回去，不能把它抹成 time=0 turns=0。
      const derived = manual ? null : deriveWatermark(events, { sessionId })
      const boundarySeq = manual ? Math.max(0, Number(rawBoundary) || 0) : (derived?.seq ?? 0)

      const result = gatherEvents(events, {
        sessionId,
        sourceLabel: [shortSessionId(sessionId), String(snapshot?.session?.cwd ?? '')].filter(Boolean).join(' · '),
        mode,
        boundarySeq,
        boundaryTime: derived?.time ?? 0,
        boundaryTurns: derived ? (derived.turns ?? 0) : null,
        maxReasoning: Math.max(0, Number(args?.max_reasoning ?? 0) || 0),
      })

      const dir = scratchDir(args?.out_dir, snapshot?.session?.cwd)
      const base = `${result.stamp}-${result.runTag}-${shortSessionId(sessionId)}`
      let materialPath = ''
      let digestPath = ''
      try {
        mkdirSync(dir, { recursive: true })
        materialPath = join(dir, `material-${base}.md`)
        writeFileSync(materialPath, result.markdown, 'utf8')
        if (result.digest) {
          digestPath = join(dir, `tools-${base}.md`)
          writeFileSync(digestPath, result.digest, 'utf8')
        }
      } catch (err) {
        return { ok: false, error: `素材落盘失败（${dir}）：${err?.message ?? err}` }
      }

      return {
        ok: true,
        sessionId,
        mode,
        empty: result.empty,
        boundarySeq,
        freshTurns: result.freshTurns,
        staleTurns: result.staleTurns,
        eventCount: result.eventCount,
        materialPath,
        digestPath,
        watermarkLine: result.watermarkLine,
        preview: result.markdown.slice(0, PREVIEW_CHARS),
        stats: result.stats,
      }
    },
  }
}

/* ------------------------------------------------------------ 界面通道 */

/**
 * 插件界面（Client 半边）有两条 Host 入口，按优先级：
 *
 *   1. HTTP 路由 `/memory-refine/ui`（首选）。走 webServer，不经过命令总线，
 *      因此不会在会话日志里留下 command/run + command/done 这一对事件。
 *   2. 斜杠命令 `memory-refine`（兜底）。HTTP 路由没注册上（webServer 缺席）
 *      或请求被鉴权层拒绝时用，可用性优先，代价是对话里会多一条记录。
 *
 * 两条最终都落到 handleUiRequest，行为完全一致。
 */

/** 前缀路由的挂载点。注意不能带尾斜杠 —— webserver 的 match() 会拿
 *  `${prefix}/` 去 startsWith，尾斜杠会变成 `//`，导致任何子路径都匹配不上。 */
const HTTP_ROUTE = '/memory-refine'
const HTTP_UI_PATH = `${HTTP_ROUTE}/ui`
const HTTP_BODY_LIMIT = 8 * 1024 * 1024

/**
 * 插件界面（Client 半边）的命令入口（兜底通道）。
 *
 * 命令名带连字符是为了不和用户手打的斜杠命令撞车；载荷是一段 JSON，
 * 返回值也是 JSON 文本。写操作仍然走 confirmAndWrite，只是带着
 * confirmed=true —— 用户在界面上按下「保存」就是那一次点头。
 */
async function handleUiRequest(ctx, req, invocation) {
  const action = String(req?.action ?? '')

  if (action === 'list') {
    return { home: DSH_HOME, memoryDir: MEMORY_DIR, files: list(String(req?.scope ?? 'all')) }
  }

  if (action === 'read') {
    const abs = resolveTarget(req?.path)
    if (!existsSync(abs)) throw new Error(`文件不存在：${relPath(abs)}`)
    const text = readRaw(abs)
    return {
      path: relPath(abs),
      version: versionOf(text),
      size: Buffer.byteLength(text, 'utf8'),
      lines: text === '' ? 0 : text.split('\n').length,
      text,
    }
  }

  if (action === 'write') {
    const abs = resolveTarget(req?.path)
    const before = readRaw(abs)
    const nextText = String(req?.text ?? '')
    if (nextText === before) throw new Error('正文没有变化，不需要写入。')
    const result = await confirmAndWrite(ctx, {
      abs,
      before,
      nextText,
      expectedVersion: req?.expectedVersion ? String(req.expectedVersion) : undefined,
      reason: String(req?.reason ?? '').trim() || '在插件界面里直接编辑',
      exec: { agent: invocation?.agent, signal: invocation?.signal },
      confirmed: true,
    })
    if (!result.ok) throw new Error(result.error ?? '写入失败')
    return result
  }

  if (action === 'import') {
    const abs = resolveTarget(req?.target)
    const before = readRaw(abs)
    // 大框里可能是正文，也可能是一个绝对路径 —— 由 readImportSource 判定
    const src = readImportSource(req?.text)
    const body = src.text.trim()
    if (!body) throw new Error('导入内容为空。')
    const mode = String(req?.mode ?? 'section')
    const heading = String(req?.title ?? '').trim() || basename(abs, '.md')
    const block = mode === 'append' ? `${body}\n` : `## ${heading}\n\n${body}\n`
    const base = before === '' || before.endsWith('\n') ? before : `${before}\n`
    // base 已经保证以 \n 结尾（除非文件是空的）。section 模式这里再补一个空行，
    // 让「## 标题」和上文之间空一行；空文件/append 模式则不补，免得文件以空行开头
    // 或和上一段贴在一起。以前的写法在两边各加一个，结果中间会空出两行。
    const sep = before === '' || mode === 'append' ? '' : '\n'
    const nextText = `${base}${sep}${block}`
    const result = await confirmAndWrite(ctx, {
      abs,
      before,
      nextText,
      expectedVersion: req?.expectedVersion ? String(req.expectedVersion) : undefined,
      reason: String(req?.reason ?? '').trim() || `从插件界面导入到 ${relPath(abs)}`,
      exec: { agent: invocation?.agent, signal: invocation?.signal },
      confirmed: true,
    })
    if (!result.ok) throw new Error(result.error ?? '导入失败')
    return { ...result, fromPath: src.fromPath, sourceChars: src.text.length }
  }

  if (action === 'delete') {
    const abs = resolveTarget(req?.path)
    const result = remove(abs, {
      expectedVersion: req?.expectedVersion ? String(req.expectedVersion) : undefined,
    })
    return result
  }

  if (action === 'dropBackup') {
    // 用户点了「这版没问题」才会走到这儿 —— 那一按就是他的点头。
    // 只删备份，正文一个字节都不碰。
    return dropBackup(req?.backup)
  }

  if (action === 'cleanScratch') {
    // 素材目录按会话工作区走，所以必须先知道是哪个会话。
    const sessionId =
      String(invocation?.agent?.id ?? '').trim() || String(req?.sessionId ?? '').trim()
    if (!sessionId) throw new Error('拿不到会话 id：清理素材需要知道是哪个会话的工作区。')
    return cleanScratch(ctx, sessionId)
  }

  throw new Error(`未知 action：${action || '(空)'}`)
}

function registerUiBridge(ctx) {
  return ctx.commands.register({
    name: 'memory-refine',
    description: '记忆提炼插件自带界面的内部通道（载荷是 JSON；不是给人手打的命令）',
    // 载荷（action / path / text）都由命令自己的返回值承载了，再往会话日志里存一份
    // 完整的输入 JSON 纯属重复。关掉它，日志里就只剩结果那一条。
    recordInput: false,
    handler: async (invocation) => {
      try {
        const raw = String(invocation?.rawInput ?? '').trim()
        const req = raw === '' ? {} : JSON.parse(raw)
        const data = await handleUiRequest(ctx, req, invocation)
        return { kind: 'success', text: JSON.stringify({ ok: true, data }) }
      } catch (err) {
        return { kind: 'error', text: String(err?.message ?? err) }
      }
    },
  })
}

/* --------------------------------------------------------- HTTP 通道 */

/** WebRoute.handler 拿到的是裸 Node 请求对象，body 得自己读。 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > HTTP_BODY_LIMIT) {
      const err = new Error(`请求体超过 ${Math.round(HTTP_BODY_LIMIT / 1024 / 1024)}MB 上限`)
      err.httpStatus = 413
      throw err
    }
    chunks.push(chunk)
  }
  // 空 body 当成 {}：路由被 GET 探测时不至于 500。
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 把面板的读写挂到 webServer 上。
 *
 * 三个必须自己兜住的点：
 *   - 必须 POST + `application/json`。这两条同时把「跨站简单请求」挡在门外：
 *     别的网页想 fake 一个 text/plain 的 POST 会先撞 415，想用 JSON 又会先发
 *     CORS 预检，而我们对 OPTIONS 什么都不回。
 *   - 鉴权交给 DSH 自己的 requestRejection，不自己造 token（那是禁区）。
 *   - 业务错误沿用既有约定：HTTP 200 + `{ ok:false, error }`。前端按 ok 判断，
 *     不把错误当成断网。
 */
function registerHttpBridge(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: HTTP_ROUTE,
    handler: async (req, res) => {
      let pathname = '/'
      try {
        pathname = new URL(req.url ?? '/', 'http://x').pathname
      } catch {
        writeJson(res, 400, { ok: false, error: '无法解析的请求路径' })
        return
      }

      const connection = ctx.get('connection')
      const rejection =
        connection && typeof connection.requestRejection === 'function'
          ? connection.requestRejection({ headers: req.headers })
          : undefined

      // 早退分支都没读 body。不排空的话，keep-alive 连接上的下一个请求会被
      // 残留的字节污染；resume() 让流自己流干。
      if (pathname !== HTTP_UI_PATH) {
        req.resume()
        writeJson(res, 404, { ok: false, error: '没有这个接口' })
        return
      }

      if (req.method !== 'POST') {
        req.resume()
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('只接受 POST')
        return
      }

      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        req.resume()
        writeJson(res, 415, { ok: false, error: 'content-type 必须是 application/json' })
        return
      }

      if (rejection !== undefined) {
        req.resume()
        writeJson(res, rejection, {
          ok: false,
          error: `面板通道被鉴权层拒绝（HTTP ${rejection}）`,
        })
        return
      }

      try {
        const body = await readJsonBody(req)
        const sessionId = String(body?.sessionId ?? '').trim()
        const agent = sessionId ? ctx.get('agents')?.get(sessionId) : undefined
        const data = await handleUiRequest(ctx, body, { agent })
        writeJson(res, 200, { ok: true, data })
      } catch (err) {
        writeJson(res, Number(err?.httpStatus) || 200, {
          ok: false,
          error: String(err?.message ?? err),
        })
      }
    },
  })
}

/* ----------------------------------------------------------------- apply */

export function apply(ctx) {
  ctx.effect(() => ctx.skills.register(SKILL), 'memory-refine: protocol skill')

  // 界面通道也遵守「注册失败不拖垮别的」。
  ctx.effect(() => {
    try {
      return registerUiBridge(ctx)
    } catch (err) {
      console.error(`[memory-refine] 注册界面通道失败：${err?.message ?? err}`)
      return () => {}
    }
  }, 'memory-refine: ui bridge')

  // 面板 HTTP 通道。webServer 是可选服务：写进导出的 inject 数组会让它在缺席时
  // 整个插件都起不来（禁区 4 禁止这么做），所以用 ctx.inject 单独等它 —— 这是
  // cordis 自己处理可选依赖的写法，服务缺席时只是这一段不激活，其余照常。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      try {
        return registerHttpBridge(webCtx)
      } catch (err) {
        console.error(`[memory-refine] 注册面板 HTTP 通道失败：${err?.message ?? err}`)
        return () => {}
      }
    }, 'memory-refine: http bridge')
  })

  // 一个工具注册失败不许拖垮别的：skill 和其余工具照常活。
  const tools = [
    ['memory_list', LIST_TOOL],
    ['memory_read', READ_TOOL],
    ['memory_write', makeWriteTool(ctx)],
    ['memory_import', makeImportTool(ctx)],
    ['memory_gather', makeGatherTool(ctx)],
  ]
  for (const [name, tool] of tools) {
    ctx.effect(() => {
      try {
        return ctx.tools.register(tool)
      } catch (err) {
        console.error(`[memory-refine] 注册工具 ${name} 失败：${err?.message ?? err}`)
        return () => {}
      }
    }, `memory-refine: ${name}`)
  }
}
