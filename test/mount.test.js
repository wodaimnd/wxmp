/**
 * 装载契约测试 —— 专门盯 0.1.0 那个「工具能用、面板打不开」的故障。
 *
 * 为什么单独立一个文件：原来的 plugin.test.js 造的假 ctx 里**根本没有 webServer**，
 * ui.test.js 又自己起 http server 直接测 createUiHandler，于是
 * 「apply() 到底有没有把 /api/wxmp 挂上去」这件事从来没被断言过 ——
 * 51 个用例全绿，真机面板照样空白。这个文件补的就是那一条。
 *
 * 五条断言，每条都能在代码退回旧写法时失败：
 *  1. 模块级 inject 必须是空数组（写成 ['tools'] 就等于给 webServer 上了闸门）；
 *  2. apply() 在 ctx 同时有 tools 与 webServer 时，必须真的挂上 ROUTE；
 *  3. 缺 webServer 时只降级面板，工具照常注册（不能整体消失）；
 *  4. 缺 tools 时只降级工具，面板路由照常挂；
 *  5. 面板 op 白名单必须覆盖 client.js 实际发出的每个 op。
 *
 * 隔离：测试自己造临时 DSH/WXMP 目录，绝不写真实的 %LOCALAPPDATA%\wxmp\logs。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const pluginDir = path.join(root, 'dsh-plugin')

/* ── 隔离：临时状态目录，且必须在 import 插件之前设好 ─────────────── */
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wxmp-mount-'))
if (!tmpBase.includes('wxmp-mount-')) throw new Error('测试目录没有落在临时区，拒绝运行')
process.env.WXMP_HOME = path.join(tmpBase, 'wxmp-home')
fs.mkdirSync(process.env.WXMP_HOME, { recursive: true })

const plugin = await import('../dsh-plugin/index.js')
const { ROUTE, UI_OPERATIONS } = await import('../dsh-plugin/ui-backend.js')

