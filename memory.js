/**
 * 受管的记忆／注入层访问层。
 *
 * 只做三件事，全部同步（这些文件都很小）：
 *   1. 把外部传进来的路径收进白名单 —— 只认 DSH_HOME/AGENTS.md 与 DSH_HOME/memory/**\/*.md
 *   2. 读、写、写前备份、写后读回核验、按内容哈希做乐观并发校验
 *   3. 给出人能看懂的逐行 diff（给确认框用）
 *
 * 这里没有任何隐藏状态：写坏了能靠 backups/ 里的副本 + 返回的 beforeVersion 还原。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
export const MEMORY_DIR = join(DSH_HOME, 'memory')
export const AGENTS_FILE = join(DSH_HOME, 'AGENTS.md')

/** 写入前的自动备份落点：跟着 DSH_HOME 走，不污染插件包，也不进 memory/。 */
export const BACKUP_DIR = join(DSH_HOME, 'memory-refine-backups')

const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

/** 12 位内容指纹。同一个内容永远同一个版本号，用来做「你看过之后有没有人动过」的比对。 */
export const versionOf = hash

export function relPath(abs) {
  return relative(DSH_HOME, abs).split(sep).join('/')
}

/** 四层归位：inject（每轮注入）／index（索引）／topic（默认落点）／archive（回溯才看）。 */
export function layerOf(abs) {
  if (abs === AGENTS_FILE) return 'inject'
  const r = relPath(abs)
  if (r === 'memory/MEMORY.md') return 'index'
  if (r.startsWith('memory/archive/')) return 'archive'
  return 'topic'
}

function isManaged(abs) {
  const p = resolve(abs)
  return p === AGENTS_FILE || p === MEMORY_DIR || p.startsWith(MEMORY_DIR + sep)
}

/**
 * 把用户／模型给的路径收进白名单。
 * 认这些写法：`AGENTS.md`、`memory/示例主题.md`、`示例主题.md`（默认相对 memory/）、绝对路径。
 * 白名单外一律抛错，绝不「猜一个相近的路径」。
 */
export function resolveTarget(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/')
  if (!raw) throw new Error('path 不能为空')
  let abs
  if (raw === 'AGENTS.md') abs = AGENTS_FILE
  else if (raw.startsWith('memory/')) abs = join(DSH_HOME, raw)
  else if (/^[A-Za-z]:\//.test(raw) || raw.startsWith('/')) abs = resolve(raw)
  else abs = join(MEMORY_DIR, raw)
  if (!isManaged(abs)) {
    throw new Error(
      `拒绝：${input} 不在受管范围内。只允许 ${AGENTS_FILE} 与 ${MEMORY_DIR} 下的 .md 文件。`,
    )
  }
  if (!/\.md$/i.test(abs)) {
    throw new Error('拒绝：只允许操作 .md 文件（目录、图片、二进制一律不碰）。')
  }
  return abs
}

export function describe(abs) {
  const st = statSync(abs)
  const text = readFileSync(abs, 'utf8')
  return {
    path: relPath(abs),
    layer: layerOf(abs),
    size: st.size,
    lines: text.split('\n').length,
    mtime: new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19),
    version: hash(text),
  }
}

/** 这些子目录不是长期记忆条目（旧平台时代的会话流水），列出来只会干扰判断。 */
const SKIP_DIRS = new Set(['会话笔记'])

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(p, out)
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(describe(p))
  }
  return out
}

