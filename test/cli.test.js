/**
 * 端到端测试：进程内跑 wxmp 命令，对端是 test/support/fake-wechat.js。
 *
 * 覆盖真实链路：文章 → 校验 → 封面 → 上传素材 → 建草稿 → 提交发布 → 轮询成功。
 * 在进程内调用 dispatch 的原因同 winpilot：受限沙箱里子进程管道会 EPERM，
 * 而这些测试要验证的是命令语义与协议交互，不是进程边界。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(path.dirname(here), '.wxmp-e2e')
process.env.WXMP_HOME = home
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'articles'), { recursive: true })

const { startFakeWechat } = await import('./support/fake-wechat.js')
const { dispatch } = await import('../src/commands.js')
const { articleDir, loadConfig, tokenPath } = await import('../src/state.js')

const fake = await startFakeWechat({ expireNextToken: true, publishDelayMs: 1200 })

test.after(async () => {
  await fake.close()
  fs.rmSync(home, { recursive: true, force: true })
})

/** 永久素材（add_material）的上传次数 —— "反复刷稿堆素材"这件事的唯一判据。 */
function permanentUploads() {
  return fake.state.uploads.filter((item) => item.kind === 'permanent').length
}

/** 写一篇文章 + 一张封面到文章目录。 */
function seedArticle(name, options = {}) {
  const dir = articleDir()
  const png = path.join(dir, 'cover.png')
  fs.writeFileSync(png, fake.png)
  const body = options.body || '这是正文第一段，带 **重点**。\n\n## 小节\n\n- 要点一\n- 要点二'
  const content = `---
title: ${options.title || '测试文章'}
author: ${options.author || '张三'}
digest: ${options.digest || ''}
cover: ${options.cover === undefined ? './cover.png' : options.cover}
sourceUrl: ${options.sourceUrl || 'https://example.com/src'}
theme: ${options.theme || 'default'}
comments: false
---

${body}
`
  const file = path.join(dir, `${name}.md`)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

test('config：保存/查看/清除凭据，secret 只显示打码', async (t) => {
  await t.test('格式不对的 appid 被拒', async () => {
    await assert.rejects(
      () => dispatch('config', ['set'], { appid: 'bad', secret: 'x' }),
      (error) => error.code === 'appid_invalid',
    )
  })

  await t.test('保存后 show 能看到打码 secret', async () => {
    const saved = await dispatch('config', ['set'], {
      appid: 'wx1234567890abcdef',
      secret: fake.secret,
    })
    assert.equal(saved.ok, true)
    assert.equal(loadConfig().appid, 'wx1234567890abcdef')
    assert.equal(loadConfig().secret, fake.secret)

    const shown = await dispatch('config', ['show'], {})
    assert.match(shown.text, /wx1234567890abcdef/)
    assert.match(shown.text, /test\*\*\*et/, 'secret 必须是打码的')
    assert.ok(!shown.text.includes(fake.secret), 'secret 明文不能出现在输出里')
    assert.equal(shown.data.secretMasked, 'test***et')
  })

  await t.test('clear 清掉凭据与 token', async () => {
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: fake.secret })
    const cleared = await dispatch('config', ['clear'], {})
    assert.equal(cleared.ok, true)
    assert.equal(loadConfig().appid, '')
    assert.equal(fs.existsSync(tokenPath()), false)
  })
})

