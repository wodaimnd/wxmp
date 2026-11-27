import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(path.dirname(here), '.wxmp-plugin')
process.env.WXMP_HOME = home
fs.rmSync(home, { recursive: true, force: true })

const { startFakeWechat } = await import('./support/fake-wechat.js')
const plugin = await import('../dsh-plugin/index.js')

const fake = await startFakeWechat({ publishDelayMs: 800 })

test.after(async () => {
  await fake.close()
  fs.rmSync(home, { recursive: true, force: true })
})

test('buildArgv 把参数翻译成 CLI argv', () => {
  assert.deepEqual(plugin.buildArgv('config_set', { appid: 'wx1234567890abcdef', secret: 's' }), [
    'config',
    'set',
    '--appid',
    'wx1234567890abcdef',
    '--secret',
    's',
  ])
  assert.deepEqual(plugin.buildArgv('article_new', { title: '标题', theme: 'dark' }), [
    'article',
    'new',
    '--title',
    '标题',
    '--theme',
    'dark',
  ])
  assert.deepEqual(plugin.buildArgv('article_check', { file: 'a.md' }), ['article', 'check', '--file', 'a.md'])
  // 体检：没有 minScore 时不带门槛参数；带了就透传成 --min-score
  assert.deepEqual(plugin.buildArgv('article_review', { file: 'a.md' }), ['article', 'review', '--file', 'a.md'])
  assert.deepEqual(plugin.buildArgv('article_review', { file: 'a.md', minScore: 85 }), [
    'article',
    'review',
    '--file',
    'a.md',
    '--min-score',
    '85',
  ])
  // 下划线写法也要认（模型有时会写 min_score）
  assert.deepEqual(plugin.buildArgv('article_review', { file: 'a.md', min_score: 70 }), [
    'article',
    'review',
    '--file',
    'a.md',
    '--min-score',
    '70',
  ])
  assert.deepEqual(plugin.buildArgv('draft_create', { file: 'a.md', dryRun: true }), [
    'draft',
    'create',
    '--file',
    'a.md',
    '--dry-run',
  ])
  assert.deepEqual(plugin.buildArgv('publish_submit', { mediaId: 'm1', yes: true }), [
    'publish',
    'submit',
    '--media-id',
    'm1',
    '--yes',
  ])
  assert.deepEqual(plugin.buildArgv('publish_submit', { mediaId: 'm1' }), [
    'publish',
    'submit',
    '--media-id',
    'm1',
  ])
  assert.deepEqual(plugin.buildArgv('publish_wait', { publishId: '42', timeoutMs: 30000 }), [
    'publish',
    'wait',
    '--publish-id',
    '42',
    '--timeout',
    '30000',
  ])
  assert.deepEqual(plugin.buildArgv('cover', { file: 'a.md', badge: 'AI' }), [
    'cover',
    '--file',
    'a.md',
    '--badge',
    'AI',
  ])

  /**
   * cover 的 prompt / width / height 曾经"声明了但不转发"：
   * PARAMETER_HINTS 里写着 prompt?/width?/height?，buildArgv 却不 push，
   * 参数传了静默无效。CLI 侧（commands.js 的 coverCmd）一直支持这三个 flag，
   * 所以这是纯工具层漏接线。这条断言锁住"声明即生效"。
   */
  assert.deepEqual(
    plugin.buildArgv('cover', { file: 'a.md', prompt: '水彩风格', width: 1000, height: 400 }),
    ['cover', '--file', 'a.md', '--prompt', '水彩风格', '--width', '1000', '--height', '400'],
  )

  // 声明过的每个参数都必须真的出现在 argv 里：防止再出现"文档说支持、实际被丢掉"
  const declared = plugin.PARAMETER_HINTS
  assert.ok(declared.includes('prompt?'), 'PARAMETER_HINTS 应声明 cover 支持 prompt')
  for (const name of ['prompt', 'width', 'height']) {
    const argv = plugin.buildArgv('cover', { file: 'a.md', [name]: name === 'prompt' ? 'x' : 900 })
    assert.ok(argv.includes(`--${name}`), `cover 声明了 ${name}，但 buildArgv 没有转发它`)
  }

  // 下划线写法也接受  assert.deepEqual(plugin.buildArgv('draft_get', { media_id: 'x' }), ['draft', 'get', '--media-id', 'x'])

  assert.throws(() => plugin.buildArgv('config_set', { appid: 'a' }), (error) => error.code === 'invalid_params')
  assert.throws(() => plugin.buildArgv('draft_get', {}), (error) => error.code === 'invalid_params')
  assert.throws(() => plugin.buildArgv('nope', {}), (error) => error.code === 'unknown_operation')
})

