/**
 * 公众号文章提取的测试。
 *
 * 重点验证三件容易静默出错的事：
 *  1. **只抓 mp.weixin.qq.com**（否则用户贴任意 URL 就能让插件访问内网 —— SSRF）
 *  2. **错误页要分辨清楚**：链接过期 / 被屏蔽 / 访问频繁 的下一步完全不同
 *  3. **元数据优先读 JS 变量**：这是原实现的主力路径，HTML 容器只做兜底
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EXTRACT_ERRORS,
  ExtractError,
  buildMarkdownFile,
  decodeEntities,
  extractElementHtml,
  formatDate,
  htmlToMarkdown,
  normalizeArticleUrl,
  parseArticleHtml,
  readJsVar,
} from '../lib/absorbed/wechat-extractor.js'

/** 造一份最小但真实的公众号页面结构。 */
function makePage(overrides = {}) {
  const meta = {
    title: '把公众号写作搬进 AI 工作台',
    author: 'YG',
    nickname: '插件实践',
    ct: '1785767088',
    desc: '一句话说清这篇要讲什么',
    ...overrides.meta,
  }
  const body = overrides.body ?? '<p>第一段内容。</p><p>第二段<strong>加粗</strong>内容。</p>'
  return `<!DOCTYPE html><html><head><title>${meta.title}</title></head><body>
<script>
var msg_title = '${meta.title}';
var author = '${meta.author}';
var nickname = '${meta.nickname}';
var ct = "${meta.ct}";
var msg_desc = '${meta.desc}';
</script>
<div id="page-content">
  <h1 class="rich_media_title" id="activity-name">${meta.title}</h1>
  <div class="profile_nickname">${meta.nickname}</div>
  <div id="js_content" style="visibility:hidden;">
    ${body}
  </div>
</div>
</body></html>`
}

test('URL 白名单：只接受 mp.weixin.qq.com（拒绝任意站点，避免成为 SSRF 跳板）', () => {
  // 合法
  assert.equal(
    normalizeArticleUrl('https://mp.weixin.qq.com/s/abc123'),
    'https://mp.weixin.qq.com/s/abc123',
  )
  // 不合法：别的域名
  for (const bad of [
    'https://evil.com/s/x',
    'http://127.0.0.1:8080/admin',
    'http://192.168.1.1/',
    'https://mp.weixin.qq.com.evil.com/s/x',
  ]) {
    assert.throws(
      () => normalizeArticleUrl(bad),
      (error) => {
        assert.equal(error.code, 2001, `${bad} 应被拒绝`)
        return true
      },
      `${bad} 不该被接受`,
    )
  }
  // 非 http(s) 协议
  assert.throws(() => normalizeArticleUrl('file:///etc/passwd'), (e) => e.code === 2001)
  assert.throws(() => normalizeArticleUrl(''), (e) => e.code === 2001)
})