test('article：新建 / 列出 / 检查 / 预览', async (t) => {
  await t.test('new 生成可读模板', async () => {
    const created = await dispatch('article', ['new'], { title: '新建的文章', author: '李四' })
    assert.equal(created.ok, true)
    assert.ok(fs.existsSync(created.data.path))
    const read = await dispatch('article', ['show'], { file: created.data.path })
    assert.equal(read.data.article.title, '新建的文章')
  })

  await t.test('超长标题被拒', async () => {
    await assert.rejects(
      () => dispatch('article', ['new'], { title: '标'.repeat(40) }),
      (error) => error.code === 'title_too_long',
    )
  })

  await t.test('list 列出全部文章并带标题', async () => {
    seedArticle('list-a', { title: '列表里的文章' })
    const listed = await dispatch('article', ['list'], {})
    assert.ok(listed.data.articles.length >= 2)
    assert.ok(listed.data.articles.some((item) => item.title === '列表里的文章'))
    assert.match(listed.text, /列表里的文章/)
  })

  await t.test('check 报告超限与缺封面', async () => {
    const bad = seedArticle('too-long', {
      title: '这个标题故意写得非常非常长超过三十二个字的上限用来验证校验逻辑啊这总该超了吧',
      cover: '',
      digest: '摘'.repeat(130),
    })
    const checked = await dispatch('article', ['check'], { file: bad })
    assert.equal(checked.ok, false)
    assert.equal(checked.exitCode, 1)
    const fields = checked.data.report.issues.map((item) => item.field)
    assert.ok(fields.includes('title'), `issue fields = ${fields.join(',')}`)
    assert.ok(fields.includes('digest'))
    assert.match(checked.text, /✘/)
    assert.match(checked.text, /cover/, '缺封面应出现在警告里')
  })

  await t.test('check 通过时返回 ok', async () => {
    const good = seedArticle('good', { title: '合格文章' })
    const checked = await dispatch('article', ['check'], { file: good })
    assert.equal(checked.ok, true)
    assert.equal(checked.data.report.issues.length, 0)
  })

  await t.test('preview 产出可直接打开的 HTML', async () => {
    const file = seedArticle('preview-a', { title: '预览文章' })
    const preview = await dispatch('article', ['preview'], { file })
    assert.equal(preview.ok, true)
    const html = fs.readFileSync(preview.data.path, 'utf8')
    assert.match(html, /<!doctype html>/)
    assert.match(html, /预览文章/)
    assert.match(html, /本地预览/)
    assert.ok(html.includes('data:') || html.includes('file://'), '本地封面应换成可显示 URL')
  })
})

test('cover：生成 900×383 封面并写进文章目录', async () => {
  const file = seedArticle('cover-a', { title: '封面测试文章' })
  const out = path.join(path.dirname(file), 'generated-cover.png')
  const result = await dispatch('cover', ['--file', file], { file, out })
  assert.equal(result.ok, true)
  const buffer = fs.readFileSync(out)
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG')
  assert.equal(buffer.readUInt32BE(16), 900)
  assert.equal(buffer.readUInt32BE(20), 383)
  assert.match(result.text, /封面已生成/)
})

test('cover --width/--height：输出尺寸真的可改，越界夹边界，比例偏离只警告', async () => {
  // 2026-11-09 起 900×383 只是"默认推荐"，用户要能强行改。
  // 这个用例守的是"改了真的生效"——只在面板上写文案但后端不接，是最难查的那类假功能。
  const file = seedArticle('cover-size', { title: '自定义尺寸文章' })

  const custom = path.join(path.dirname(file), 'custom-cover.png')
  const changed = await dispatch('cover', ['--file', file], {
    file,
    out: custom,
    width: 1200,
    height: 500,
  })
  assert.equal(changed.ok, true, changed.text)
  const buf = fs.readFileSync(custom)
  assert.equal(buf.readUInt32BE(16), 1200, 'PNG 头里的宽度必须是改后的值')
  assert.equal(buf.readUInt32BE(20), 500, 'PNG 头里的高度必须是改后的值')
  assert.deepEqual(changed.data.coverSize, { width: 1200, height: 500 }, '结果里要回带实际尺寸')
  // 2.4:1 与推荐 2.35:1 只差 2% 出头 —— 这里只要求"尺寸生效"，警告有无都不该影响出图
  assert.match(changed.text, /1200×500 像素/)

  // 越界：夹到边界，并且必须说出来
  const tiny = path.join(path.dirname(file), 'tiny-cover.png')
  const clamped = await dispatch('cover', ['--file', file], {
    file,
    out: tiny,
    width: 50,
    height: 20,
  })
  assert.equal(clamped.ok, true, clamped.text)
  const tb = fs.readFileSync(tiny)
  assert.equal(tb.readUInt32BE(16), 320, '低于下限要夹到 320，而不是生成一张用不了的图')
  assert.equal(tb.readUInt32BE(20), 140)
  assert.match(clamped.text, /已夹到/, '夹了就必须告诉用户，否则他以为设置生效了')

  // 比例偏离：不拒绝（用户明确要"可以强行更改"），但要给警告
  const square = path.join(path.dirname(file), 'square-cover.png')
  const odd = await dispatch('cover', ['--file', file], {
    file,
    out: square,
    width: 800,
    height: 800,
  })
  assert.equal(odd.ok, true, odd.text)
  assert.equal(fs.readFileSync(square).readUInt32BE(16), 800, '比例不对也要照做，不能拒绝')
  assert.match(odd.text, /公众号会按推荐比例再裁一次/, '要说清后果，让用户自己决定')
})