test('parseCliOutput 解析 --json 行并兜底', () => {
  const parsed = plugin.parseCliOutput('{"ok":true,"exitCode":0,"data":{"x":1},"text":"hi"}', 0)
  assert.deepEqual(parsed, { ok: true, exitCode: 0, data: { x: 1 }, text: 'hi' })
  const crashed = plugin.parseCliOutput('Error: boom', 1)
  assert.equal(crashed.ok, false)
  assert.match(crashed.text, /boom/)
})

/**
 * O2 回归锁：CLI 失败路径的顶层三样（code / error / hint）与本地 op 同形。
 *
 * 这条断言**必须能失败**——把 runCli 的超时出口或 parseCliOutput 的兜底分支改回
 * 裸对象 `{ok, exitCode, data, text}`，crashed.code 就是 undefined，这里立刻红。
 * 原来只有「工具入参校验」那条路径测过顶层形状，CLI 自己报的失败从来没人断言，
 * 所以 O2 活了整整一轮。
 */
test('O2：CLI 失败路径顶层带 code / error / hint（与本地 op 同形）', () => {
  const crashed = plugin.parseCliOutput('Error: boom', 1)
  assert.equal(typeof crashed.code, 'string', '兜底分支顶层必须有 code')
  assert.equal(crashed.code, 'cli_error')
  assert.equal(typeof crashed.error, 'string', '兜底分支顶层必须有 error')
  assert.equal(typeof crashed.hint, 'string', '兜底分支顶层必须有 hint')
  assert.equal(crashed.data.error.code, crashed.code, '顶层 code 与 data.error.code 必须同源')

  // 正常解析出来的 CLI 失败，由 promoteCliFailure 把 CLI 的短码抬到顶层
  const cliSaid = plugin.parseCliOutput(
    '{"ok":false,"exitCode":1,"data":{"error":{"code":"credentials_missing","message":"没配凭据"}},"text":"x"}',
    1,
  )
  assert.equal(cliSaid.code, undefined, 'parseCliOutput 不编造短码，抬顶层由 promoteCliFailure 负责')
  assert.equal(cliSaid.data.error.code, 'credentials_missing')

  // 成功结果不该被塞上顶层 code
  const okResult = plugin.parseCliOutput('{"ok":true,"exitCode":0,"data":{},"text":"fine"}', 0)
  assert.equal(okResult.ok, true)
  assert.equal(okResult.code, undefined, 'ok:true 不许带顶层 code')
})

