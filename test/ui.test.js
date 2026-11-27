/**
 * UI 后端与客户端契约测试。
 *
 * 覆盖三件容易悄悄坏掉的事：
 *  1. 面板只被允许调用白名单操作（不能借道去调 config set 之外的危险参数）；
 *  2. 文章路径不能穿越出文章目录；
 *  3. 返回形状与 CLI --json 一致，UI 能直接消费。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

const { buildUiArgv, resolveInsideArticleDir, openArticleFile, createUiHandler, ROUTE } = await import('../dsh-plugin/ui-backend.js')

test('白名单：每个操作都映射到确定的 CLI 子命令', () => {
  assert.deepEqual(buildUiArgv('list-articles', {}).argv, ['article', 'list'])
  assert.deepEqual(buildUiArgv('check-article', { file: 'a.md' }).argv, ['article', 'check', '--file', 'a.md'])
  // 面板也要能拿体检结果（分数 + 带行号的改法）
  assert.deepEqual(buildUiArgv('review-article', { file: 'a.md' }).argv, ['article', 'review', '--file', 'a.md'])
  assert.deepEqual(buildUiArgv('draft-create', { file: 'a.md' }).argv, ['draft', 'create', '--file', 'a.md'])
  assert.deepEqual(buildUiArgv('publish-submit', { mediaId: 'm' }).argv, [
    'publish',
    'submit',
    '--media-id',
    'm',
    '--yes',
  ])
  assert.deepEqual(buildUiArgv('cover', { file: 'a.md', badge: 'X' }).argv, ['cover', '--file', 'a.md', '--badge', 'X'])

  // 未知操作一律拒绝，不做「猜一个最近的命令」
  assert.equal(buildUiArgv('shell', {}), null)
  assert.equal(buildUiArgv('rm', {}), null)
  assert.equal(buildUiArgv('config-set-secret', {}), null)
})

test('路径穿越与后缀都挡住', () => {
  const dir = path.join(root, '.ui-test-articles')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(resolveInsideArticleDir(dir, 'ok.md'), path.join(dir, 'ok.md'))
  for (const bad of ['../escape.md', 'C:/Windows/x.md', 'note.txt', '']) {
    assert.throws(() => resolveInsideArticleDir(dir, bad), /只能|只支持|缺少/)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('1.8.1：预览透传 open，快捷打开是不落 argv 的本地 op', () => {
  // 快捷预览：open:true 必须落到 CLI 的 --open，否则「打开本地预览」只生成不打开
  assert.deepEqual(buildUiArgv('preview-article', { file: 'a.md', open: true }).argv, [
    'article',
    'preview',
    '--file',
    'a.md',
    '--open',
  ])
  // 老调用方不带 open，argv 保持原样
  assert.deepEqual(buildUiArgv('preview-article', { file: 'a.md' }).argv, ['article', 'preview', '--file', 'a.md'])

  // open-article 是本地 op：不拼 argv，判定与打开都在 handler 里做
  const folder = buildUiArgv('open-article', { file: 'a.md', what: 'folder' })
  assert.equal(folder.local, true)
  assert.deepEqual(folder.argv, [])
  assert.deepEqual(folder.openArticle, { what: 'folder' })
  // what 白名单：只认 folder，其余（含缺省）一律按 file 打开
  assert.deepEqual(buildUiArgv('open-article', { file: 'a.md', what: 'nope' }).openArticle, { what: 'file' })
  assert.deepEqual(buildUiArgv('open-article', { file: 'a.md' }).openArticle, { what: 'file' })
})

test('1.8.1：openArticleFile 判定链走完才碰系统打开', () => {
  const dir = path.join(root, '.ui-test-open')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'ok.md'), '# ok\n', 'utf8')
  const calls = []
  const shellOpen = (target, what) => calls.push({ target, what })
  const open = (what, file) => openArticleFile(dir, file, { what, shellOpen })

  // 正常：文件存在且在目录内，才把路径交出去
  const done = open('file', 'ok.md')
  assert.equal(done.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].what, 'file')
  assert.equal(path.basename(calls[0].target), 'ok.md')
  assert.match(done.text, /已打开/)

  // 文件夹模式：同一收敛结果，只是 what 不同
  assert.equal(open('folder', 'ok.md').ok, true)
  assert.equal(calls[1].what, 'folder')

  // 判定不过的一次都不许碰 shell：穿越、非 .md、不存在、缺参
  for (const [what, file] of [
    ['file', '../escape.md'],
    ['file', 'note.txt'],
    ['folder', 'no-such.md'],
    ['file', ''],
  ]) {
    const bad = open(what, file)
    assert.equal(bad.ok, false, `应拒绝：${what} ${file || '(空)'}`)
    assert.ok(bad.code, '失败要带错误码')
    assert.ok(bad.hint, '失败要带人话改法')
  }
  assert.equal(calls.length, 2, '判定不过的请求不能触发系统打开')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('HTTP 后端：回环限制、方法限制、返回形状', async () => {
  const dir = path.join(root, '.ui-test-route')
  fs.mkdirSync(dir, { recursive: true })
  const calls = []
  const handler = createUiHandler({
    articleDir: dir,
    version: '9.9.9',
    runCli: async (argv) => {
      calls.push(argv)
      return { ok: true, exitCode: 0, data: { argv }, text: 'ok' }
    },
  })

  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())

  try {
    const pong = await post({ op: 'ping' })
    assert.equal(pong.ok, true)
    assert.equal(pong.data.version, '9.9.9')

    const listed = await post({ op: 'list-articles' })
    assert.equal(listed.ok, true)
    assert.equal(calls.at(-1).join(' '), 'article list')

    const bad = await post({ op: 'eval' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'unknown_op')

    const traversal = await post({ op: 'check-article', params: { file: '../x.md' } })
    assert.equal(traversal.ok, false)

    // 裸 GET 路由被拒。
    // 0.4.0 起有一个专门的 GET 子路径（/cover，给 <img> 用），
    // 所以未匹配的 GET 现在走 404 而不是 405 —— 两者都是拒绝，别把 assert 写死成 405。
    const getRes = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    assert.ok([404, 405].includes(getRes.status), `裸 GET 应被拒，实际 ${getRes.status}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('封面 GET 端点：能读到图，穿越/后缀/不存在都被挡在目录外', async () => {
  const { createUiHandler, ROUTE, resolveCoverPath } = await import('../dsh-plugin/ui-backend.js')
  const dir = path.join(root, '.ui-test-cover')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  // 一个最小的合法 PNG 头（不必真能解码，只要服务端按字节回传）
  fs.writeFileSync(path.join(dir, 'a-cover.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x')

  const handler = createUiHandler({ runCli: async () => ({ ok: true }), articleDir: dir, version: '9.9.9' })
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`)

  try {
    const okRes = await get(`${ROUTE}/cover?f=a-cover.png`)
    assert.equal(okRes.status, 200)
    assert.equal(okRes.headers.get('content-type'), 'image/png')
    // 封面会被重新生成，不能被长期缓存
    assert.equal(okRes.headers.get('cache-control'), 'no-cache')
    const bytes = Buffer.from(await okRes.arrayBuffer())
    assert.ok(bytes.length > 0, '应当回传图片字节')

    // 越界一律拒绝
    for (const bad of ['../escape.png', 'C:/Windows/x.png']) {
      const res2 = await get(`${ROUTE}/cover?f=${encodeURIComponent(bad)}`)
      assert.ok(res2.status >= 400, `越界路径必须被拒：${bad}`)
    }
    // 非图片后缀
    const txt = await get(`${ROUTE}/cover?f=note.txt`)
    assert.equal(txt.status, 400)
    // 不存在
    const missing = await get(`${ROUTE}/cover?f=nope.png`)
    assert.equal(missing.status, 404)
    // 未知 GET 路径（不能变成"什么都能读"的通配）
    const unknown = await get(`${ROUTE}/whatever`)
    assert.equal(unknown.status, 404)

    // 目录之外必须报 cover_outside（而不是模糊的 IO 错误）
    assert.throws(
      () => resolveCoverPath(dir, '../escape.png'),
      (error) => error.code === 'cover_outside',
    )
    assert.throws(
      () => resolveCoverPath(dir, 'https://x.com/a.png'),
      (error) => error.code === 'cover_remote',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('article show 必须回传正文与字数（面板曾一直显示「正文 0 字符」）', async () => {
  const { dispatch } = await import('../src/commands.js')
  const dir = path.join(root, '.ui-test-body')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const body = '第一段正文。\n\n## 小节\n\n第二段正文。'
  const file = path.join(dir, 'body.md')
  fs.writeFileSync(file, `---\ntitle: 正文字数测试\ncover: \n---\n\n${body}`, 'utf8')

  const result = await dispatch('article', ['show'], { file })
  assert.equal(result.ok, true, result.text)
  assert.ok(result.data.article.bodyChars > 0, `bodyChars 不该是 0：${result.data.article.bodyChars}`)
  assert.equal(typeof result.data.article.body, 'string', 'body 必须回传，面板要渲染它')
  assert.ok(result.data.article.body.includes('第一段正文'), 'body 内容必须对')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('save-background：底图上传落盘，类型/尺寸/文件名都要收敛', async () => {
  const { createUiHandler, ROUTE } = await import('../dsh-plugin/ui-backend.js')
  const dir = path.join(root, '.ui-test-bg')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.md'), '---\ntitle: 测试\n---\n\n正文', 'utf8')

  const handler = createUiHandler({ runCli: async () => ({ ok: true, exitCode: 0, data: {}, text: 'ok' }), articleDir: dir, version: '9.9.9', stateDir: dir })
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
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  try {
    // 正常：png 落盘，文件名被净化（空格 → 下划线），且带固定前缀
    const okRes = await post({
      op: 'save-background',
      params: { file: 'a.md', name: 'my bg.png', mime: 'image/png', content: tinyPng.toString('base64') },
    })
    assert.equal(okRes.json.ok, true, okRes.json.text)
    const name = okRes.json.data.name
    assert.match(name, /^bg-/, '应当加固定前缀，避免和文章封面撞名')
    assert.ok(!name.includes(' '), `文件名里的空格必须被净化：${name}`)
    assert.ok(name.endsWith('.png'))
    assert.ok(fs.existsSync(path.join(dir, name)), '应当真的落盘')

    // 不支持的图片类型要被拒（不能什么都往目录里写）
    const badType = await post({
      op: 'save-background',
      params: { file: 'a.md', name: 'x.svg', mime: 'image/svg+xml', content: 'PHN2Zz4=' },
    })
    assert.equal(badType.json.ok, false)
    assert.match(badType.json.data.error.code, /bg_bad_type/)

    // 空内容要拒
    const empty = await post({ op: 'save-background', params: { file: 'a.md', name: 'x.png', mime: 'image/png', content: '' } })
    assert.equal(empty.json.ok, false)

    // 非 save-background 的 op 仍受 256 KB 限制（不能因为放宽上传而放开所有 op）
    const bigOther = await post({ op: 'check-article', params: { file: 'a.md', junk: 'x'.repeat(300 * 1024) } })
    assert.equal(bigOther.status, 413, `其它 op 的大 body 应被 413 挡住，实际 ${bigOther.status}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('image-providers：能报出 AI 配图是否可用（面板据此决定按钮状态）', async () => {
  const { dispatch } = await import('../src/commands.js')
  const result = await dispatch('image-providers', [], {})
  assert.equal(result.ok, true, result.text)
  assert.equal(typeof result.data.available, 'boolean', '必须给出 available 布尔值')
  assert.ok(Array.isArray(result.data.providers), '必须给出 providers 列表')
  // 没 key 时应当给出下一步怎么做（而不是只报"不可用"）
  if (!result.data.available) {
    assert.match(result.text, /WXMP_IMG_/, '要告诉用户配哪个环境变量')
    assert.match(result.text, /--bg|回落/, '要说清没 key 时的替代路径')
  }
})

test('AI 配图 key：面板能配、能删、且不会把已配的其它供应商冲掉', async () => {
  const { dispatch } = await import('../src/commands.js')
  const home = path.join(root, '.ui-test-keys')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  const savedHome = process.env.WXMP_HOME
  process.env.WXMP_HOME = home
  try {
    // 配 gemini
    const first = await dispatch('config', ['set'], { 'image-key': 'gemini', value: 'AIza-TEST-1' })
    assert.equal(first.ok, true, first.text)
    // 再配 openai —— 不能把 gemini 冲掉（浅合并会，按键合并不会）
    const second = await dispatch('config', ['set'], { 'image-key': 'openai', value: 'sk-TEST-2' })
    assert.equal(second.ok, true)
    const after = second.data.imageProviders
    const ids = after.providers.map((p) => p.providerId).sort()
    assert.deepEqual(ids, ['gemini', 'openai'], `两家都应还在，实际 ${ids.join(',')}`)

    // 未知供应商要被拒（CliError 是抛出而不是返回 ok:false）
    await assert.rejects(
      () => dispatch('config', ['set'], { 'image-key': 'not-real', value: 'x' }),
      (error) => {
        assert.match(String(error.code || error.message), /provider_unknown/)
        return true
      },
    )

    // 删除一家（- 表示删除），另一家必须留着
    const removed = await dispatch('config', ['set'], { 'image-key': 'openai', value: '-' })
    assert.equal(removed.ok, true)
    const left = removed.data.imageProviders.providers.map((p) => p.providerId)
    assert.deepEqual(left, ['gemini'], `删 openai 后应只剩 gemini，实际 ${left.join(',')}`)

    // 配置文件里不能出现明文以外的意外结构，且 imageKeys 只剩一家
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    assert.deepEqual(Object.keys(raw.imageKeys || {}), ['gemini'])
  } finally {
    if (savedHome === undefined) delete process.env.WXMP_HOME
    else process.env.WXMP_HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * F28/F30 回归防线（复核第十一轮 F34 的落地）：
 * 「发表」是面板唯一对外且撤不回的操作，必须走统一确认浮层，且
 * **只 await 秒级提交段、绝不 await 最长 60s 的轮询段**。
 * 这类「按钮指错函数」的回归，槽位/TDZ/op 白名单三条既有断言都抓不住。
 */