test.after(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

/**
 * 造一个尽量像 Cordis 的假 ctx。
 * 关键：模块级 `inject` 是**全有全无的闸门** —— 它非空时，没列进去的服务
 * 在 apply() 里就拿不到（连 ctx.inject(['webServer']) 也只会收到 undefined）。
 * 这里必须照着这个语义造假 ctx，否则测不出「inject 只写 tools → 路由静默不挂」。
 */
function makeCtx({ withTools = true, withWebServer = true } = {}) {
  const gate = Array.isArray(plugin.inject) && plugin.inject.length > 0 ? plugin.inject : null
  const toolsAllowed = withTools && (!gate || gate.includes('tools'))
  const webAllowed = withWebServer && (!gate || gate.includes('webServer'))

  const tools = []
  const routes = []
  const injectCalls = []
  const toolsApi = {
    register(tool) {
      tools.push(tool)
      return () => tools.splice(tools.indexOf(tool), 1)
    },
  }
  const webServerApi = {
    exact: { has: () => false },
    register(route) {
      routes.push(route)
      return () => routes.splice(routes.indexOf(route), 1)
    },
  }
  const effect = (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  }
  const base = {
    effect,
    inject(list, cb) {
      injectCalls.push(list.slice())
      const scoped = { effect }
      // 闸门关着的服务，作用域里也拿不到
      if (list.includes('tools')) scoped.tools = toolsAllowed ? toolsApi : undefined
      if (list.includes('webServer')) scoped.webServer = webAllowed ? webServerApi : undefined
      cb(scoped)
      return () => {}
    },
    logger: { warn() {}, error() {}, info() {} },
    systemPrompt: { section() { return () => {} } },
  }
  if (toolsAllowed) base.tools = toolsApi
  if (webAllowed) base.webServer = webServerApi
  base.__state = { tools, routes, injectCalls, gate, toolsAllowed, webAllowed }
  return base
}

test('模块级 inject 必须是空数组：写了 tools 就把 webServer 挡在外面', () => {
  assert.deepEqual(plugin.inject, [], 'inject 必须是 [] —— 依赖由各功能块自己 ctx.inject 声明')
})

test('apply() 真的把 /api/wxmp 挂上了（这是旧测试漏掉的那一条）', () => {
  const ctx = makeCtx()
  assert.equal(ctx.__state.webAllowed, true, '假 ctx 没能提供 webServer，测不出装载')
  plugin.apply(ctx, { stateDir: process.env.WXMP_HOME })
  const mounted = ctx.__state.routes.filter((r) => r && r.path === ROUTE)
  // 0.4.1 起同时注册 exact + prefix：exact 管 POST 白名单，prefix 兜住 /cover 的 GET。
  // 少了 prefix 的话 GET /api/wxmp/cover 根本到不了 handler（真机表现：封面一直是空框）。
  const exact = mounted.filter((r) => r.kind === 'exact')
  const prefix = mounted.filter((r) => r.kind === 'prefix')
  assert.equal(exact.length, 1, `应当恰好一条 exact ${ROUTE}，实到 ${exact.length}`)
  assert.equal(prefix.length, 1, `应当恰好一条 prefix ${ROUTE}（否则 /cover 取不到），实到 ${prefix.length}`)
  assert.equal(typeof exact[0].handler, 'function')
  assert.equal(typeof prefix[0].handler, 'function')
  assert.equal(ctx.__state.tools.length, 1)
  assert.equal(ctx.__state.tools[0].name, 'wxmp')
  // 两条功能块各自声明依赖，而不是合成一个全有闸门
  const lists = ctx.__state.injectCalls.map((l) => l.join('+'))
  assert.ok(lists.includes('tools'), '工具块应单独 ctx.inject(["tools"])')
  assert.ok(lists.includes('webServer'), '面板块应单独 ctx.inject(["webServer"])')
})

test('缺 webServer 只降级面板：工具照常注册，且落了可复盘的记录', () => {
  const ctx = makeCtx({ withWebServer: false })
  plugin.apply(ctx, { stateDir: process.env.WXMP_HOME })
  assert.equal(ctx.__state.tools.length, 1, '缺 webServer 时工具必须仍然注册')
  assert.equal(ctx.__state.routes.length, 0)
  const mount = path.join(process.env.WXMP_HOME, 'logs', 'mount-state.json')
  assert.ok(fs.existsSync(mount), '没挂上也必须留下 mount-state.json，否则只能靠复现')
  const state = JSON.parse(fs.readFileSync(mount, 'utf8'))
  assert.equal(state.mounted, false)
  assert.match(state.reason, /webServer/)
  assert.equal(state.route, ROUTE)
})

test('缺 tools 只降级工具：面板路由照常挂', () => {
  const ctx = makeCtx({ withTools: false })
  plugin.apply(ctx, { stateDir: process.env.WXMP_HOME })
  const mounted = ctx.__state.routes.filter((r) => r.path === ROUTE)
  assert.equal(mounted.filter((r) => r.kind === 'exact').length, 1, '缺 tools 时 POST 路由仍须存在')
  assert.equal(mounted.filter((r) => r.kind === 'prefix').length, 1, '缺 tools 时 /cover 的 prefix 路由仍须存在')
})

test('挂上后写 mount-state.json，并且真能应答一次 health/list-articles', async () => {
  const ctx = makeCtx()
  plugin.apply(ctx, { stateDir: process.env.WXMP_HOME })
  const handler = ctx.__state.routes.find((r) => r.path === ROUTE).handler

  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }
  try {
    const health = await post({ op: 'health' })
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    assert.equal(health.json.data.route, ROUTE)
    assert.ok(Array.isArray(health.json.data.ops) && health.json.data.ops.length >= 5)
    assert.ok(health.json.data.cliPath, 'health 必须报出 CLI 入口，否则面板无从判断缺什么')

    const listed = await post({ op: 'list-articles' })
    assert.equal(listed.json.ok, true, listed.json.text)

    const logs = await post({ op: 'logs', params: { lines: 10 } })
    assert.equal(logs.json.ok, true)
    assert.ok(logs.json.data.file.endsWith('plugin.log'), '日志文件路径必须报给面板')

    const mount = path.join(process.env.WXMP_HOME, 'logs', 'mount-state.json')
    const state = JSON.parse(fs.readFileSync(mount, 'utf8'))
    assert.equal(state.mounted, true)
    assert.equal(state.reason, '本插件注册成功')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('client.js 发出的每个 op 都在后端白名单里', () => {
  const src = fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8')
  const used = new Set()
  const re = /\bapi\(\s*'([a-z][a-z0-9-]*)'/g
  let m
  while ((m = re.exec(src))) used.add(m[1])
  assert.ok(used.size >= 5, `应当至少扫到 5 个 op，实际 ${used.size}`)
  for (const op of used) {
    assert.ok(UI_OPERATIONS.includes(op), `面板用了后端不认的 op：${op}`)
  }
})

/**
 * 面板作用域安全：这条是拿真实故障换来的。
 *
 * 2026-11-05 实测崩溃：`ReferenceError: Cannot access 'refreshPresets' before initialization`
 * → `slot entry crashed in 'main'`，整个面板白屏。
 * 原因：`useEffect(fn, [refreshPresets])` 的**依赖数组在执行到该行时立即求值**，
 * 而 refreshPresets 是下面几十行才声明的 const —— 暂时性死区。
 *
 * 语法检查（node --check）和「op 白名单」都发现不了这种错误，所以必须单独断言。
 */
test('面板 useEffect 的依赖数组不得提前引用后面的 const（TDZ 白屏）', () => {
  const src = fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8')
  const lines = src.split('\n')

  // 收集所有 const X = ... 的定义行（本地作用域内的声明）
  const definedAt = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s+const ([A-Za-z_$][\w$]*)\s*=/.exec(lines[i])
    if (m) definedAt.set(m[1], i + 1)
  }

  const problems = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/useEffect\(/.test(lines[i])) continue
    // 找到这个 useEffect 的依赖数组行
    for (let j = i; j < Math.min(i + 80, lines.length); j += 1) {
      const depMatch = /^\s*\}, \[([^\]]*)\]\)\s*$/.exec(lines[j])
      if (!depMatch) continue
      const deps = depMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
      for (const dep of deps) {
        const at = definedAt.get(dep)
        // 依赖数组在 L(j+1) 立即求值，所以被引用的 const 必须在它之前就已声明
        if (at && at > j + 1) {
          problems.push(`useEffect@L${i + 1} 依赖 ${dep}（声明在 L${at}，晚于 L${j + 1}）`)
        }
      }
      break
    }
  }
  assert.deepEqual(problems, [], `以下几点会触发 TDZ 白屏：\n${problems.join('\n')}`)
})

