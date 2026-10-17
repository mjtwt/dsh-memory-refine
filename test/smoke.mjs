/**
 * 离线冒烟测试 —— 不需要启动 DSH，也不会碰你真实的记忆文件。
 *
 * 做法：用一个假的 ctx 加载 Host 半边（index.js），拦住它注册的 HTTP 路由，
 * 然后直接调那个路由处理器。DSH_HOME 指向系统临时目录下的沙盒，跑完即删。
 *
 *   node test/smoke.mjs
 *
 * 它验的是「一改就整块坏」的地方：四道闸（方法 / 内容类型 / 鉴权 / 路由匹配）、
 * 白名单越界、以及三道闸里最难手动复现的分支 —— 版本不符时中止、读回核验、
 * 备份真的生成了。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/* ------------------------------------------------------------ 沙盒 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'memory-refine-smoke-'))
process.env.DSH_HOME = SANDBOX

mkdirSync(join(SANDBOX, 'memory', 'archive'), { recursive: true })
writeFileSync(join(SANDBOX, 'AGENTS.md'), '# 注入层\n\n沙盒。\n', 'utf8')
writeFileSync(join(SANDBOX, 'memory', 'index.md'), '# 索引\n\n- 示例主题\n', 'utf8')
// 故意用中文文件名：这是这个插件真实的使用场景，也顺带验一遍非 ASCII 路径
writeFileSync(join(SANDBOX, 'memory', '示例主题.md'), '# 示例主题\n\n占位正文。\n', 'utf8')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

/* ------------------------------------------------ 假 ctx / 假 webServer */

let route = null
let rejectionCode
const dispatchers = []

function makeWebCtx(ctx) {
  return {
    webServer: {
      port: 0,
      register(r) {
        route = r
        return () => {
          route = null
        }
      },
    },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    get: (name) => ctx.get(name),
  }
}

function makeCtx() {
  const ctx = {
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    skills: { register: () => () => {} },
    commands: { register: (def) => { ctx.__command = def; return () => {} } },
    tools: { register: () => () => {} },
    logger: { warn() {}, error() {}, info() {} },
    get(name) {
      if (name === 'connection') {
        return { requestRejection: () => rejectionCode }
      }
      if (name === 'agents') {
        return { get: () => ({ id: 'smoke-session' }) }
      }
      return undefined
    },
    inject(names, cb) {
      const webCtx = makeWebCtx(ctx)
      dispatchers.push(() => cb(webCtx))
      return () => {}
    },
  }
  return ctx
}

/* ------------------------------------------------------------ 加载插件 */

const ctx = makeCtx()
const mod = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)
mod.apply(ctx)
dispatchers.forEach((d) => d())

check('注册了一条 route', route !== null)
check('route.kind 是 prefix', route?.kind === 'prefix', String(route?.kind))
check('route.path 不带尾斜杠', route?.path === '/memory-refine', String(route?.path))
check(
  '导出的 inject 不含 webServer/connection',
  !mod.inject.includes('webServer') && !mod.inject.includes('connection'),
  mod.inject.join(','),
)

/* ------------------------------------------------------- 假 req / 假 res */

function makeReq({ method = 'POST', url = '/memory-refine/ui', headers = {}, body = null }) {
  const chunks = body === null
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  let i = 0
  return {
    method,
    url,
    headers,
    resume() {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      while (i < chunks.length) yield chunks[i++]
    },
  }
}

function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers || null
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
    },
  }
  return res
}