test('发表必须走确认浮层，且浮层只等提交段、不等轮询段', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  // 判据用「剥注释后的代码」：曾经直接匹配 await publishNow 会被注释里的
  // 「不 await publishNow」命中，造成假红（第十一轮复核踩过）。
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // ① 发表按钮不再一键直发
  assert.ok(!/onClick: publishNow/.test(codeOnly), '发表按钮退回了一键直发（onClick: publishNow）')
  assert.match(codeOnly, /onClick: askPublish/, '发表按钮没接确认浮层')

  // ② 确认项必须是危险操作，且文案写清不可逆后果
  const askStart = codeOnly.indexOf('function askPublish')
  assert.ok(askStart > 0, '没找到 askPublish')
  const ask = codeOnly.slice(askStart, codeOnly.indexOf('\n      }', askStart) + 8)
  assert.match(ask, /danger: true/, '发表确认框没标 danger')
  for (const fact of ['群发', '不能撤回', 'publishId']) {
    assert.ok(ask.includes(fact), `发表确认文案缺关键事实：${fact}`)
  }
  assert.match(ask, /if \(publishing\)/, 'askPublish 丢了防重入')

  // ③ 浮层只等提交段：onConfirm 里 await submitPublish，轮询必须 fire-and-forget
  assert.match(ask, /await submitPublish\(\)/, 'onConfirm 没等提交段（失败就无处显示）')
  assert.match(ask, /void pollPublishStatus\(/, '轮询段没走后台（浮层会被挡死 60 秒）')
  assert.ok(!/await pollPublishStatus\(/.test(ask), 'onConfirm 里 await 了轮询段 —— 全屏遮罩会挡死面板')

  // ④ 三段职责都在，且 48001 人工发布引导没被吞
  assert.match(codeOnly, /async function submitPublish\(\)/, '缺提交段 submitPublish')
  assert.match(codeOnly, /async function pollPublishStatus\(/, '缺轮询段 pollPublishStatus')
  // 48001 引导必须**由 48001 这条分支触发**，不是「代码里出现过 setManualPublish(true)」——
  // 只看后者会被 `if (false) setManualPublish(true)` 骗过（反例④实测抓出来的假绿）。
  assert.match(
    codeOnly,
    /code === 'wechat_48001'\)\s*setManualPublish\(true\)/,
    '48001 人工发布引导没接在 wechat_48001 分支上（丢了或被改成死分支）',
  )
  // ⑤ 每条失败分支都必须带 hint（toast 单槽位，裸 message 会覆盖掉下一步建议）。
  //    用「失败分支数 vs hint 数」自适配比对，而不是写死阈值：
  //    写死 >=3 时，四条分支删掉一条仍达标 —— 那是假绿（反例⑤实测抓出来的）。
  const submit = codeOnly.slice(codeOnly.indexOf('async function submitPublish'))
  const submitBody = submit.slice(0, submit.indexOf('\n      }'))
  const failCount = (submitBody.match(/ok: false/g) || []).length
  const hintCount = (submitBody.match(/hint:/g) || []).length
  assert.ok(failCount >= 3, `submitPublish 的失败分支只剩 ${failCount} 条，结构被改坏`)
  assert.ok(
    hintCount >= failCount,
    `submitPublish 有 ${failCount} 条失败分支却只给了 ${hintCount} 条 hint —— 每条失败都得说清下一步`,
  )
})

test('诊断浮窗：点了按钮必须有可见反馈（不再是"静默复制到剪贴板"）', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  const fnStart = src.indexOf('async function collectDiagnostics')
  assert.ok(fnStart > 0, '没找到 collectDiagnostics（诊断入口）')
  const fnEnd = src.indexOf('async function copyDiagnostics', fnStart)
  assert.ok(fnEnd > fnStart, '没找到 collectDiagnostics 的函数体边界')
  const body = src.slice(fnStart, fnEnd)
  // 1) 先开面板、后取数：点击到出现要立刻发生，不能等两个接口回来才弹
  const openAt = body.indexOf('setDiagOpen(true)')
  const awaitAt = body.indexOf('await api(')
  assert.ok(openAt > 0, 'collectDiagnostics 没打开浮窗 —— "点了没反应"就是这个原因')
  assert.ok(awaitAt > 0 && openAt < awaitAt, '必须先 setDiagOpen(true) 再 await 取数，否则点下去要干等')
  // 2) 不再静默改剪贴板：复制必须是用户显式点的动作
  assert.ok(!body.includes('clipboard?.writeText'), 'collectDiagnostics 不该静默写剪贴板')
  assert.match(src, /async function copyDiagnostics/, '缺显式复制函数')
  // 3) 内容渲染在 FloatingPanel 里，而不是设置页底部那个没人找得到的 <pre>
  assert.match(src, /id: 'diag'/, "缺诊断浮窗（FloatingPanel id: 'diag'）")
  const settings = src.slice(src.indexOf('function SettingsModal'), src.indexOf('const inputStyle ='))
  assert.ok(settings.length > 1000, '没找到 SettingsModal 组件体')
  assert.ok(!settings.includes('diagText'), '设置页不该再内联渲染诊断文本（内容已搬进浮窗）')
  assert.match(settings, /onOpenDiagnostics/, '设置页应保留一个"打开诊断浮窗"的入口')
})