test('article set-author：能改能清空，写命令不许省略 --file', async () => {
  const { loadArticle, patchFrontMatter } = await import('../src/article.js')

  seedArticle('改作者-原始', { title: '改作者', author: '老王' })
  const target = () => path.join(articleDir(), '改作者-原始.md')
  assert.equal(loadArticle(target()).author, '老王')

  // 1) 改成新名字：写回 front matter
  const changed = await dispatch('article', ['set-author'], { file: '改作者-原始', author: '张三' })
  assert.equal(changed.ok, true, changed.text)
  assert.equal(changed.data.before, '老王')
  assert.equal(changed.data.after, '张三')
  assert.equal(changed.data.changed, true)
  assert.equal(loadArticle(target()).author, '张三')

  // 2) 清空：`author:` 变成空值，三处读取点（封面副标题/预览 byline/面板作者行）就都不再显示它
  const cleared = await dispatch('article', ['set-author'], { file: '改作者-原始', author: '' })
  assert.equal(cleared.ok, true, cleared.text)
  assert.equal(cleared.data.after, '')
  assert.equal(loadArticle(target()).author, '', '清空后 author 必须是空字符串')
  assert.match(fs.readFileSync(target(), 'utf8'), /^author:\s*$/m, 'front matter 里应写成空键 author:')

  // 3) 已经是空再清一次：明确告知「没有改动」，不是默默成功
  const again = await dispatch('article', ['set-author'], { file: '改作者-原始', author: '' })
  assert.equal(again.data.changed, false)
  assert.match(again.text, /没有改动/)

  // 4) 超 16 字当场拒掉，且文件不被改动
  await assert.rejects(
    () => dispatch('article', ['set-author'], { file: '改作者-原始', author: '一二三四五六七八九十一二三四五六七' }),
    (error) => {
      assert.equal(error.code, 'author_too_long')
      assert.match(error.message, /上限 16/)
      return true
    },
  )
  assert.equal(loadArticle(target()).author, '', '被拒时不能已经写进去')

  // 5) 写命令必须点明目标文件。
  //    resolveArticleFile('') 会回落到「最近改动的那篇」，那样少写一个 --file
  //    就会悄悄改掉用户最近在写的稿子 —— 而且不报错。这条断言就是钉住它。
  const before = loadArticle(target()).author
  for (const [sub, extra] of [['set-author', { author: '李四' }], ['set-title', { title: '偷偷改名' }]]) {
    await assert.rejects(
      () => dispatch('article', [sub], extra),
      (error) => {
        assert.equal(error.code, 'args_required')
        assert.match(error.message, /必须写明 --file/)
        return true
      },
      `${sub} 缺 --file 时必须拒绝，不能回落到最近改动的文章`,
    )
  }
  const after = loadArticle(target())
  assert.equal(after.author, before, '被拒的写命令不能改动任何文件')
  assert.equal(after.title, '改作者', 'set-title 被拒后标题也不能变')

  // 6) 位置参数写法（`article set-author <文章> <作者>`）也能改到指定那篇。
  //    flags 仍要传：articleCmd 内部会读它，省略会炸（真实 CLI 由参数解析器保证非空）。
  patchFrontMatter(target(), { author: '老王' })
  const positional = await dispatch('article', ['set-author', '改作者-原始', '秋秋'], {})
  assert.equal(positional.ok, true, positional.text)
  assert.equal(loadArticle(target()).author, '秋秋')
})