test('apply 注册工具并能驱动真实 CLI 走完整链路', async () => {
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool); return () => registered.splice(registered.indexOf(tool), 1) } },
    systemPrompt: { section() {} },
  }
  plugin.apply(ctx, { stateDir: home })
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'wxmp')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.parameters.required[0], 'operation')

  // 先把凭据写进 CLI 的配置（插件与 CLI 共用同一个 WXMP_HOME）
  const setSecret = await tool.execute({
    operation: 'config_set',
    params: { appid: 'wx1234567890abcdef', secret: fake.secret },
  })
  assert.equal(setSecret.ok, true, setSecret.text)

  const created = await tool.execute({ operation: 'article_new', params: { title: '插件链路文章', author: '机器人' } })
  assert.equal(created.ok, true, created.text)
  const articleFile = created.data.path
  assert.ok(fs.existsSync(articleFile))

  const checked = await tool.execute({ operation: 'article_check', params: { file: articleFile } })
  assert.equal(checked.ok, true, checked.text)

  // 体检：Agent 拿到的必须是「分数 + 带行号的改法」，而不只是「能发 / 不能发」
  const reviewed = await tool.execute({ operation: 'article_review', params: { file: articleFile } })
  assert.equal(typeof reviewed.data.review.score, 'number', '工具必须回传结构化分数，Agent 才能判断改没改好')
  assert.ok(Array.isArray(reviewed.data.review.findings))
  assert.match(reviewed.text, /体检 /)
  assert.match(reviewed.text, /分项:/)
  for (const item of reviewed.data.review.findings) {
    assert.ok(item.suggest && item.suggest.length, `${item.code} 没有改法，Agent 只能瞎改`)
    assert.ok(item.line === null || typeof item.line === 'number')
  }
  // minScore 门槛：模板默认质量不高，卡 100 分必须失败（ok=false 且 exitCode=1）
  const gated = await tool.execute({ operation: 'article_review', params: { file: articleFile, minScore: 100 } })
  assert.equal(gated.ok, false, '分数低于 minScore 时工具必须回 ok=false，否则 Agent 无法用循环')
  assert.equal(gated.exitCode, 1)

  const preview = await tool.execute({ operation: 'article_preview', params: { file: articleFile } })
  assert.equal(preview.ok, true)

  const cover = await tool.execute({ operation: 'cover', params: { file: articleFile } })
  assert.equal(cover.ok, true)
  assert.ok(fs.existsSync(cover.data.path))

  // 封面自己会写回 front matter —— 这条断言就是 0.1.0 那个 40007 的现场
  assert.match(
    fs.readFileSync(articleFile, 'utf8'),
    /^cover: .+\.png$/m,
    'cover 操作必须把封面文件名写回 front matter，否则建草稿时没有 thumb_media_id',
  )
  assert.equal(cover.data.frontMatter.written, true)

  const draft = await tool.execute({
    operation: 'draft_create',
    params: { file: articleFile, baseUrl: fake.baseUrl },
  })
  assert.equal(draft.ok, true, draft.text)
  assert.match(draft.data.mediaId, /^draft_/)

  const listed = await tool.execute({ operation: 'draft_list', params: { baseUrl: fake.baseUrl } })
  assert.equal(listed.ok, true, listed.text)
  assert.ok(listed.data.items.length >= 1)

  const submitted = await tool.execute({
    operation: 'publish_submit',
    params: { file: articleFile, yes: true, baseUrl: fake.baseUrl },
  })
  assert.equal(submitted.ok, true, submitted.text)

  const waited = await tool.execute({
    operation: 'publish_wait',
    params: { publishId: submitted.data.publishId, baseUrl: fake.baseUrl, timeoutMs: 8000, intervalMs: 300 },
  })
  assert.equal(waited.ok, true, waited.text)
  assert.equal(waited.data.publish_status, 0)

  const [rendered] = tool.output.render({}, checked)
  assert.equal(rendered.type, 'text')
  assert.match(rendered.text, /校验/)

  // 重复 apply 释放旧注册
  plugin.apply(ctx, { stateDir: home })
  assert.equal(registered.length, 1)
})

/**
 * 枚举完整性：OPERATIONS 里每一项都必须有 buildArgv 分支。
 *
 * 为什么必须断言：把 operation 加进枚举却忘了写 case，模型在工具描述里
 * 看得见、调用时只拿到 `unknown_operation` —— 属于"列表说能用、实际调不通"。
 * 同理，每个 operation 都必须能被真正翻译出一个非空 argv。
 */
test('OPERATIONS 每一项都有 buildArgv 分支', () => {
  assert.ok(Array.isArray(plugin.OPERATIONS) && plugin.OPERATIONS.length > 0)
  const sample = {
    appid: 'wx1234567890abcdef',
    secret: 's',
    provider: 'openai',
    value: 'k',
    url: 'https://mp.weixin.qq.com/s/x',
    list: 'urls.txt',
    file: 'a.md',
    titles: ['A', 'B'],
    topic: 'T',
    form: 'tutorial',
    words: 1200,
    audience: 'A',
    angle: 'G',
    preset: 'standard',
    title: '新标题',
    author: '作者',
    check: 'x.png',
    mediaId: 'm1',
    publishId: '42',
    articleId: '9',
    id: 'mine',
    baseUrl: 'https://proxy.example.com',
    model: 'mod',
  }
  for (const operation of plugin.OPERATIONS) {
    let argv
    assert.doesNotThrow(() => {
      argv = plugin.buildArgv(operation, sample)
    }, `operation ${operation} 在 OPERATIONS 里，但 buildArgv 没有对应分支`)
    assert.ok(Array.isArray(argv) && argv.length > 0, `${operation} 翻译出的 argv 为空`)
  }
})