test('单入口：只剩 panellist + main 两个槽位，且都注册在 effect 里（可释放）', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  for (const slot of ['sidebar.panellist', 'main']) {
    // 每个槽位都必须包在 ctx.effect(() => ctx.slots.inject(...)) 里
    const idx = src.indexOf(`ctx.slots.inject('${slot}'`)
    assert.ok(idx > 0, `槽位 ${slot} 没注册`)
    const before = src.slice(Math.max(0, idx - 120), idx)
    assert.match(before, /ctx\.effect\(/, `槽位 ${slot} 没包在 ctx.effect 里，禁用后会残留`)
  }
  // 反向断言：两个已删除的槽位不能复活
  assert.equal(
    src.includes("ctx.slots.inject('shell.overlay'"),
    false,
    'shell.overlay 应已移除：全屏工作台已按用户要求删除',
  )
  assert.equal(
    src.includes("ctx.slots.inject('sidebar.footer.action'"),
    false,
    'sidebar.footer.action 应已移除（侧栏底部空间留给宿主自己）',
  )
})

test('客户端源码：必备的可访问性与状态反馈标记都在', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  const required = [
    ['aria-selected', '键盘选中态'],
    ['aria-expanded', '折叠控件状态'],
    ['aria-label', '图标/按钮可读标签'],
    ['role: \'dialog\'', '浮层语义'],
    ['aria-modal', '模态声明'],
    ['Escape', 'Esc 关闭'],
    ['prefers-reduced-motion', '尊重减弱动效'],
    ['wxmp-focus', '可见焦点环类'],
    ['wxmp-scroll', '内部滚动与细滚动条'],
    ['localStorage', '折叠状态持久化'],
    ['ResizeObserver', '窄屏自适应'],
    ['hintFor', '错误三段式'],
    ['Skeleton', '加载骨架'],
  ]
  for (const [needle, why] of required) {
    assert.ok(src.includes(needle), `缺少 ${needle}（${why}）`)
  }
  // 不允许硬编码浮层背景色
  assert.ok(!/background:\s*['"]#00f|background:\s*['"]rgba\(0,0,0/.test(src), '浮层应用 overlay token')
  assert.ok(src.includes('--dsw-alias-'), '颜色必须走宿主 token')
})

test('Host 半把 UI 路由与工具注册分块挂载，且都登记为可释放资源', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'index.js'), 'utf8')
  assert.ok(src.includes("from './ui-backend.js'"), '应引用 UI 后端模块')
  assert.ok(src.includes('ROUTE'), '应注册固定路由')
  // 0.1.1 起：工具与面板各自 ctx.inject + ctx.effect 回收，不再共用一个 disposers 数组。
  // 断的是「两条依赖分开声明」这个行为，不是某句实现文本。
  assert.ok(/ctx\.inject\(\s*\['tools'\]/.test(src), '工具块应单独 ctx.inject(["tools"])')
  assert.ok(/ctx\.inject\(\s*\['webServer'\]/.test(src), '面板块应单独 ctx.inject(["webServer"])')
  assert.ok(!/^export const inject = \['tools'\]/m.test(src), '模块级 inject 不得只写 tools（会挡住 webServer）')
  assert.ok(src.includes('target.effect(register)'), '注册应交给 ctx.effect 回收，禁用后不留残留')
  assert.ok(src.includes('writeMountState'), '挂载结果要落盘，便于事后复盘')
  assert.ok(src.includes("name: 'wxmp'"), '模型侧工具保持原名')
})