test('article new：作者超 16 字当场拒掉，不留半成品文件', async () => {
  await assert.rejects(
    () => dispatch('article', ['new'], { title: '作者超长测试', author: 'Little Code Sauce' }),
    (error) => {
      assert.equal(error.code, 'author_too_long')
      assert.match(error.message, /上限 16/)
      return true
    },
  )
  assert.equal(
    fs.existsSync(path.join(articleDir(), '作者超长测试.md')),
    false,
    '拒绝时不能留下文件：半成品文章要等到建草稿才报错，最难查',
  )
})

test('封面 ↔ 草稿接缝：cover 自动写回，draft 本地兜底（0.1.0 就断在这里）', async (t) => {
  const { loadArticle, patchFrontMatter } = await import('../src/article.js')
  const { apiHint } = await import('../src/commands.js')

  await t.test('cover 默认生成 <文章名>-cover.png 并写回 front matter', async () => {
    const file = seedArticle('seam-a', { title: '接缝测试A', cover: '' })
    const result = await dispatch('cover', ['--file', file], { file })
    assert.equal(result.ok, true, result.text)
    const expected = path.join(path.dirname(file), 'seam-a-cover.png')
    assert.ok(fs.existsSync(expected), '默认输出必须是 <文章名>-cover.png，否则多篇文章会互相覆盖封面')
    assert.equal(result.data.coverRef, 'seam-a-cover.png')
    assert.equal(result.data.frontMatter.written, true)
    assert.equal(loadArticle(file).cover, 'seam-a-cover.png', '封面没写回 front matter 等于没封面')
    assert.match(result.text, /已写入 front matter/)
  })

  await t.test('draft create：文件里没写 cover 时自动兜底同目录封面，并写回', async () => {
    const file = seedArticle('seam-b', { title: '接缝测试B', cover: '' })
    const made = await dispatch('cover', ['--file', file], { file })
    assert.equal(made.ok, true, made.text)
    patchFrontMatter(file, { cover: '' }) // 模拟「生成过封面，但文件里就是没这一行」
    assert.equal(loadArticle(file).cover, '')
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: fake.secret })
    fake.reset()
    const created = await dispatch('draft', ['create'], { file, 'base-url': fake.baseUrl })
    assert.equal(created.ok, true, created.text)
    assert.equal(created.data.assets.coverAuto, true)
    assert.equal(created.data.assets.cover, 'seam-b-cover.png')
    assert.ok(
      fake.state.uploads.some((item) => item.kind === 'permanent'),
      '兜底来的封面也必须走永久素材，否则 thumb_media_id 还是无效',
    )
    const after = loadArticle(file)
    assert.equal(after.cover, 'seam-b-cover.png', '兜底后要写回，下次不再走兜底')
    assert.match(after.mediaId, /^draft_/)
  })

  await t.test('完全没有封面：本地就拦下，一个微信请求都不发', async () => {
    const shared = path.join(articleDir(), 'cover.png')
    if (fs.existsSync(shared)) fs.rmSync(shared)
    const file = path.join(articleDir(), 'seam-c.md')
    fs.writeFileSync(file, '---\ntitle: 接缝测试C\ncover:\ntheme: default\ncomments: false\n---\n\n正文一段。\n', 'utf8')
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: fake.secret })
    fake.reset()
    await assert.rejects(
      () => dispatch('draft', ['create'], { file, 'base-url': fake.baseUrl }),
      (error) => {
        assert.equal(error.code, 'cover_required')
        assert.match(error.message, /没有封面/)
        assert.match(error.message, /wxmp cover/)
        return true
      },
    )
    assert.equal(fake.state.calls.length, 0, '缺封面必须在本地拦下，不能等微信回 40007')
  })

  await t.test('40007 的提示要说清「也可能压根没传封面」', () => {
    assert.match(apiHint(40007), /没传封面/)
    assert.match(apiHint(48001), /认证服务号/)
  })
})