test('面板只 require react，且 slots 注册可回收（禁用后不留残留）', () => {
  const src = fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8')
  // require 了宿主没提供的模块 = 加载期直接崩
  const required = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
  assert.deepEqual(required, ['react'], `面板只能 require react，实际：${required.join(', ')}`)
  // 注册必须包在 ctx.effect 里，否则热重载/禁用会留下僵尸注册
  const effects = (src.match(/ctx\.effect\(/g) || []).length
  assert.ok(effects >= 2, `slots 注册应包在 ctx.effect 内，实际只有 ${effects} 处`)
  // 样式不允许在模块顶层注入（会导致刷新闪一下再消失）
  const beforeApply = src.split('apply(')[0]
  assert.ok(!beforeApply.includes('document.head.appendChild'), '样式必须在 apply() 内注入')
  // panellist 的 id 与 main 的 key 必须是同一个值，否则点进去空白
  assert.match(src, /name:\s*'sidebar\.panellist',\s*id:\s*PANEL_ID/)
  assert.match(src, /name:\s*'main',\s*key:\s*PANEL_ID/)
})

test('面板后端与工具共用同一条串行队列（并发不踩 front matter）', () => {
  const src = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8')
  assert.ok(!/runUiCli/.test(src), '不能再有绕开队列的 runUiCli')
  const callSite = src.indexOf('runCli: enqueue')
  assert.ok(callSite > -1, 'UI 后端必须把 runCli 指向 enqueue')
  assert.ok(src.indexOf('queue = queue.then(run, run)') < callSite, 'enqueue 必须先于 handler 构造定义')
})

test('manifest 与 DEFAULTS / patch 三方对齐', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  // exports 里写的文件必须真实存在
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (typeof target !== 'string' || target.includes('*')) continue
    assert.ok(fs.existsSync(path.join(pluginDir, target)), `exports ${sub} 指向的文件不存在：${target}`)
  }
  // 副作用必须声明全：这个插件确实会起子进程、写文件、联网、读环境变量
  const effects = (pkg.dsh.forge && pkg.dsh.forge.effects) || []
  assert.ok(effects.some((e) => e.startsWith('child:')), '要声明起子进程')
  assert.ok(effects.some((e) => e.startsWith('fs:write')), '要声明写文件')
  assert.ok(effects.some((e) => e.startsWith('net:loopback')), '要声明本机路由')
  assert.ok(effects.some((e) => e.startsWith('env:read')), '要声明读环境变量')

  // patch 的 config 键必须与 DEFAULTS 一致（不一致时以 patch 为实际装载值）
  const patch = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(!patch.includes('\t'), 'patch 里出现 Tab 会直接语法失败')
  // 只取「id: wxmp」那一条装载行的 config 块：文件里还有第二条装载行（技能发现），
  // 它的 config 键是它自己的，混进来比就会假失败。
  const wxmpRow = patch.split(/^\s*- id: /m).find((chunk) => chunk.startsWith('wxmp\n') || chunk.startsWith('wxmp\r\n'))
  assert.ok(wxmpRow, 'cordis.patch.yml 里找不到 id: wxmp 的装载行')
  const patchKeys = [...wxmpRow.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((m) => m[1]).sort()
  const defaultKeys = Object.keys(plugin.DEFAULTS).sort()
  assert.deepEqual(patchKeys, defaultKeys, 'cordis.patch.yml 里 id: wxmp 的 config 必须与 index.js 的 DEFAULTS 逐字一致')
})