test('打分预设浮窗：可拖动、可缩放、位置持久化、Esc 关闭', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  const start = src.indexOf('function FloatingPanel')
  assert.ok(start > 0, '没找到 FloatingPanel 组件')
  // 截到下一个顶层函数为止
  const nextFn = src.indexOf('\n    const colStyle', start)
  const panel = src.slice(start, nextFn > 0 ? nextFn : start + 8000)

  // 1) 拖动与缩放都要有
  assert.match(panel, /startDrag\('move'\)/, '缺拖动（移动窗口）')
  assert.match(panel, /startDrag\('resize'\)/, '缺缩放（调整大小）')

  // 2) 用 pointer 事件而不是 mouse（触控板/触屏可用）
  assert.match(panel, /pointermove/, '拖动应监听 pointermove')
  assert.match(panel, /setPointerCapture|pointerup/, '缺 pointer 结束处理')

  // 3) 位置和尺寸要持久化
  assert.match(panel, /localStorage\.setItem\(STORE/, '位置没有持久化')
  assert.match(panel, /localStorage\.getItem\(STORE/, '位置没有读回')

  // 4) 边界收敛：不能拖出屏幕再也点不到。
  //    光有 clamp 函数不够 —— 必须确认 commit 真的调用了它，
  //    否则等于"写了防护但没接线"（第一版断言就漏了这一点）。
  assert.match(panel, /const clamp = /, '缺边界收敛函数')
  assert.match(panel, /vw - 80|window\.innerWidth/, '收敛逻辑要参考视口尺寸')
  assert.match(
    panel,
    /const safe = clamp\(next\)/,
    'commit 必须真的调用 clamp，否则防护等于没接线',
  )

  // 5) Esc 关闭（浮窗盖住内容，键盘用户必须能退出）
  assert.match(panel, /key === 'Escape'/, '缺 Esc 关闭')

  // 6) transform 定位（拖时不触发重排）
  assert.match(panel, /translate3d/, '应用 transform 定位而不是 left/top')

  // 7) 层级：要盖住插件自己的右栏与设置浮层，但不能盖住宿主的模态层
  const zMatch = /zIndex:\s*(\d+)/.exec(panel)
  assert.ok(zMatch, '缺 zIndex')
  const z = Number(zMatch[1])
  assert.ok(z > 1000, '层级应高于普通内容')
  assert.ok(z > 9998, '层级应高于插件自己的设置浮层（9998），否则设置会盖住它')
  assert.ok(z < 2147483000, '层级应低于宿主模态层（2147483000），否则会盖住宿主自己的弹窗')
})

test('打分预设已从右栏移出：右栏只剩入口，浮窗在渲染树最外层', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  // 右栏里不该再有完整的预设列表渲染
  const railStart = src.indexOf('// 右：状态 + 流水线')
  // 右栏到"浮窗开始"为止 —— 浮窗虽然写在右栏之后，但它不在右栏里
  const railEnd = src.indexOf('h(FloatingPanel', railStart)
  assert.ok(railEnd > railStart, '没找到浮窗位置')
  const rail = src.slice(railStart, railEnd)
  // 注意：右栏里允许有 <select> 的 presets.map（那是体检区的快速切换下拉），
  // 但**完整的预设管理列表**（带导出/导入按钮的那一大块）必须只在浮窗里。
  assert.ok(
    !/导出预设|导入预设/.test(rail),
    '右栏里不该再有导入/导出按钮（完整管理应在浮窗里）',
  )
  assert.ok(
    !/恢复内置/.test(rail),
    '右栏里不该再有「恢复内置」（完整管理应在浮窗里）',
  )
  assert.match(rail, /打分预设/, '右栏要保留打开浮窗的入口按钮')
  // 浮窗在最外层：出现在 Toast 之前、右栏结束之后
  const floatAt = src.indexOf('h(FloatingPanel')
  assert.ok(floatAt > railStart, '浮窗应在右栏之后渲染（脱离右栏布局）')
  assert.ok(floatAt < src.indexOf('h(Toast, { toast })'), '浮窗应在 Toast 之前')
})
test('定位容器回归：.wxmp-shell 不得含会破坏 position:fixed 的属性', () => {
  // 真实故障（1.7.0）：.wxmp-shell 上有 container-type: inline-size，
  // 使该元素成为「定位容器」——内部 position:fixed 不再相对视口，
  // 而是相对它定位；再叠加 overflow:hidden，浮窗被裁在面板里，
  // 用户看到的现象是「点打分预设没反应」。
  //
  // 而且那个 container-type 是白设的：代码里没有任何 @container 查询，
  // 宽度判断走的是 ResizeObserver。
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')

  // 1) container-type 必须不存在于实际 CSS 规则里（注释里提到可以）
  const styleBlockMatch = /const CSS = `([\s\S]*?)`\n/m.exec(src)
  assert.ok(styleBlockMatch, '没找到 CSS 模板字符串')
  const css = styleBlockMatch[1]
  assert.doesNotMatch(css, /container-type\s*:/, 'CSS 里不该有 container-type：它会破坏 position:fixed')

  // 2) 也不该有其它定位容器来源
  for (const prop of ['transform:', 'filter:', 'perspective:', 'will-change:', 'contain:']) {
    const rule = new RegExp(`\\.wxmp-shell\\s*\\{[^}]*${prop}`, 'i')
    assert.doesNotMatch(css, rule, `.wxmp-shell 不该带 ${prop}（会让 fixed 相对它定位）`)
  }

  // 3) 没有任何 @container 查询依赖（确认删掉是安全的）
  assert.doesNotMatch(css, /@container/, '如果将来要用容器查询，得同时解决 fixed 定位问题')
})

