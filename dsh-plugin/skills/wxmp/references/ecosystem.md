# 生态归类：这 7 个外部 skill 各自的下场

这张表回答一件事：**网上那些公众号 skill，哪些已经变成 wxmp 的一部分，哪些没有、为什么、要用时怎么办。**
看这张表就别再去翻那 7 个 skill 的目录了——该吸收的已经吸收，没吸收的有明确理由。

## 总表

| skill | 判定 | 说明 | 用的时候 |
|---|---|---|---|
| `wechat-article-extractor` | **已吸收（重写）** | `lib/absorbed/wechat-extractor.js`（435 行）。5 个 npm 依赖全换成 Node 内置：`request-promise`→`fetch`、`cheerio`→正则、`dayjs`→手写、`qs`→`URLSearchParams`、`lodash.unescape`→`decodeEntities`。保留错误码体系与 `var msg_link` 提取策略 | `article import`（CLI-only，见 `cli-only.md`） |
| `wechat-article-writer` | **已吸收（方法论）** | 四步流程→`writing-brief.js`；标题五特点→`title-lab.js` 五公式 + `review-content.js` 标题检查；故事化开头/段落 3~5 行/金句→`review-content.js` | `article brief` / `titles` + `article_review` |
| `md2wechat` | **已吸收（方法论）** | `references/writing/forms.md` 四种文体→`outline-lab.js`；`workflow.md`/`platforms.md` 的事实与依据、平台禁忌→`review-content.js`。**未吸收的判断层已补进本目录 `writing.md`** | `article outline` + `article_review` + `writing.md` |
| `gzh-download-knowledge` | **归类：外部依赖** | 靠 webclaw3 驱动已登录 Chrome 翻「发表记录」列表。wxmp 的 `article import` 只能给 URL，**不能按账号列历史**。本机 webclaw3 未装、中继 3459 端口不通 | 先装 webclaw3 并登录后台，再 `node skill.mjs` |
| `wechat-article-fetcher` | **归类：能力重复且更弱** | 用 Playwright 开无头浏览器抓单篇。wxmp 的 `article import` 用纯 HTTP 就够，不需要浏览器 | 不用它。用 `article import` |
| `md2wechat-skill` | **归类：不吸收（有错误）** | Python + wechatpy 方案。本机无 wechatpy。**且它的 `MAX_CONTENT_BYTES = 2000000` 与微信官方「小于 1M」矛盾**（详见下节） | 不用它。转换走 wxmp 的 `src/markdown.js` |
| `wechat-article-publisher` | **归类：第三方平台** | 走的不是微信官方接口，是 `wx.limyai.com` 中转站的开放 API（`X-API-Key`）。要注册该平台并授权公众号 | 只有确实用那个平台时才用 |

## 为什么 `wechat-article-fetcher` 不吸收

它和已吸收的 `wechat-article-extractor` 功能高度重叠，但实现更重：Playwright 起浏览器、
下载图片、存整页截图。wxmp 需要的是**把文章变成一篇可编辑的 .md**，`article import` 已经做到，
而且不需要浏览器、不需要装 chromium。

它唯一多出来的是**整页截图**。这属于「归档」需求，不是「写稿」需求，不该塞进发文工具里。

## 为什么 `md2wechat-skill` 不吸收，以及它的一处硬错误

实现路线是 Python + `wechatpy` + `markdown` + `bs4`，本机这些全都不可用（系统 python 是
WindowsApps 的假 python，连标准库都缺）。这不是主要原因——主因是**它的正文长度判断是错的**。

微信官方 [新增草稿文档](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add) 对 `content` 的原话：

> 图文消息的具体内容，支持HTML标签，必须少于2万字符，小于1M

而它的 `scripts/md_converter.py:21` 写的是 `MAX_CONTENT_BYTES = 2000000`（约 1.9 MB），
超出官方限值近一倍，并且会**静默截断**（`_truncate_content`：按 0.9 比例循环砍、找上一个闭合标签、末尾补提示）。
按它的判断「通过」的稿子，到微信接口那边会直接失败。

wxmp 的 `src/output.js:81-82` 是 `20000` 字符 + `1024*1024` 字节，与官方一致。
**所以这一项以 wxmp 为准，别采信 2MB 的说法。**