test('解析：从 JS 变量读到标题/作者/账号/时间/摘要', () => {
  const article = parseArticleHtml(makePage(), 'https://mp.weixin.qq.com/s/x')
  assert.equal(article.title, '把公众号写作搬进 AI 工作台')
  assert.equal(article.author, 'YG')
  assert.equal(article.account, '插件实践')
  assert.equal(article.digest, '一句话说清这篇要讲什么')
  // ct 是秒级时间戳，要转成 YYYY/MM/DD HH:mm:ss
  assert.match(article.publishTime, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.ok(article.charCount > 0)
})

test('解析：正文从 js_content 取出并转成 Markdown', () => {
  const article = parseArticleHtml(makePage(), 'https://mp.weixin.qq.com/s/x')
  assert.match(article.markdown, /第一段内容/)
  assert.match(article.markdown, /第二段/)
  // 加粗保留
  assert.match(article.markdown, /\*\*加粗\*\*/)
})

test('元数据兜底：没有 JS 变量时退回 HTML 容器', () => {
  const page = `<html><body>
    <h1 class="rich_media_title" id="activity-name">  标题从 HTML 来  </h1>
    <div class="profile_nickname">账号从 HTML 来</div>
    <div id="js_content"><p>正文</p></div>
  </body></html>`
  const article = parseArticleHtml(page, 'https://mp.weixin.qq.com/s/x')
  assert.equal(article.title, '标题从 HTML 来', 'HTML 里的标题要去掉首尾空白')
  assert.equal(article.account, '账号从 HTML 来')
})

test('错误页：链接过期 / 被屏蔽 / 访问频繁 分别给不同码', () => {
  const cases = [
    ['<div class="weui-msg__title">链接已过期</div>', 2002],
    ['<div>此帐号已被屏蔽</div>', 2012],
    ['<div>此帐号已自主注销</div>', 2013],
    ['<div>访问过于频繁，请稍后再试</div>', 2016],
    ['<div>此帐号处于帐号迁移流程中</div>', 2015],
  ]
  for (const [html, code] of cases) {
    assert.throws(
      () => parseArticleHtml(html, 'https://mp.weixin.qq.com/s/x'),
      (error) => {
        assert.ok(error instanceof ExtractError)
        assert.equal(error.code, code, `${html.slice(0, 20)} 应报 ${code}`)
        // 错误消息必须是人能照着做的（对照表里每条都有说明）
        assert.ok(EXTRACT_ERRORS[code], `${code} 缺少可读说明`)
        return true
      },
    )
  }
})

test('错误页：完全找不到正文容器 → 2018，且提示是非图文类型', () => {
  assert.throws(
    () => parseArticleHtml('<html><body><p>什么都没有</p></body></html>', 'https://mp.weixin.qq.com/s/x'),
    (error) => {
      assert.equal(error.code, 2018)
      assert.match(error.message, /非图文|正文/)
      return true
    },
  )
})

test('正文提取：嵌套 div 时不能只取到第一层就截断', () => {
  // 这是 extractElementHtml 最容易写错的地方：深度计数错了会漏掉后半篇
  const html = `<div id="js_content"><div><p>内层一</p></div><div><p>内层二</p></div><p>外层结尾</p></div>`
  const inner = extractElementHtml(html, 'js_content')
  assert.match(inner, /内层一/)
  assert.match(inner, /内层二/)
  assert.match(inner, /外层结尾/, '嵌套层结束后不能丢内容')
})

test('HTML → Markdown：图片/链接/标题/列表都要保住结构', () => {
  const md = htmlToMarkdown(`
    <h2>小标题</h2>
    <p>正文里有一张图</p>
    <img src="https://mmbiz.qpic.cn/a.png">
    <p>还有一个<a href="https://example.com">链接</a></p>
    <ul><li>条目一</li><li>条目二</li></ul>
  `)
  assert.match(md, /^## 小标题/m, '标题层级要保留')
  assert.match(md, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/a\.png\)/, '图片要保留成 Markdown 图片')
  assert.match(md, /\[链接\]\(https:\/\/example\.com\)/, '链接要保留')
  assert.match(md, /- 条目一/, '列表要保留')
  // 不能把整篇压成一行
  assert.ok(md.includes('\n'), '必须有换行，否则重新排版会全挤在一起')
})

test('formatDate：秒级与毫秒级时间戳都认，非法值返回 null', () => {
  // 秒级
  assert.match(formatDate('1785767088'), /^\d{4}\/\d{2}\/\d{2}/)
  // 毫秒级
  assert.match(formatDate(1785767088000), /^\d{4}\/\d{2}\/\d{2}/)
  for (const bad of [0, null, undefined, '', 'abc', -1]) {
    assert.equal(formatDate(bad), null, `${JSON.stringify(bad)} 应返回 null`)
  }
})

test('decodeEntities：数字实体与常用命名实体都能解', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;'), '&<>')
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB')
  assert.equal(decodeEntities('&ldquo;引号&rdquo;'), '“引号”')
  // 不认识的实体原样保留（不能把它吃掉）
  assert.equal(decodeEntities('&unknown;'), '&unknown;')
})

test('readJsVar：单引号/双引号/window. 三种写法都能读', () => {
  assert.equal(readJsVar(`var msg_title = '标题一'`, 'msg_title'), '标题一')
  assert.equal(readJsVar(`var msg_title = "标题二"`, 'msg_title'), '标题二')
  assert.equal(readJsVar(`window.msg_title = "标题三"`, 'msg_title'), '标题三')
  assert.equal(readJsVar(`"msg_title" : "标题四"`, 'msg_title'), '标题四')
  assert.equal(readJsVar('nothing here', 'msg_title'), null)
})

test('buildMarkdownFile：产出带 front matter 的完整文件，键与 wxmp 现有格式一致', () => {
  const article = parseArticleHtml(makePage(), 'https://mp.weixin.qq.com/s/abc')
  const file = buildMarkdownFile(article)
  assert.match(file, /^---\n/, '必须以 front matter 开头')
  assert.match(file, /^title: 把公众号写作搬进 AI 工作台$/m)
  assert.match(file, /^author: YG$/m)
  assert.match(file, /^sourceUrl: https:\/\/mp\.weixin\.qq\.com\/s\/abc$/m)
  // 空值也要保留键（wxmp 的 patchFrontMatter 需要这些键存在）
  assert.match(file, /^digest:/m)
  // 正文必须在 front matter 之后
  assert.match(file, /---\n\n[\s\S]*第一段内容/)
})