test('浮窗要有运行时自愈：祖先成了定位容器时自动降级为铺满', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  const start = src.indexOf('function FloatingPanel')
  const nextFn = src.indexOf('\n    const colStyle', start)
  const panel = src.slice(start, nextFn > 0 ? nextFn : start + 9000)

  // 必须检测祖先的定位容器属性
  assert.match(panel, /containerType/, '要检测 container-type')
  assert.match(panel, /getComputedStyle/, '要读计算样式而不是内联样式')
  assert.match(panel, /style\.transform/, '要检测 transform')
  assert.match(panel, /style\.filter/, '要检测 filter')

  // 检测到之后要有降级行为。
  // 注意：不能只断言字符串存在 —— 第一版就是这么写的，
  // 把 setTrapped(Boolean(found)) 改成 setTrapped(false) 后测试照样绿。
  // 必须确认 trapped **真的被赋了检测结果**。
  assert.match(panel, /const \[trapped, setTrapped\]/, '缺 trapped 状态')
  assert.match(
    panel,
    /setTrapped\(Boolean\(found\)\)/,
    'trapped 必须真的接收检测结果，否则自愈等于没接线',
  )
  assert.match(panel, /trapped \? 'none'/, 'trapped 时应放弃 translate 定位')
  assert.match(panel, /inset: 0/, 'trapped 时应铺满视口')
  // 降级要让用户知道（不然会以为拖动坏了）
  assert.match(panel, /已铺满显示/, '降级要在界面上说明，不能静默')
})