那它的转换引擎值不值得吸收？**不值得**。它的 markdown 扩展只有 `python-markdown` 的
`fenced_code` 一项，没有任何 wxmp 缺的语法（无任务列表、脚注、定义列表、callout）；
而 wxmp 的 `src/markdown.js` 原生支持 13 类节点（`heading`/`paragraph`/`list`/`table`/`code`/
`quote`/`image`/`link`/`strong`/`italic`/`strike`/`hr`/`text`）加三套主题。
**转换能力是 wxmp 更强，不是它。**

## 为什么 `wechat-article-publisher` 只是归类

它的 `SKILL.md` 写的是「微信官方接口、稳定」，但代码实际请求的是第三方中转站
（`POST https://wx.limyai.com/api/openapi/wechat-publish`，鉴权头 `X-API-Key`）。
这是**另一条通路**，不是 wxmp 的直接 API 路线：

- 它需要在该平台注册并授权公众号，凭据存在对方服务器；
- wxmp 的凭据只在自己机器的 `config.json` 里，直连 `api.weixin.qq.com`；
- 两者对「谁能撤销授权」「出错时谁的日志」完全不同。

它有一个 wxmp 确实没有的能力：**`article_type: newspic`（小绿书/图片消息）**——
正文纯文本、最多 20 张图、首图为封面。微信官方 `draft/add` 支持这个参数
（同一份文档的 `article_type` 字段：`news` 默认 / `newspic`）。
wxmp 的 `src/commands.js` 里 `buildDraftArticle()` 组装 payload 时把它**写死成 `article_type: 'news'`**，没有暴露成参数。
要发小绿书，现在有两条路：用这个 skill（需该平台账号），或者给 wxmp 补上 `articleType` 参数。

## 为什么 `gzh-download-knowledge` 只是归类

这是 7 个里**唯一一个方向相反**的能力：其余都是「往公众号发」，它是「从公众号往回捞」。

- 它翻的是后台「发表记录」（官方全量历史列表），需要**已登录后台的浏览器**；
- 它靠 webclaw3（浏览器扩展 + 本地中继 3459）驱动，本机未装；
- wxmp 的 `article import` 只能处理**你手上已有 URL** 的文章，给不了「我这个号历史上发过哪些」。

所以它不能替代 `article import`，`article import` 也不能替代它。两者是不同入口：
**有链接 → `article import`；只有号、要列全部 → 这条外部路线。**

顺带说明：它明确只做自己的号，不做抓别人的号（这条边界是对的，也别扩张）。

## 用哪条路线？一张判断图

```
你要做什么？
├─ 手上有文章链接，想变成可编辑的稿子
│    └─ article import <url>            ← 已内建（CLI-only）
├─ 只有自己的号，要列出历史全部文章
│    └─ gzh-download-knowledge（需 webclaw3）
├─ 写一篇新的公众号文章
│    └─ article brief → outline → 写 → article_review 循环
│       （方法论见 writing.md）
├─ 起标题 / 定大纲 / 规划配图
│    └─ article titles / outline / illustrate   ← 已内建（CLI-only）
├─ 排版成微信内联样式
│    └─ article preview / draft_create 自动转换  ← 已内建
├─ 发图文消息（news）
│    └─ cover → draft_create → publish_submit(yes)
└─ 发图片消息（newspic/小绿书，≤20 图）
     └─ wxmp 暂无此参数：用 wechat-article-publisher（第三方平台）或补 wxmp 的 articleType
```

## 如果你要给 wxmp 补能力

三个明确的缺口，按价值排序：

1. **`articleType: newspic`**——微信官方支持，wxmp 缺。改动点：`buildDraftArticle()` 组装 payload 时的
   `article_type` 从写死改成参数（`buildDraftArticle` 已支持 `options`），再给 `draft_create` 加
   `articleType`，封面改用 `image_info.image_list`（≤20 张、首图为封面）。
2. **按号列历史文章**——需要浏览器或后台 cookie，最重，收益只在归档场景。
3. **整页截图归档**——只在需要「留证据」时有用，和发文工具职责不同，不建议塞进来。

前两个都要动 `src/` 下的真实代码，本 skill 目录不负责；这一页只做登记，避免下次又从头调研一遍。