async function call(opts) {
  const res = makeRes()
  await route.handler(makeReq(opts), res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { res, json }
}

const JSON_HEADERS = {
  host: '127.0.0.1:19387',
  'content-type': 'application/json',
  origin: 'dsh-app://app',
}

/* ---------------------------------------------------------------- 用例 */

try {
  // 1) 只认 POST
  {
    const { res } = await call({ method: 'GET', headers: JSON_HEADERS })
    check('GET /ui → 405', res.status === 405, String(res.status))
  }

  // 2) 只认已知子路径
  {
    const { res } = await call({ method: 'POST', url: '/memory-refine/nope', headers: JSON_HEADERS, body: {} })
    check('未知子路径 → 404', res.status === 404, String(res.status))
  }

  // 3) 只认 JSON（跨站简单请求也被这一条挡住）
  {
    const { res } = await call({
      method: 'POST',
      headers: { host: '127.0.0.1:19387', 'content-type': 'text/plain' },
      body: '{"action":"list"}',
    })
    check('text/plain → 415', res.status === 415, String(res.status))
  }

  // 4) 鉴权拒绝要原样透传
  {
    rejectionCode = 403
    const { res, json } = await call({ method: 'POST', headers: JSON_HEADERS, body: { action: 'list' } })
    check(
      'rejection=403 → 403 且给出原因',
      res.status === 403 && /鉴权层拒绝/.test(json?.error ?? ''),
      `${res.status} ${json?.error ?? ''}`,
    )
    rejectionCode = undefined
  }

  // 5) list
  {
    const { res, json } = await call({ method: 'POST', headers: JSON_HEADERS, body: { action: 'list', sessionId: 'smoke-session' } })
    const ok = res.status === 200 && json?.ok === true && Array.isArray(json.data?.files)
    check('POST list → 200 且列出文件', ok, `${res.status} files=${json?.data?.files?.length}`)
  }

  // 6) read
  let version
  {
    const { res, json } = await call({ method: 'POST', headers: JSON_HEADERS, body: { action: 'read', path: 'memory/示例主题.md' } })
    const ok = res.status === 200 && json?.ok === true && typeof json.data?.text === 'string' && json.data.version
    check('POST read → 200 且带正文与版本', ok, `${res.status} version=${json?.data?.version}`)
    version = json?.data?.version
  }

  // 7) 白名单越界
  {
    const { res, json } = await call({ method: 'POST', headers: JSON_HEADERS, body: { action: 'read', path: '../../etc/passwd' } })
    check('越界路径 → 200 且 ok:false', res.status === 200 && json?.ok === false, `${res.status} ${String(json?.error).slice(0, 40)}`)
  }

  // 8) 未知 action
  {
    const { res, json } = await call({ method: 'POST', headers: JSON_HEADERS, body: { action: 'nope' } })
    check('未知 action → ok:false', res.status === 200 && json?.ok === false && /未知 action/.test(json.error ?? ''), String(json?.error))
  }

  // 9) 正常写入：版本预检 + 备份 + 读回核验
  {
    const { res, json } = await call({
      method: 'POST',
      headers: JSON_HEADERS,
      body: { action: 'write', path: 'memory/示例主题.md', text: '# 示例主题\n\n冒烟测试写入。\n', expectedVersion: version },
    })
    check(
      'POST write → 写入成功且读回核验',
      res.status === 200 && json?.ok === true && json.data?.verified === true,
      JSON.stringify(json?.data?.version || json?.error),
    )
    const backups = existsSync(join(SANDBOX, 'memory-refine-backups'))
      ? readdirSync(join(SANDBOX, 'memory-refine-backups'))
      : []
    check('write 生成了备份文件', backups.length > 0, backups.join(','))
  }

  // 10) 版本不符：中止，一个字节都不写
  {
    const { json } = await call({
      method: 'POST',
      headers: JSON_HEADERS,
      body: { action: 'write', path: 'memory/示例主题.md', text: '陈旧内容\n', expectedVersion: 'deadbeefdeadbeef' },
    })
    check('陈旧版本 → 被预检拦下', json?.ok === false && /被改动过/.test(json.error ?? ''), String(json?.error).slice(0, 50))
  }

  // 11) 导入：章节之间只空一行
  {
    const { res, json } = await call({
      method: 'POST',
      headers: JSON_HEADERS,
      body: { action: 'import', target: 'memory/index.md', title: '导入测试', text: '第一段\n\n第二段', mode: 'section' },
    })
    check('POST import(section) → 成功', res.status === 200 && json?.ok === true, JSON.stringify(json?.error || json?.data?.version))
    const text = readFileSync(join(SANDBOX, 'memory', 'index.md'), 'utf8')
    check('import 后章节间距只空一行', /^# 索引\n\n- 示例主题\n\n## 导入测试\n\n第一段\n\n第二段\n$/.test(text), JSON.stringify(text))
  }

  // 12) 删除：先备份再删，备份名带 __deleted__
  {
    writeFileSync(join(SANDBOX, 'memory', 'archive', '旧条目.md'), '# 旧条目\n\n该退休了。\n', 'utf8')
    const { res, json } = await call({
      method: 'POST',
      headers: JSON_HEADERS,
      body: { action: 'delete', path: 'memory/archive/旧条目.md' },
    })
    check('POST delete → 成功且核验已消失', res.status === 200 && json?.ok === true && json.data?.gone === true, JSON.stringify(json?.error || json?.data?.backup))
    check('delete 的备份名带 __deleted__', String(json?.data?.backup ?? '').includes('__deleted__'), String(json?.data?.backup))
    check('delete 后文件确实不在了', !existsSync(join(SANDBOX, 'memory', 'archive', '旧条目.md')))
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

/* ---------------------------------------------------------------- 汇总 */

const failed = results.filter((r) => !r.ok)
console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`)
  process.exit(1)
}