test('封面规格：写成"默认推荐"、可强改，且改之前必须经过二次确认', () => {
  // 用户原话：「固定规格（不可修改）这里改成默认推荐，可以强行更改，
  //           只不过更改要二次确认」。
  // 这个用例守的是三件事：文案不再是"不可修改"、确实能改、改之前拦了一下。
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')

  assert.doesNotMatch(src, /固定规格（不可修改）/, '不能再对用户说"不可修改"')
  assert.match(src, /输出规格（默认推荐，可改）/, '标题要说明是推荐值且可改')

  // 状态齐了才算"真能改"：生效值 / 编辑器 / 草稿 / 确认
  for (const state of ['coverSize', 'coverEditing', 'coverDraftW', 'coverDraftH', 'coverConfirm']) {
    assert.match(
      src,
      new RegExp(`const \\[${state}, set[A-Za-z]+\\] = useState`),
      `缺状态 ${state} —— 缺了就是"看起来能改、点了没反应"`,
    )
  }
  // 落盘：改过的尺寸要记住，否则下次打开又回到推荐值
  assert.match(src, /savePrefs\(\{ coverSize: next \}\)/, '改完要持久化，不然重启就丢')
  assert.match(src, /coverSize: null/, 'prefs 里要有 coverSize 默认项（null = 用推荐值）')

  // 二次确认：点「应用」只进入确认态，真正写值的是确认按钮
  assert.match(src, /onClick: \(\) => setCoverConfirm\(true\)/, '「应用」应先进确认态，不能直接生效')
  assert.match(src, /role: 'status'/, '确认条要是 role=status（读屏能播报）')
  assert.match(src, /确认把封面输出尺寸改成/, '确认条要复述具体改到什么尺寸')
  assert.match(src, /再想想/, '确认条要有反悔出口')
  assert.match(src, /已经生成的封面不会自动重做/, '要说清这次改动的实际影响面')

  // 恢复推荐：不是自动行为，得有按钮
  assert.match(src, /恢复推荐/, '要能一键回到推荐尺寸')

  // 尺寸必须真的走后端：面板只负责收集，收敛（夹边界/比例告警）在 cover-layout.js
  assert.match(src, /width: coverSize\.width, height: coverSize\.height/, '生成封面时要把尺寸带出去')
})