/** 列出受管文件。scope: 'all' | 'inject' | 'memory' */
export function list(scope = 'all') {
  const out = []
  if (scope !== 'memory' && existsSync(AGENTS_FILE)) out.push(describe(AGENTS_FILE))
  if (scope !== 'inject') walk(MEMORY_DIR, out)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 分页读。默认 250 行，上限 2000 行 —— 避免把 19KB 的记忆文件一次灌进上下文。 */
export function read(abs, { offset, limit } = {}) {
  const text = readFileSync(abs, 'utf8')
  const all = text.split('\n')
  const start = Math.max(1, Number(offset) || 1)
  const count = Math.max(1, Math.min(Number(limit) || 250, 2000))
  const slice = all.slice(start - 1, start - 1 + count)
  return {
    path: relPath(abs),
    version: hash(text),
    size: Buffer.byteLength(text, 'utf8'),
    lines: all.length,
    offset: start,
    returned: slice.length,
    truncated: start - 1 + slice.length < all.length,
    content: slice.join('\n'),
  }
}

export function readRaw(abs) {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

/**
 * 写入。三道闸：
 *   ① expectedVersion 与磁盘现状对不上就中止（你看过之后别人改过 = 不覆盖）
 *   ② 写前整份备份到 backups/
 *   ③ 写后立刻读回，逐字比对，verified=false 就如实报出来
 */
export function write(abs, nextText, { expectedVersion } = {}) {
  const existed = existsSync(abs)
  const before = existed ? readFileSync(abs, 'utf8') : ''
  if (existed) {
    const current = hash(before)
    if (expectedVersion && current !== expectedVersion) {
      throw new Error(
        `中止：${relPath(abs)} 在你看过之后被改动过（磁盘上是 ${current}，你手上的是 ${expectedVersion}）。请重新 memory_read 再试。`,
      )
    }
  } else if (expectedVersion) {
    throw new Error('中止：目标文件不存在，却提供了 expected_version。新建文件时不要传它。')
  }

  let backup = null
  if (existed) {
    mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    backup = join(BACKUP_DIR, `${stamp}__${relPath(abs).replace(/[\\/]/g, '_')}`)
    writeFileSync(backup, before, 'utf8')
  }

  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, nextText, 'utf8')

  const after = readFileSync(abs, 'utf8')
  return {
    path: relPath(abs),
    created: !existed,
    beforeVersion: existed ? hash(before) : null,
    version: hash(after),
    backup: backup ? relative(DSH_HOME, backup).split(sep).join('/') : null,
    verified: after === nextText,
    size: Buffer.byteLength(after, 'utf8'),
    lines: after.split('\n').length,
  }
}

/**
 * 删除。同样三道闸：
 *   ① expectedVersion 与磁盘现状对不上就中止
 *   ② 删前整份备份到 backups/（文件名带 deleted 标记，和覆盖式备份分开）
 *   ③ 删后核验文件真的不在了
 * 注入层 AGENTS.md 不给删：它是每轮注入的根，删掉整个设定就没了。
 */
export function remove(abs, { expectedVersion } = {}) {
  if (abs === AGENTS_FILE) {
    throw new Error('拒绝：AGENTS.md 是每轮注入的设定，不能删除。要改它请直接编辑正文。')
  }
  if (!existsSync(abs)) throw new Error(`文件不存在：${relPath(abs)}`)
  const before = readFileSync(abs, 'utf8')
  const current = hash(before)
  if (expectedVersion && current !== expectedVersion) {
    throw new Error(
      `中止：${relPath(abs)} 在你看过之后被改动过（磁盘上是 ${current}，你手上的是 ${expectedVersion}）。请重新读取再试。`,
    )
  }
  mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backup = join(BACKUP_DIR, `${stamp}__deleted__${relPath(abs).replace(/[\\/]/g, '_')}`)
  writeFileSync(backup, before, 'utf8')
  unlinkSync(abs)
  return {
    path: relPath(abs),
    removed: true,
    beforeVersion: current,
    removedBytes: Buffer.byteLength(before, 'utf8'),
    backup: relative(DSH_HOME, backup).split(sep).join('/'),
    gone: !existsSync(abs),
  }
}

/**
 * 删掉一份已经用不上的备份 —— 只在用户明确说「这版没问题」之后调。
 *
 * 保守到近乎刻薄：只认 BACKUP_DIR 正下方直接躺着的普通文件。传进来的路径会先
 * 剥成文件名（所以 `memory-refine-backups/x.md`、`x.md`、绝对路径都行），再拼回
 * BACKUP_DIR 下；解析完的绝对路径必须还落在这一个目录里，否则拒绝。
 */
export function dropBackup(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('没给备份文件名。')
  // 传了带目录的形式（`memory-refine-backups/x.md` 或绝对路径）时，先看它原本指
  // 哪儿：只要不在备份目录里，直接拒绝，别让「删备份」变成删别的东西。
  if (/[\\/]/.test(raw)) {
    const target = resolve(DSH_HOME, raw)
    const root = resolve(BACKUP_DIR)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('拒绝：只允许删备份目录下的文件。')
    }
  }
  const name = basename(raw)
  const abs = join(BACKUP_DIR, name)
  if (resolve(abs) !== join(resolve(BACKUP_DIR), name)) {
    throw new Error('拒绝：只允许删备份目录下直接躺着的文件。')
  }
  if (!existsSync(abs)) return { dropped: false, name, reason: '文件已经不在了（可能之前删过）' }
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('拒绝：那不是普通文件。')
  unlinkSync(abs)
  return { dropped: true, name, bytes: st.size }
}

function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) return null
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i], oldLine: i + 1, newLine: j + 1 })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ op: '-', text: a[i], oldLine: i + 1, newLine: null })
      i++
    } else {
      out.push({ op: '+', text: b[j], oldLine: null, newLine: j + 1 })
      j++
    }
  }
  while (i < n) out.push({ op: '-', text: a[i], oldLine: ++i, newLine: null })
  while (j < m) out.push({ op: '+', text: b[j], oldLine: null, newLine: ++j })
  return out
}

/** 给人看的 diff：变化行 ±3 行上下文，中间折叠，最长 6000 字符。 */
export function diffSummary(before, after, { context = 3, maxChars = 6000 } = {}) {
  const a = before.split('\n')
  const b = after.split('\n')
  const rows = lcsDiff(a, b)
  const added = rows ? rows.filter((r) => r.op === '+').length : 0
  const removed = rows ? rows.filter((r) => r.op === '-').length : 0
  if (!rows) {
    return { text: `（文件过大，跳过逐行对比）${a.length} 行 → ${b.length} 行`, added, removed }
  }
  const keep = new Set()
  rows.forEach((r, k) => {
    if (r.op === ' ') return
    for (let d = -context; d <= context; d++) keep.add(k + d)
  })
  const lines = []
  let last = -2
  let truncated = false
  rows.forEach((r, k) => {
    if (!keep.has(k)) return
    if (k > last + 1) lines.push('      ⋮')
    const no = String(r.oldLine ?? r.newLine ?? '').padStart(5)
    lines.push(`${r.op}${no} │ ${r.text}`)
    last = k
  })
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n…（diff 太长，已截断）'
    truncated = true
  }
  return { text, added, removed, truncated }
}