test('draft + publish 全链路（假微信服务器）', async (t) => {
  const file = seedArticle('flow', { title: '全链路文章' })

  await t.test('未配置凭据时报 credentials_missing', async () => {
    await dispatch('config', ['clear'], {})
    await assert.rejects(() => dispatch('draft', ['create'], { file }), (error) => error.code === 'credentials_missing')
  })

  await t.test('配置凭据后 dry-run 不产生任何网络请求', async () => {
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: fake.secret })
    fake.reset()
    const dry = await dispatch('draft', ['create'], { file, 'dry-run': true })
    assert.equal(dry.ok, true)
    assert.equal(dry.data.dryRun, true)
    assert.equal(fake.state.calls.length, 0, 'dry-run 不能调用接口')
    assert.match(dry.text, /去掉 --dry-run 才会真正调用接口/)
  })

  await t.test('draft create：上传封面+正文图，建草稿，写回 mediaId', async () => {
    // 正文里加一张本地图片，验证 uploadimg 与 src 回填
    const withImage = seedArticle('flow-img', {
      title: '带图的文章',
      body: '开头一段。\n\n![配图](./cover.png)\n\n结尾。',
    })
    const created = await dispatch('draft', ['create'], {
      file: withImage,
      'base-url': fake.baseUrl,
    })
    assert.equal(created.ok, true, created.text)
    assert.match(created.data.mediaId, /^draft_/)
    assert.ok(created.data.assets.thumbMediaId.startsWith('media_'))

    const uploadKinds = fake.state.uploads.map((item) => item.kind)
    assert.ok(uploadKinds.includes('permanent'), '封面走永久素材')
    assert.ok(uploadKinds.includes('content'), '正文图走 uploadimg')

    const draft = fake.state.drafts.get(created.data.mediaId)
    const article = draft.content.news_item[0]
    assert.equal(article.title, '带图的文章')
    assert.ok(article.digest.length <= 120)
    assert.ok(article.thumb_media_id.startsWith('media_'))
    assert.match(article.content, /src="http:\/\/mmbiz\.qpic\.cn\//, '正文图片必须换成 mmbiz URL')
    assert.ok(!article.content.includes('./cover.png'), '原始相对路径不能留在正文里')

    const reread = await dispatch('article', ['show'], { file: withImage })
    assert.equal(reread.data.article.mediaId, created.data.mediaId, 'mediaId 应写回 front matter')
  })

  await t.test('draft list / get / count 读到刚建的草稿', async () => {
    const listed = await dispatch('draft', ['list'], { 'base-url': fake.baseUrl })
    assert.ok(listed.data.items.length >= 1)
    const mediaId = listed.data.items[0].mediaId
    const got = await dispatch('draft', ['get'], { 'base-url': fake.baseUrl, 'media-id': mediaId })
    assert.equal(got.data.news.length, 1)
    assert.match(got.text, /临时链接/)
    const counted = await dispatch('draft', ['count'], { 'base-url': fake.baseUrl })
    assert.equal(counted.data.total, fake.state.drafts.size)
  })

  await t.test('反复刷稿不堆永久素材：封面没变就不重复 add_material', async () => {
    /* 这是用户报的那个坑：每次 draft update 都把封面重新 add_material 一次，
     * 公众号后台就多一条永久素材，而且删不干净。 */
    const file = seedArticle('reuse', { title: '反复改的稿子' })
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: fake.secret })
    fake.reset()

    const created = await dispatch('draft', ['create'], { file, 'base-url': fake.baseUrl })
    assert.equal(created.ok, true, created.text)
    assert.equal(created.data.assets.thumbFrom, 'upload', '第一次必须真上传')
    assert.equal(permanentUploads(), 1)

    // 写回的 thumbMediaId + coverHash 是后面能复用的前提
    const reread = await dispatch('article', ['show'], { file })
    assert.equal(reread.data.article.thumbMediaId, created.data.assets.thumbMediaId)
    assert.match(reread.data.article.coverHash, /^sha1:[0-9a-f]{40}$/)

    const mediaId = created.data.mediaId
    for (let round = 1; round <= 3; round += 1) {
      const updated = await dispatch('draft', ['update'], {
        file,
        'media-id': mediaId,
        'base-url': fake.baseUrl,
      })
      assert.equal(updated.ok, true, updated.text)
      assert.equal(updated.data.thumbFrom, 'reuse', `第 ${round} 次更新应复用封面素材`)
      assert.equal(permanentUploads(), 1, `第 ${round} 次更新不该新增永久素材`)
    }
  })

  await t.test('封面真的换了才重新上传一张', async () => {
    const file = seedArticle('reuse-change', { title: '换封面的稿子' })
    const created = await dispatch('draft', ['create'], { file, 'base-url': fake.baseUrl })
    fake.reset()
    assert.equal(permanentUploads(), 0)

    // 同一路径、不同内容 —— 只有内容指纹变了才该重传（改文件名骗不过去）
    fs.writeFileSync(path.join(path.dirname(file), 'cover.png'), Buffer.concat([fake.png, Buffer.from('不同的一张图')]))
    const updated = await dispatch('draft', ['update'], {
      file,
      'media-id': created.data.mediaId,
      'base-url': fake.baseUrl,
    })
    assert.equal(updated.ok, true, updated.text)
    assert.equal(updated.data.thumbFrom, 'upload', '封面内容变了就该重新上传')
    assert.equal(permanentUploads(), 1)
    const reread = await dispatch('article', ['show'], { file })
    assert.equal(reread.data.article.thumbMediaId, updated.data.thumbMediaId, '新素材 id 要写回')
  })

  await t.test('复用的素材失效（40007）时自动重传，不把错误丢给用户', async () => {
    const file = seedArticle('reuse-stale', { title: '素材被删了的稿子' })
    const created = await dispatch('draft', ['create'], { file, 'base-url': fake.baseUrl })
    fake.reset()
    assert.equal(permanentUploads(), 0)

    // 模拟"这条 media_id 被人在后台删了"
    fake.state.rejectNextDraft = true
    const updated = await dispatch('draft', ['update'], {
      file,
      'media-id': created.data.mediaId,
      'base-url': fake.baseUrl,
    })
    assert.equal(updated.ok, true, `自愈后应当成功：${updated.text}`)
    assert.equal(permanentUploads(), 1, '应当重新上传了一张封面')
    assert.equal(updated.data.thumbFrom, 'upload')
    assert.match(updated.text, /素材已失效/)
    const reread = await dispatch('article', ['show'], { file })
    assert.equal(reread.data.article.thumbMediaId, updated.data.thumbMediaId, '自愈后的新 id 要写回')
  })

  await t.test('draft update 改标题后草稿生效', async () => {
    const listed = await dispatch('draft', ['list'], { 'base-url': fake.baseUrl })
    const mediaId = listed.data.items[0].mediaId
    const target = seedArticle('upd', { title: '改过的标题' })
    const updated = await dispatch('draft', ['update'], {
      file: target,
      'media-id': mediaId,
      'base-url': fake.baseUrl,
    })
    assert.equal(updated.ok, true)
    assert.equal(fake.state.drafts.get(mediaId).content.news_item[0].title, '改过的标题')
  })

  await t.test('publish submit 没有 --yes 只 dry-run', async () => {
    const listed = await dispatch('draft', ['list'], { 'base-url': fake.baseUrl })
    const mediaId = listed.data.items[0].mediaId
    fake.reset()
    const dry = await dispatch('publish', ['submit'], { 'media-id': mediaId, 'base-url': fake.baseUrl })
    assert.equal(dry.data.dryRun, true)
    assert.equal(fake.state.calls.length, 0)
    assert.match(dry.text, /--yes/)
  })

  await t.test('publish submit --yes 提交后 wait 等到成功', async () => {
    const fileReady = seedArticle('final', { title: '最终发布文章' })
    const created = await dispatch('draft', ['create'], { file: fileReady, 'base-url': fake.baseUrl })
    assert.equal(created.ok, true)

    const submitted = await dispatch('publish', ['submit'], {
      file: fileReady,
      yes: true,
      'base-url': fake.baseUrl,
    })
    assert.equal(submitted.ok, true, submitted.text)
    const publishId = submitted.data.publishId
    assert.ok(publishId)

    const waited = await dispatch('publish', ['wait'], {
      'publish-id': publishId,
      'base-url': fake.baseUrl,
      interval: 400,
      timeout: 8000,
    })
    assert.equal(waited.ok, true, waited.text)
    assert.equal(waited.data.publish_status, 0)
    assert.match(waited.text, /发布成功/)
    assert.match(waited.text, /mp\.weixin\.qq\.com/)

    // 发布成功后草稿被移除（真实行为）
    assert.equal(fake.state.drafts.has(created.data.mediaId), false)
  })

  await t.test('publish list 能看到已发布文章', async () => {
    const listed = await dispatch('publish', ['list'], { 'base-url': fake.baseUrl })
    assert.ok(listed.data.items.length >= 1)
    assert.match(listed.text, /最终发布文章/)
  })
})

