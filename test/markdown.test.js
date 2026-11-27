import test from 'node:test'
import assert from 'node:assert/strict'

import {
  makeDigest,
  outline,
  parseInline,
  parseMarkdown,
  plainText,
  renderHtml,
  stats,
  themeByName,
  THEMES,
} from '../src/markdown.js'

test('解析标题、段落、列表、引用、代码块、表格', () => {
  const md = `# 一级标题

第一段文字，带 **粗体** 和 *斜体*。

## 二级标题

- 项目一
- 项目二
  接续内容

1. 第一步
2. 第二步

> 引用一段话

\`\`\`js
console.log(1)
\`\`\`

| 名称 | 说明 |
| --- | --- |
| a | 第一 |

---

最后一段。`

  const nodes = parseMarkdown(md)
  const types = nodes.map((node) => node.type)
  assert.deepEqual(types, [
    'heading',
    'paragraph',
    'heading',
    'list',
    'list',
    'quote',
    'code',
    'table',
    'hr',
    'paragraph',
  ])
  assert.equal(nodes[0].level, 1)
  assert.equal(nodes[2].level, 2)
  assert.equal(nodes[3].ordered, false)
  assert.equal(nodes[3].items.length, 2)
  assert.equal(nodes[4].ordered, true)
  assert.equal(nodes[6].lang, 'js')
  assert.equal(nodes[6].value, 'console.log(1)')
  assert.deepEqual(nodes[7].header, ['名称', '说明'])
  assert.deepEqual(nodes[7].rows, [['a', '第一']])
})

test('行内解析：粗体、斜体、删除线、行内代码、链接、图片', () => {
  const nodes = parseInline('前 **加粗** 与 *斜体* 还有 ~~删除~~ 以及 `code` 和 [链接](https://a.com) 与 ![图](./a.png)')
  const kinds = nodes.map((node) => node.type)
  assert.ok(kinds.includes('strong'))
  assert.ok(kinds.includes('italic'))
  assert.ok(kinds.includes('strike'))
  assert.ok(kinds.includes('code'))
  const link = nodes.find((node) => node.type === 'link')
  assert.equal(link.href, 'https://a.com')
  const image = nodes.find((node) => node.type === 'image')
  assert.equal(image.src, './a.png')
})

test('渲染成微信内联样式 HTML：没有 class/style 标签、图片可回填', () => {
  const nodes = parseMarkdown('# 标题\n\n正文 ![图](./a.png) 结束。')
  const { html, images } = renderHtml(nodes, { theme: 'default' })
  assert.match(html, /<section style="[^"]*font-family/)
  assert.match(html, /<h1 style="[^"]*font-size:22px/)
  assert.match(html, /<p style="[^"]*text-align:justify/)
  assert.ok(!html.includes('class='), '微信会剥 class，渲染结果不能依赖它')
  assert.ok(!html.includes('<style'), '不能有 style 标签')
  assert.deepEqual(images, ['./a.png'])

  const mapped = renderHtml(nodes, {
    theme: 'default',
    images: new Map([['./a.png', 'http://mmbiz.qpic.cn/x.png']]),
  })
  assert.match(mapped.html, /src="http:\/\/mmbiz\.qpic\.cn\/x\.png"/)
})

test('三种主题的强调色不同，未知主题回退 default', () => {
  assert.equal(themeByName('nope').accent, THEMES.default.accent)
  const dark = renderHtml(parseMarkdown('## 标题'), { theme: 'dark' })
  const def = renderHtml(parseMarkdown('## 标题'), { theme: 'default' })
  assert.notEqual(dark.html, def.html)
  assert.ok(Object.keys(THEMES).includes('magazine'))
})

test('摘要按 120 字截断并在句号处收尾', () => {
  const long = '第一句话。'.repeat(40)
  const nodes = parseMarkdown(long)
  const digest = makeDigest(nodes, 120)
  // 自动摘要绝不能自己超限（否则 article check 会直接判不合格）
  assert.ok(digest.length <= 120, `摘要长度 ${digest.length}`)
  assert.ok(digest.endsWith('。') || digest.endsWith('…'))

  // 短文本原样返回
  assert.equal(makeDigest(parseMarkdown('很短'), 120), '很短')
  // 没有句号时用省略号收尾，长度仍然卡在 limit
  const noStop = makeDigest(parseMarkdown('字'.repeat(300)), 120)
  assert.equal(noStop.length, 120)
  assert.ok(noStop.endsWith('…'))
})

test('大纲与统计', () => {
  const nodes = parseMarkdown('# A\n\n正文\n\n## B\n\n更多正文')
  const rows = outline(nodes)
  assert.deepEqual(rows, [
    { level: 1, text: 'A' },
    { level: 2, text: 'B' },
  ])
  const { html } = renderHtml(nodes)
  const info = stats(nodes, html)
  assert.equal(info.headings, 2)
  assert.ok(info.words > 0)
  assert.equal(info.images, 0)
  assert.equal(plainText(parseMarkdown('**a**b')), 'ab')
})

test('HTML 转义：正文里的尖括号不会注入标签', () => {
  const { html } = renderHtml(parseMarkdown('<script>alert(1)</script>'))
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;script&gt;/)
})

test('代码块内容原样保留缩进与换行', () => {
  const source = '```js\nif (a) {\n  b()\n}\n```'
  const nodes = parseMarkdown(source)
  const { html } = renderHtml(nodes)
  assert.match(html, /if \(a\) \{/)
  assert.match(html, /white-space:pre-wrap/)
})