test('真实页面结构：htmlDecode 包裹的变量必须能读出来（否则摘要会抓到整个作者区块）', () => {
  // 实测（2026-11-08 真实文章）：部分字段被包在 htmlDecode(...) 里：
  //   var msg_desc = htmlDecode("大模型会聊天...")
  //   var nickname = htmlDecode("快乐愿享")
  // 早先只认裸字符串，导致摘要退回 rich_media_meta_list 容器，
  // 抓到的是"原创 作者 账号名"那排 meta，结果是"快乐愿享 快乐愿享 快乐愿享"。
  const page = `<html><body>
    <script>
    var msg_title = '标题';
    var msg_desc = htmlDecode("真正的摘要内容");
    var nickname = htmlDecode("快乐愿享");
    var author = "快乐愿享";
    var ct = "1793640546";
    </script>
    <div id="js_content"><p>正文</p></div>
    <div class="rich_media_meta_list">原创 快乐愿享 快乐愿享</div>
  </body></html>`
  const article = parseArticleHtml(page, 'https://mp.weixin.qq.com/s/x')
  assert.equal(article.digest, '真正的摘要内容', '摘要必须来自 msg_desc，而不是作者区块')
  assert.equal(article.account, '快乐愿享', 'nickname 被 htmlDecode 包裹时也要能读')
  assert.doesNotMatch(article.digest, /快乐愿享/, '摘要里不能混入账号名')
})

test('摘要为空时宁可留空，也不拿作者区块充数', () => {
  const page = `<html><body>
    <script>var msg_title = '标题';</script>
    <div id="js_content"><p>正文</p></div>
    <div class="rich_media_meta_list">原创 某个账号</div>
  </body></html>`
  const article = parseArticleHtml(page, 'https://mp.weixin.qq.com/s/x')
  assert.equal(article.digest, '', '没有真摘要时应为空，不能把作者区块当摘要')
})

test('meta 标签兜底：JS 变量全缺失时仍能拿到标题/摘要/作者', () => {
  const page = `<html><head>
    <meta property="og:title" content="从 meta 来的标题">
    <meta property="og:description" content="从 meta 来的摘要">
    <meta name="author" content="从 meta 来的作者">
  </head><body><div id="js_content"><p>正文</p></div></body></html>`
  const article = parseArticleHtml(page, 'https://mp.weixin.qq.com/s/x')
  assert.equal(article.title, '从 meta 来的标题')
  assert.equal(article.digest, '从 meta 来的摘要')
  assert.equal(article.author, '从 meta 来的作者')
})

test('decodeJsEscapes：解开 \\xNN 与 \\uNNNN 转义', async () => {
  const { decodeJsEscapes } = await import('../lib/absorbed/wechat-extractor.js')
  assert.equal(decodeJsEscapes('\\u4e2d\\u6587'), '中文')
  assert.equal(decodeJsEscapes('\\x41\\x42'), 'AB')
  assert.equal(decodeJsEscapes('a\\\\b'), 'a\\b')
  assert.equal(decodeJsEscapes(''), '')
})

test('safeFileName：全角标点也要清掉（从公众号标题直接来时最常见）', async () => {
  const { safeFileName } = await import('../src/article.js')
  // 真实标题：带全角冒号
  const name = safeFileName('DSH 是什么：一个把 AI 变成能干活的操作台')
  assert.doesNotMatch(name, /[：？！，。；、“”（）【】《》…—]/, `文件名仍含全角标点：${name}`)
  assert.doesNotMatch(name, /[\\/:*?"<>|]/, '不能含 Windows 非法字符')
  assert.doesNotMatch(name, /^-|-$/, '首尾不能有短横线')
  // 连续标点不能连出一串短横线
  assert.doesNotMatch(safeFileName('测试，，。。；；结尾'), /-{2,}/)
})

test('抓取：网络异常映射成 2003，不乱抛原始错误', async () => {
  const { extractArticle } = await import('../lib/absorbed/wechat-extractor.js')
  await assert.rejects(
    () => extractArticle('https://mp.weixin.qq.com/s/x', {
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    }),
    (error) => {
      assert.equal(error.code, 2003)
      assert.match(error.message, /ECONNRESET/)
      return true
    },
  )
})

test('抓取：HTTP 非 200 映射成 2003', async () => {
  const { extractArticle } = await import('../lib/absorbed/wechat-extractor.js')
  await assert.rejects(
    () => extractArticle('https://mp.weixin.qq.com/s/x', {
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    (error) => {
      assert.equal(error.code, 2003)
      assert.match(error.message, /404/)
      return true
    },
  )
})

test('抓取：成功路径能拿到页面并解析', async () => {
  const { extractArticle } = await import('../lib/absorbed/wechat-extractor.js')
  const article = await extractArticle('https://mp.weixin.qq.com/s/ok', {
    fetchImpl: async () => ({ ok: true, text: async () => makePage() }),
  })
  assert.equal(article.title, '把公众号写作搬进 AI 工作台')
  assert.ok(article.markdown.length > 0)
})