test('错误处理：token 过期自动刷新、未授权接口、发布失败状态', async (t) => {
  await t.test('expireNextToken 会触发刷新并重试', async () => {
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: fake.secret })
    // 清掉 token 缓存，下一次调用拿到的 token 立刻作废
    fake.reset()
    const before = fake.state.calls.filter((call) => call.path === '/cgi-bin/stable_token').length
    fs.rmSync(tokenPath(), { force: true })
    const counted = await dispatch('draft', ['count'], { 'base-url': fake.baseUrl })
    assert.equal(counted.ok, true, counted.text)
    const after = fake.state.calls.filter((call) => call.path === '/cgi-bin/stable_token').length
    assert.ok(after >= before + 1, '应该至少取了一次 token')
  })

  await t.test('秘密不对时报 40125 并给修复建议', async () => {
    await dispatch('config', ['set'], { appid: 'wx1234567890abcdef', secret: 'wrong-secret' })
    fs.rmSync(tokenPath(), { force: true })
    await assert.rejects(
      () => dispatch('draft', ['count'], { 'base-url': fake.baseUrl }),
      (error) => {
        assert.equal(error.code, 'wechat_40125')
        assert.match(error.message, /AppSecret 无效/)
        return true
      },
    )
  })

  await t.test('发布失败状态映射成可读文案', async () => {
    const { describePublishStatus } = await import('../src/commands.js')
    assert.equal(describePublishStatus(0).label, '发布成功')
    assert.equal(describePublishStatus(1).label, '发布中')
    assert.equal(describePublishStatus(2).label, '原创校验失败')
    assert.match(describePublishStatus(4).note, /不合规/)
    assert.equal(describePublishStatus(99).label, '未知状态')
  })
})