/**
 * 技能发现行的存在性契约。
 *
 * 为什么必须断言：`skills/` 目录躺在包里面**不会**自动进会话技能目录 ——
 * 少了 `@deepseek-ai/dsh-skill-filesystem` 这一行，磁盘上有、目录里没有、
 * 模型永远看不到，而且**不报任何错**（「装了没反应」就是这么来的）。
 * 这条断言让「有人删掉/改坏技能行」在 CI 里当场失败，而不是等到用户发现 AI 不会用。
 */
test('技能发现行必须在：少了它 skills/ 就是死文件且不报错', () => {
  const patch = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8')
  const skillRow = patch.split(/^\s*- id: /m).find((chunk) => chunk.startsWith('wxmp-skills'))
  assert.ok(skillRow, 'cordis.patch.yml 缺少 wxmp-skills 装载行：skills/ 将不会进会话技能目录')
  assert.match(skillRow, /name:\s*'@deepseek-ai\/dsh-skill-filesystem'/, '技能行必须装载 dsh-skill-filesystem')
  assert.match(skillRow, /providerName:\s*wxmp-plugin/, 'providerName 必须是 wxmp-plugin（与其它插件区分）')
  // bundledSkillDir 必须从安装位置推导，不能写死本机路径
  assert.match(skillRow, /bundledSkillDir:\s*!!js/, 'bundledSkillDir 必须是 !!js 表达式（从 baseUrl 推导）')
  assert.ok(!/[A-Za-z]:[\\/]/.test(skillRow.split('bundledSkillDir')[1] || ''), 'bundledSkillDir 不能写死盘符路径')
  // package.json 的 files 必须带上 skills，否则发布出去的包里没有这本手册
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  assert.ok((pkg.files || []).includes('skills'), 'package.json 的 files 必须包含 skills')
  // SKILL.md 本体与 references 必须真实存在
  const skillDir = path.join(pluginDir, 'skills', 'wxmp')
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'skills/wxmp/SKILL.md 不存在')
})