test('封面提示词：不再追加任何约束（用户明确说过这会限制 AI 出图）', () => {
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  const start = src.indexOf('function previewPrompt')
  assert.ok(start > 0, '没找到 previewPrompt')
  // 取到下一个顶层定义为止
  const body = src.slice(start, src.indexOf('const IMAGE_PROVIDER_CHOICES', start))

  // 面板预览必须与后端 buildCoverPrompt 同构：用户写了就逐字返回
  assert.match(body, /if \(mine\) return mine/, '写了提示词就该原样返回，不许拼接')
  // 旧的追加句必须消失（它把"不要出现任何文字"塞进了用户自己的提示词里）
  assert.doesNotMatch(body, /横向全景构图/, '不能再追加横向构图约束')
  assert.doesNotMatch(body, /不要出现任何文字/, '不能再追加无文字约束')
  assert.doesNotMatch(body, /the left two thirds/, '不能再追加"左侧留空"约束')

  // 内置模板里也不该再有禁止句
  assert.doesNotMatch(src, /no writing, no lettering/, '内置模板里的禁止句也要删掉')
  assert.doesNotMatch(src, /AI 只生成无字背景/, '界面文案里不该再强调"只生成无字背景"')
  assert.doesNotMatch(src, /自动追加约束/, '不能再宣称会自动追加约束')
})