test('preset prompt：预设作为写作提示词交出去（不带 id 用当前生效的）', async (t) => {
  await t.test('prompt <id> 返回风格正文 + 节奏参考', async () => {
    const result = await dispatch('article', ['preset', 'prompt', 'deep-longform'], {})
    assert.equal(result.ok, true, result.text)
    assert.equal(result.data.id, 'deep-longform')
    assert.equal(result.data.hasStyle, true, '内置预设必须带风格')
    assert.match(result.text, /# 写作提示词 · 深度长文/)
    assert.match(result.text, /## 节奏参考/)
    assert.match(result.text, /及格线 \d+ 分/, '节奏行要带真实阈值')
  })

  await t.test('不带 id 时落到当前生效预设', async () => {
    await dispatch('article', ['preset', 'use', 'short-punch'], {})
    const result = await dispatch('article', ['preset', 'prompt'], {})
    assert.equal(result.ok, true, result.text)
    assert.equal(result.data.id, 'short-punch', '不传 id 应该用 config 里的当前预设')
    assert.equal(result.data.hasStyle, true)
  })

  await t.test('prompt 拿一个不存在的预设：回落 standard 但必须说清', async () => {
    const result = await dispatch('article', ['preset', 'prompt', 'no-such-preset'], {})
    assert.equal(result.ok, true, '拿不到预设不该炸——写作侧还要继续干活')
    assert.equal(result.data.id, 'standard', '实际按 standard 生成')
    assert.ok(
      (result.data.notes || []).some((note) => /找不到预设 no-such-preset/.test(note)),
      '必须明确说「找不到预设」，静默换成 standard 是坑',
    )
    assert.match(result.text, /找不到预设 no-such-preset/)
  })

  await t.test('brief 把当前预设的风格节写进任务书', async () => {
    const brief = await dispatch('article', ['brief', 'AI 工作台实操教程'], {
      form: '教程',
      words: 3000,
    })
    assert.equal(brief.ok, true, brief.text)
    assert.ok(brief.data.preset, 'brief 结果必须带 preset 元信息')
    assert.ok(brief.data.preset.id, 'preset.id 缺失')
    assert.equal(brief.data.preset.id, 'short-punch', 'brief 默认用当前生效的预设')
    assert.match(brief.data.markdown, /风格/, '任务书里要有风格节')
  })
})