/**
 * 13 个曾经「只能敲 shell、工具调不到」的能力，现在必须真的接通。
 * 这些不是新功能 —— CLI 一直都实现了，只是工具层没暴露，
 * 导致 AI 拿着 skill 也不知道这些事能做。
 */
test('新增的 CLI 能力已在工具层接通', () => {
  const cases = [
    ['config_clear', {}, ['config', 'clear']],
    ['image_providers', {}, ['image-providers']],
    ['config_set_image_key', { provider: 'openai', value: 'sk-x' }, ['config', 'set', '--image-key', 'openai', '--value', 'sk-x']],
    ['config_set_image_key', { provider: 'openai', value: '-' }, ['config', 'set', '--image-key', 'openai', '--value', '-']],
    ['article_import', { url: 'https://mp.weixin.qq.com/s/x' }, ['article', 'import', '--url', 'https://mp.weixin.qq.com/s/x']],
    ['article_import', { list: 'urls.txt' }, ['article', 'import', '--list', 'urls.txt']],
    ['article_titles', { file: 'a.md', brief: true }, ['article', 'titles', '--file', 'a.md', '--brief']],
    ['article_titles', { titles: ['A', 'B'] }, ['article', 'titles', 'A', 'B']],
    ['article_outline', { file: 'a.md', form: 'case' }, ['article', 'outline', '--file', 'a.md', '--form', 'case']],
    ['article_set_title', { file: 'a.md', title: '新' }, ['article', 'set-title', '--file', 'a.md', '--title', '新']],
    ['article_library', { usable: true }, ['article', 'library', '--usable']],
    ['article_illustrate', { file: 'a.md', apply: true, max: 3 }, ['article', 'illustrate', '--file', 'a.md', '--max', '3', '--apply']],
    ['article_preset_remove', { id: 'mine' }, ['article', 'preset', 'remove', 'mine']],
    ['article_preset_remove', { id: 'standard', allowBuiltin: true }, ['article', 'preset', 'remove', 'standard', '--allow-builtin']],
    ['article_preset_reset', {}, ['article', 'preset', 'reset']],
  ]
  for (const [operation, params, expected] of cases) {
    assert.deepEqual(plugin.buildArgv(operation, params), expected, `${operation} 的 argv 不对`)
  }

  // article_brief 的参数最多，单独查
  assert.deepEqual(
    plugin.buildArgv('article_brief', { topic: 'T', form: 'tutorial', words: 1200, audience: 'A', angle: 'G' }),
    ['article', 'brief', '--topic', 'T', '--form', 'tutorial', '--words', '1200', '--audience', 'A', '--angle', 'G'],
  )
})

/**
 * `--base-url` 不能被追加两次。
 *
 * config_set_image_provider 的 `--base-url` 是「图片供应商接入地址」，
 * 与全局网关同名不同义。parseArgv 遇到重复 flag 是后写者胜出，
 * 若再追加一次网关地址，供应商地址会被悄悄替换成网关地址 —— 配图从此不通。
 */
test('base-url 不会被重复追加而覆盖供应商地址', () => {
  const argv = plugin.buildArgv('config_set_image_provider', {
    provider: 'openai',
    baseUrl: 'https://proxy.example.com',
  })
  assert.equal(argv.filter((item) => item === '--base-url').length, 1, '--base-url 只能出现一次')
  assert.deepEqual(argv, ['config', 'set', '--image-provider', 'openai', '--base-url', 'https://proxy.example.com'])

  // 其它命令仍然可以带网关地址
  const gateway = plugin.buildArgv('publish_status', { publishId: '42', baseUrl: 'http://127.0.0.1:9' })
  assert.deepEqual(gateway, ['publish', 'status', '--publish-id', '42', '--base-url', 'http://127.0.0.1:9'])
})