test('打分预设：顶栏必须有常驻入口（右栏收起后还能找到它）', () => {
  // 用户原话：「最开是说改成悬浮窗口的分数模版栏目呢，怎么不见了」。
  // 根因：浮窗本身没坏（它渲染在渲染树最外层），但唯一的开窗入口长在右栏里。
  // 右栏一收起（railCollapsed）整栏只剩一条竖条 —— 浮窗就再也没有入口了。
  // 这个用例守的是：入口必须在一处"永远看得见"的地方。
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')

  // 1) 顶栏第二行要有这个按钮
  assert.match(src, /🎯 打分预设/, '顶栏要有常驻的「🎯 打分预设」入口')

  // 2) 它必须真的开那个浮窗，而不是只挂个样子
  const toolbarAt = src.indexOf('🎯 打分预设')
  const toolbarButton = src.slice(Math.max(0, toolbarAt - 900), toolbarAt)
  assert.match(toolbarButton, /setPresetOpen\(next\)/, '顶栏入口要能开窗')
  assert.match(toolbarButton, /savePrefs\(\{ presetOpen: next \}\)/, '开窗状态要持久化')
  assert.match(toolbarButton, /'aria-expanded': presetOpen/, '要有 aria-expanded')

  // 3) 浮窗必须渲染在渲染树最外层 —— 嵌在右栏里会被右栏的 overflow 裁掉，
  //    也会跟着 railCollapsed 一起消失
  assert.match(
    src,
    /presetOpen\s*\n\s*\?\s*h\(FloatingPanel, \{\s*\n\s*id: 'presets',/,
    '打分预设浮窗要用 FloatingPanel 渲染在顶层，id 必须是 presets',
  )

  // 4) 右栏收起态必须是个"看得出能点"的控件，不能是透明竖排小字
  assert.match(src, /◂ 展开右栏/, '收起态要有明确的展开按钮文案')
  assert.match(src, /展开右侧栏（字数统计、打分预设、写作辅助）/, '要说明展开后里面有什么')
  assert.doesNotMatch(src, /展开状态 ▸/, '旧的"展开状态"文案太含糊，已废弃')
})

test('作者名：面板能改能清空，且改完必须刷新详情（不能只改文件）', async () => {
  // 用户原话：「为什么一直有这个YG出现？」。
  // 根因不是 bug —— 是文章 front matter 里写着 `author: YG`，而封面副标题、
  // 预览页 byline、面板作者行三处都直接读它。真正的问题是：建完文章之后，
  // 这三处显示的名字**没有任何入口能改**（CLI 只有 `article new --author`）。
  // 这个用例守两件事：面板能改；改完详情真的重读，而不是让用户对着旧名字发呆。
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')

  // 1) Host 白名单与 argv：空字符串是有意义的「清空」，绝不能被当成缺参丢掉
  const { UI_OPERATIONS } = await import('../dsh-plugin/ui-backend.js')
  assert.ok(UI_OPERATIONS.includes('set-author'), 'set-author 必须在 UI 操作白名单里')
  assert.deepEqual(
    buildUiArgv('set-author', { file: 'a.md', author: '张三' }).argv,
    ['article', 'set-author', '--file', 'a.md', '--author', '张三'],
  )
  assert.deepEqual(
    buildUiArgv('set-author', { file: 'a.md', author: '' }).argv,
    ['article', 'set-author', '--file', 'a.md', '--author', ''],
    '传空字符串 = 清空作者，不能省略 --author',
  )

  // 2) Agent 侧也要有同等能力（GUI 与 agent 路径必须等价）
  const hostSrc = fs.readFileSync(path.join(root, 'dsh-plugin', 'index.js'), 'utf8')
  assert.match(hostSrc, /'article_set_author'/, '工具操作枚举里要有 article_set_author')
  const { buildArgv } = await import('../dsh-plugin/index.js')
  assert.deepEqual(
    buildArgv('article_set_author', { file: 'a.md', author: '' }),
    ['article', 'set-author', '--file', 'a.md', '--author', ''],
    'agent 传空字符串同样要落成 --author ""（清空），不能被 pushFlag 吞掉',
  )

  // 3) 编辑态：有一个能输入的框、保存/清空/取消三个动作
  assert.match(src, /const \[authorEditing, setAuthorEditing\] = useState\(false\)/)
  assert.match(src, /const \[authorInput, setAuthorInput\] = useState\(''\)/)
  assert.match(src, /id: 'wxmp-author-input'/, '输入框要有稳定 id，label 才挂得上')
  assert.match(src, /maxLength: 16/, '作者上限 16 字要和 CLI 一致')
  assert.match(src, /setAuthorEditing\(true\)/, '点「改」要能进编辑态')

  // 4) 写回走的是 CLI 那条真正的路径，且只由人点触发
  const applyAt = src.indexOf('const applyAuthor = useCallback')
  assert.ok(applyAt > 0, '必须有 applyAuthor')
  const applyFn = src.slice(applyAt, applyAt + 1800)
  assert.match(applyFn, /api\('set-author', \{ file: selected, author: next \}\)/)
  assert.match(applyFn, /setDetailV\(\(n\) => n \+ 1\)/, '改完要推详情版本号')

  // 4b) 「清空」按钮要真的走清空那条路（applyAuthor('')），而不是只清空输入框
  const clearAt = src.indexOf('清空作者名')
  assert.ok(clearAt > 0, '编辑态要有「清空」按钮（用它的 title 定位）')
  const clearButton = src.slice(Math.max(0, clearAt - 400), clearAt + 400)
  assert.match(clearButton, /applyAuthor\(''\)/, "「清空」必须调 applyAuthor('')，不能只清输入框")
  assert.match(clearButton, /'清空'/, '按钮文案要是「清空」')

  // 5) 详情 effect 必须依赖 detailV。
  //    原来只依赖 [selected]，所以改完标题/作者，面板里还显示旧值 ——
  //    用户会以为没生效（"操作了不给反馈"的另一种形态）。
  assert.match(
    src,
    /\}, \[selected, detailV\]\)/,
    '详情 effect 要依赖 detailV，否则写回之后界面不刷新',
  )
  assert.match(src, /const \[detailV, setDetailV\] = useState\(0\)/)
})

test('封面素材缓存：面板看得见"会不会重复上传"，且建完草稿刷新详情', () => {
  // 用户原话：「每次 draft update 都会把封面重新 add_material 一次，
  // 微信那边就是一条新素材」——而且永久素材要逐条去后台删。
  // CLI 侧靠 front matter 里的 thumbMediaId + coverHash 复用（test/cli.test.js 有三条用例守）。
  // 面板这一侧要能让人**看见**这件事，否则用户只能去数后台的素材条数。
  const src = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')

  // 1) 详情里有一行「封面素材」，读的是 article.thumbMediaId
  assert.match(src, /'封面素材',|'封面素材'/, '详情要有「封面素材」这一行')
  assert.match(src, /article\.thumbMediaId\s*\n?\s*\?\s*h\('span'/, '缓存命中要显示素材 id')
  assert.match(src, /'（封面没变就复用它，不会重复上传）'/, '命中时要说明会复用')
  assert.ok(
    src.includes('（下次建草稿/更新会新建一条永久素材）'),
    '未命中时要说清代价',
  )

  // 2) 建草稿会写回 mediaId 与封面素材信息 → 详情必须重读
  const createAt = src.indexOf('async function createDraft')
  assert.ok(createAt > 0, '必须有 createDraft')
  const createFn = src.slice(createAt, createAt + 600)
  assert.match(createFn, /setDetailV\(\(n\) => n \+ 1\)/, '建完草稿要推详情版本号，否则「封面素材」那行还是旧的')

  // 3) 面板不许自己判断"要不要重传" —— 那是 Host 半的收敛逻辑，
  //    浏览器半一旦掺进来，agent 走 CLI 时的行为就和面板不一致了。
  assert.ok(
    !/\/cgi-bin\//.test(src) && !/uploadPermanentImage/.test(src),
    '面板不该直连微信接口：复用与否由 Host 半按封面指纹判断',
  )
})