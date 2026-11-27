import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(path.dirname(here), '.wxmp-unit')
process.env.WXMP_HOME = home
fs.rmSync(home, { recursive: true, force: true })

const { parseFrontMatter, newArticleTemplate, safeFileName, patchFrontMatter, loadArticle, resolveAssetPath } =
  await import('../src/article.js')
const { encodeMultipart, guessContentType } = await import('../src/multipart.js')
const { parseArgv, flagString, flagNumber, flagBool } = await import('../src/args.js')
const { truncate, humanBytes, humanTime, readDataPath } = await import('../src/output.js')
const { resolveCredentials, saveConfig, maskSecret, homeDir } = await import('../src/state.js')
const { renderGradientPng } = await import('../tools/cover.js')

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

test('front matter 解析与回写', () => {
  const source = '---\ntitle: 测试标题\nauthor: 张三\ntheme: dark\ncomments: true\ncover: ./c.png\n---\n正文第一段'
  const { meta, body } = parseFrontMatter(source)
  assert.equal(meta.title, '测试标题')
  assert.equal(meta.comments, true)
  assert.equal(body.trim(), '正文第一段')

  const noFront = parseFrontMatter('直接是正文')
  assert.deepEqual(noFront.meta, {})
  assert.equal(noFront.body, '直接是正文')

  const file = path.join(home, 'pm.md')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, source, 'utf8')
  patchFrontMatter(file, { mediaId: 'draft_1' })
  const reloaded = parseFrontMatter(fs.readFileSync(file, 'utf8'))
  assert.equal(reloaded.meta.mediaId, 'draft_1')
  assert.equal(reloaded.meta.title, '测试标题')
})

test('patchFrontMatter 保留空键：不能把用户 front matter 的空行整条删掉', () => {
  const file = path.join(home, 'patch-empty.md')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, '---\ntitle: 空键测试\ndigest: \nsourceUrl: \ncover: \n---\n正文', 'utf8')
  patchFrontMatter(file, { cover: 'a-cover.png' })
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^digest:$/m, 'digest 空键丢了：旧实现每跑一次 draft create 就悄悄改一次用户文件')
  assert.match(text, /^sourceUrl:$/m)
  assert.match(text, /^cover: a-cover\.png$/m)
  assert.equal(loadArticle(file).cover, 'a-cover.png')
})

test('新建模板能被 loadArticle 读回并通过标题校验', () => {
  const file = path.join(home, 'tpl.md')
  fs.writeFileSync(file, newArticleTemplate({ title: '模板测试', author: '作者' }), 'utf8')
  const article = loadArticle(file)
  assert.equal(article.title, '模板测试')
  assert.equal(article.theme, 'default')
  assert.ok(article.body.length > 50)
  assert.equal(article.comments, false)
})

test('safeFileName 去掉非法字符但保留中文', () => {
  assert.equal(safeFileName('标题: 带/斜杠*星'), '标题-带斜杠星')
  assert.ok(safeFileName('纯中文标题').startsWith('纯中文标题'))
})

test('resolveAssetPath：本地命中、远程透传、缺失报错', () => {
  const dir = path.join(home, 'assets-test')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cover.png'), 'x')
  const article = { dir }
  assert.deepEqual(resolveAssetPath(article, './cover.png'), { kind: 'local', value: path.join(dir, 'cover.png') })
  assert.deepEqual(resolveAssetPath(article, 'https://a.com/b.png'), { kind: 'remote', value: 'https://a.com/b.png' })
  assert.throws(() => resolveAssetPath(article, './nope.png'), (error) => error.code === 'asset_not_found')
})

test('multipart 编码包含字段、文件名与正确内容类型', () => {
  const { body, contentType } = encodeMultipart({
    fields: { type: 'image' },
    files: [{ name: 'media', filename: '封面.png', data: Buffer.from('abc') }],
  })
  const text = body.toString('utf8')
  assert.match(contentType, /^multipart\/form-data; boundary=wxmp-/)
  assert.match(text, /Content-Disposition: form-data; name="type"/)
  assert.match(text, /Content-Disposition: form-data; name="media"; filename="封面\.png"/)
  assert.match(text, /Content-Type: image\/png/)
  assert.ok(text.includes('abc'))
  assert.ok(text.trimEnd().endsWith(`--${contentType.split('boundary=')[1]}--`))

  assert.equal(guessContentType('a.JPG'), 'image/jpeg')
  assert.equal(guessContentType('a.bin'), 'application/octet-stream')
})

test('参数解析支持子命令、--key value、--flag、= 形式', () => {
  const parsed = parseArgv(['draft', 'create', '--file', 'a.md', '--dry-run', '--index=2', '--json'])
  assert.equal(parsed.command, 'draft')
  assert.deepEqual(parsed.positional, ['create'])
  assert.equal(parsed.flags.file, 'a.md')
  assert.equal(parsed.flags['dry-run'], true)
  assert.equal(parsed.flags.index, '2')
  assert.equal(flagNumber(parsed.flags, 'index', 0), 2)
  assert.equal(flagBool(parsed.flags, 'dry-run'), true)
  assert.equal(flagString(parsed.flags, 'file', ''), 'a.md')
})

test('输出工具：截断、字节、时间', () => {
  const long = 'y'.repeat(4100)
  assert.ok(truncate(long).endsWith('[truncated, originalLength=4100]'))
  assert.equal(humanBytes(512), '512 B')
  assert.equal(humanBytes(1572864), '1.5 MB')
  const time = humanTime(1760000000)
  assert.match(time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(humanTime(0), '-')
})

test('凭据：环境变量优先、config 次之、打码正确', () => {
  delete process.env.WXMP_APPID
  delete process.env.WXMP_SECRET
  // 同一进程里多个测试文件共用模块状态，先把本测试自己的 config 清干净
  fs.rmSync(path.join(home, 'config.json'), { force: true })
  assert.equal(resolveCredentials().source, 'none')
  assert.deepEqual(resolveCredentials().missing.sort(), ['appid', 'secret'])

  saveConfig({ appid: 'wx1234567890abcdef', secret: 'abcdefghijklmnop' })
  assert.equal(resolveCredentials().source, 'config')

  process.env.WXMP_APPID = 'wxfromenv123456789'
  process.env.WXMP_SECRET = 'envsecret'
  assert.equal(resolveCredentials().source, 'env')
  assert.equal(resolveCredentials().appid, 'wxfromenv123456789')

  delete process.env.WXMP_APPID
  delete process.env.WXMP_SECRET
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd***op')
  assert.equal(maskSecret(''), '(空)')
  assert.equal(maskSecret('abc'), 'a***')
})

test('纯 JS 渐变 PNG 是合法 PNG 且尺寸正确', () => {
  const buffer = renderGradientPng({ width: 90, height: 38, theme: 'dark' })
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG')
  // IHDR 宽高在固定偏移（8 字节签名 + 4 长度 + 4 type + 4 宽 + 4 高）
  assert.equal(buffer.readUInt32BE(16), 90)
  assert.equal(buffer.readUInt32BE(20), 38)
  assert.ok(buffer.length > 100)
})