/**
 * F25 回归防线：文档计数与 op 清单必须跟代码同源。
 * 1.8.1 窗口里 OPERATIONS 涨到 42（article_preset_prompt、article_delete），
 * 但 SKILL.md 的「速查（41 个）」与 operations.md 的表都没跟上——
 * 文档撒谎比没文档更糟：模型按文档找 `article_delete` 会以为它不存在。
 * 这条断言让「加 op 忘改文档」当场红，而不是等用户排错时查不到。
 */
test('SKILL.md 与 operations.md 的 op 计数/清单必须与 OPERATIONS 一致', () => {
  const skill = fs.readFileSync(path.join(pluginDir, 'skills', 'wxmp', 'SKILL.md'), 'utf8')
  const opsDoc = fs.readFileSync(path.join(pluginDir, 'skills', 'wxmp', 'references', 'operations.md'), 'utf8')
  const n = plugin.OPERATIONS.length

  // ① SKILL.md 的「operation 速查（N 个）」必须等于 OPERATIONS.length
  const speed = skill.match(/operation 速查（(\d+) 个）/)
  assert.ok(speed, 'SKILL.md 缺少「operation 速查（N 个）」行')
  assert.equal(Number(speed[1]), n, `SKILL.md 速查计数 ${speed[1]} ≠ OPERATIONS.length ${n}`)
  // ② SKILL.md 别处引用的「operations.md（N 项）」同步
  const ref = skill.match(/`operations\.md`（(\d+) 项/)
  assert.ok(ref, 'SKILL.md 缺少对 operations.md 的计数引用')
  assert.equal(Number(ref[1]), n, `SKILL.md 引用 operations.md 的计数 ${ref[1]} ≠ ${n}`)
  // ③ operations.md 标题计数同步
  const title = opsDoc.match(/^# operation 全表（(\d+) 个）/m)
  assert.ok(title, 'operations.md 缺少「# operation 全表（N 个）」标题')
  assert.equal(Number(title[1]), n, `operations.md 标题计数 ${title[1]} ≠ ${n}`)
  // ④ 表格里必须出现每一个 op（`| \`op_name\` |` 行）
  for (const op of plugin.OPERATIONS) {
    // 反引号在模板串里会提前终止字符串，这里用拼接避开
    assert.ok(
      new RegExp('^\\| `' + op + '` \\|', 'm').test(opsDoc),
      `operations.md 的表格里没有 ${op} 这一行（加 op 忘补文档）`,
    )
  }
})

/**
 * F27 回归防线（补上一条断言的两处覆盖缺口）：
 *
 * ① 上一条只管 op 清单，**不管错误码**。`article_delete` 的五个码里
 *    `article_delete_failed` 走的是 `fail()` 而不是 `taggedError()`，
 *    最容易被人改名字或从文档里漏掉——用户排错时查不到码义。
 * ② 上一条第 ④ 项是**单向包含**（OPERATIONS ⊆ 表格），
 *    文档里多出一行根本不存在的 op 不会红。这里对 op 表做双向差集。
 *
 * 只扫 op 表那几节：operations.md 末尾「## 工具层自己会报的错」是**有意**
 * 列工具层码（invalid_params / unknown_operation / cli_not_found / timeout），
 * 不把它们算进 op 集，否则双向比对会假失败。
 */
const DELETE_ERROR_CODES = [
  'article_missing_arg',
  'article_path_invalid',
  'article_not_md',
  'article_not_found',
  'article_delete_failed',
]

test('article_delete 的五个错误码：代码与 troubleshooting.md 必须双向一致', () => {
  const uiSrc = fs.readFileSync(path.join(pluginDir, 'ui-backend.js'), 'utf8')
  const trouble = fs.readFileSync(
    path.join(pluginDir, 'skills', 'wxmp', 'references', 'troubleshooting.md'),
    'utf8',
  )

  // ① 每个码都必须在代码里真实存在（改名会在这里红）
  for (const code of DELETE_ERROR_CODES) {
    assert.ok(uiSrc.includes(`'${code}'`), `ui-backend.js 里没有 ${code} 这个码`)
  }

  // ② 取「## 删除文章」一节里表格首列的码，与契约集**双向**比对
  const section = trouble.split(/^## /m).find((chunk) => chunk.startsWith('删除文章'))
  assert.ok(section, 'troubleshooting.md 缺少「## 删除文章」一节')
  // 只认首列就是码的行：`| \`article_xxx\` |`，行内其它位置的反引号不算
  const docCodes = [...section.matchAll(/^\| `(article_[a-z_]+)` \|/gm)].map((m) => m[1])
  assert.deepEqual(
    [...docCodes].sort(),
    [...DELETE_ERROR_CODES].sort(),
    `troubleshooting.md「删除文章」一节的码与契约不一致（文档: ${docCodes.join(', ')}）`,
  )
})

test('operations.md 的 op 表与 OPERATIONS 必须双向一致（文档不得多出不存在的 op）', () => {
  const opsDoc = fs.readFileSync(path.join(pluginDir, 'skills', 'wxmp', 'references', 'operations.md'), 'utf8')
  // 剔掉「工具层自己会报的错」那一节——那四个码是有意列的，不是 op
  const opSections = opsDoc
    .split(/^## /m)
    .filter((chunk) => !chunk.startsWith('工具层自己会报的错'))
    .join('\n')
  const docOps = [...opSections.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1])
  const real = new Set(plugin.OPERATIONS)
  const extra = [...new Set(docOps)].filter((op) => !real.has(op))
  assert.deepEqual(extra, [], `operations.md 的 op 表里有不存在的 operation：${extra.join(', ')}`)
  const missing = plugin.OPERATIONS.filter((op) => !docOps.includes(op))
  assert.deepEqual(missing, [], `operations.md 的 op 表里缺这些 operation：${missing.join(', ')}`)
})

test('日志把 argv 里的 secret 打码（真机上漏过一次：明文落进 plugin.log）', async () => {
  const { createLogger, maskSecrets } = await import('../dsh-plugin/logger.js')
  const secret = 'b54e4ca229bc5269fc3d7a5e8cadfb6c'
  const appid = 'wxd6e80122df18dbc6'

  const masked = maskSecrets(`op config set {"argv":"config set --appid ${appid} --secret ${secret}"}`)
  assert.ok(!masked.includes(secret), 'maskSecrets 没打掉 --secret 后面的值')
  assert.ok(!masked.includes(appid), 'appid 只该留前 4 位')
  assert.match(masked, /--secret \*\*\*\*/)

  const dir = path.join(tmpBase, 'logtest')
  const log = createLogger({ dir: () => dir, tag: 'wxmp' })
  log.info('op config set', { argv: `config set --appid ${appid} --secret ${secret}` })
  const text = fs.readFileSync(path.join(dir, 'plugin.log'), 'utf8')
  assert.ok(!text.includes(secret), 'secret 明文落盘了')
  assert.ok(!text.includes(appid), '完整 appid 不该落盘')
  assert.match(text, /op config set/, '打码不能把整行吞掉，复盘还得看得见调了什么')
})
