# @local/wxmp — DSH 插件

把 [wxmp](../README.md) CLI 注册成一个模型工具 `wxmp`，用于制作与发布微信公众号文章。

## 安装

```powershell
dsh plugin --profile web add G:\AI PGRM\DSH\wxmp\dsh-plugin
```

或把本目录链接到 DSH 的本地插件目录（本工作区是 `G:\AI PGRM\DSH\plugins\`）。

## 自带 Skill（随包使用手册）

`skills/wxmp/SKILL.md` 是**给模型看的**使用手册，随包发布，装到哪带到哪：

- `SKILL.md` —— 触发条件 + 调用形态 + 发布链路骨架 + 硬限制 + 已知偏差（体积受 8192 字符预算约束，
  超了会被标准 preset 的修剪器裁掉后半段，所以细节都在子文件里）。
- `skills/wxmp/references/` —— `operations.md`（40 个 operation 的完整 params 与 `data` 字段）、
  `review-and-presets.md`（打分公式、扣分表、39 个检查码、预设机制）、`troubleshooting.md`（报错全表）、
  `writing.md`（写稿方法论：事实依据、体裁骨架、平台红线、目标搜索）、
  `ecosystem.md`（外部 skill 的**吸收登记表**：哪些已练进代码、哪些没有、为什么）、
  `cli-only.md`（还剩什么只能走 CLI + CLI 参数坑）、`recipes.md`（常见配方与封面细节）。

## 外部 Skill 的吸收边界

网上那些公众号 skill 不是照搬进来，而是**能承接的练进代码、不能承接的登记清楚**。
`lib/absorbed/` 就是这个做法的产物——吸收来的模块都放这里，注释里写清来源与改动幅度。

| 外部 skill | 判定 | 落在哪 |
|---|---|---|
| `wechat-article-extractor` | 已吸收（**重写**） | `lib/absorbed/wechat-extractor.js`：5 个 npm 依赖全换 Node 内置（`fetch` / 正则 / `URLSearchParams`），保留错误码体系 |
| `wechat-article-writer` | 已吸收（方法论） | `src/writing-brief.js`（四步流程）、`src/title-lab.js`（标题五特点）、`src/review-content.js`（开头钩子/段落/金句） |
| `md2wechat` | 已吸收（方法论） | `src/outline-lab.js`（`forms.md` 四种文体）、`src/review-content.js`（事实依据、平台禁忌）；判断层未落地部分见 `skills/wxmp/references/writing.md` |
| `gzh-download-knowledge` | 归类：外部依赖 | 按号列历史文章需 webclaw3 + 已登录浏览器；`article import` 只吃已有 URL，替代不了 |
| `wechat-article-fetcher` | 归类：能力重复且更弱 | Playwright 起浏览器抓单篇；`article import` 纯 HTTP 就够 |
| `md2wechat-skill` | 归类：不吸收 | Python + wechatpy；**且 `MAX_CONTENT_BYTES=2000000` 与微信官方「小于 1M」矛盾** |
| `wechat-article-publisher` | 归类：第三方平台 | 走 `wx.limyai.com` 中转 API，非微信官方直连 |

完整判定、证据与「用哪条路线」判断图见 `skills/wxmp/references/ecosystem.md`。

**一条对得上的硬事实**：微信 [`draft/add`](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add)
官方原文是 `content`「必须少于 2 万字符，小于 1M」。wxmp 的 `src/output.js:81-82`
（`20000` 字符 + `1024*1024` 字节）与官方一致，**别采信 2MB 的说法**。

**光把 `skills/` 放进包里没有用**：目录只是死文件，不进会话技能目录，模型永远看不到，而且不报任何错。
必须由 `cordis.patch.yml` 的第二行装载 `@deepseek-ai/dsh-skill-filesystem` 并指向本包 `skills/`：

```yaml
    - id: wxmp-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: wxmp-plugin
        includeDefaultRoots: false
        watch: false
        bundledSkillDir: !!js (()=>{ … 从 baseUrl 解析 @local/wxmp 再取 dirname+/skills … })()
```

`bundledSkillDir` 必须从**安装位置**推导（npm 装 / GitHub 装 / 本地 link 三种形态包根不同，写死只在作者机器上对），
且表达式要写成**单行 plain scalar**（YAML 会把多行折成一行，行内 `//` 注释会吞掉后半段）。
`dsh.client` 只负责面板，不负责技能发现。新增这一行后需**重启 DSH** 才会进技能目录。

## 工具形态

```jsonc
{
  "operation": "draft_create",
  "params": { "file": "文章.md" }
}
```

返回固定形状（DSH 会按 `output.schema` 校验）：

```jsonc
{ "ok": true, "exitCode": 0, "data": { "mediaId": "draft_7", ... }, "text": "草稿已创建: draft_7 ..." }
```

`render()` 只把 `text` 交给模型，`data` 留给程序消费。

## 操作与参数

`*` 必填。写命令（`article_set_author` 等）**不会默认改「最近那篇」**，`file` 请显式给。
共 **40 个 operation**，完整 params / 别名 / `data` 字段见 `skills/wxmp/references/operations.md`。

| operation | params |
|-----------|--------|
| `config_show` | — |
| `config_set` | `appid*`, `secret*` |
| `config_clear` | — |
| `config_set_image_key` | `provider*`, `value*`（`'-'` = 删除该家 key）, `custom?` |
| `config_set_image_provider` | `provider*`, `baseUrl*`, `model?` |
| `image_providers` | — |
| `doctor` | — |
| `article_new` | `title*`, `author?`, `theme?`, `cover?`, `force?` |
| `article_import` | `url?`, `list?`（二选一） |
| `article_brief` | `topic?`, `file?`, `form?`, `words?`, `audience?`, `angle?`, `preset?` |
| `article_outline` | `file?`, `form?` |
| `article_titles` | `file?`, `titles?`, `brief?` |
| `article_list` | — |
| `article_show` / `article_check` | `file?` |
| `article_review` | `file?`, `minScore?`(`min_score`), `preset?` |
| `article_set_title` | `file*`, `title*` |
| `article_set_author` | `file*`, `author?`（空串 = 清空作者名） |
| `article_library` | `check?`, `guide?`, `audit?`, `usable?` |
| `article_illustrate` | `file?`, `max?`, `apply?` |
| `article_preview` | `file?`, `out?`, `open?` |
| `article_presets` | — |
| `article_preset_show` / `use` / `export` | `id*`（`export` 另有 `out?`） |
| `article_preset_import` | `file*`, `as?`, `force?` |
| `article_preset_remove` | `id*`, `allowBuiltin?` |
| `article_preset_reset` | — |
| `cover` | `file?`, `subtitle?`, `badge?`, `theme?`, `out?`, `bg?`, `imageGen?`(`image_gen`), `prompt?`, `width?`, `height?` |
| `draft_create` | `file?`, `dryRun?`, `thumbMediaId?` |
| `draft_list` | `offset?`, `count?`, `full?` |
| `draft_get` / `draft_delete` | `mediaId*`(`media_id`) |
| `draft_update` | `file?`, `mediaId?`(`media_id`), `index?`, `dryRun?` |
| `draft_count` | — |
| `publish_submit` | `file?`, `mediaId?`(`media_id`), `yes?` |
| `publish_status` | `publishId*`(`publish_id`) |
| `publish_wait` | `publishId*`, `timeoutMs?`, `intervalMs?` |
| `publish_list` | `offset?`, `count?`（`--full` 只有 CLI 有） |
| `publish_delete` | `articleId*`(`article_id`), `yes?`, `index?` |

所有操作都接受 `baseUrl`（指向自建/内网网关，默认 `api.weixin.qq.com`）——
**例外**是 `config_set_image_provider`，它的 `baseUrl` 是供应商接入地址。
`mediaId` 也接受 `media_id`、`publishId` 也接受 `publish_id` 等下划线写法。
布尔位（`yes`/`force`/`dryRun`/`imageGen`/`apply`/`usable`/`audit`/`brief`/`allowBuiltin`/`custom`）
**只认真值 `true`**——传 `false` 或字符串 `"true"` 都等于没传。

CLI 里只剩 5 件小事没有对应 operation（`article review --no-next`、`draft create|update --comments`、
`draft get --raw`、`publish list --full`、`--version`/`help`），见 `skills/wxmp/references/cli-only.md`。

## 配置

```yaml
- insert:
    - id: wxmp
      name: '@local/wxmp'
      config:
        cliPath: ''        # 默认自动定位 ../bin/wxmp.js
        stateDir: ''       # 空 = 用 CLI 自己的目录（%LOCALAPPDATA%\wxmp）
        timeoutMs: 120000
```

## 安全默认（有意为之）

- `publish_submit` 不带 `yes: true` **只 dry-run**，不会真的发出去；
- `publish_delete` 同理；
- 凭据在输出里始终打码；
- 发布是异步任务：工具会提示用 `publish_wait` 轮询，而不是假装 submit 成功就完事。

## 设计要点

- **只注入 `tools`**：`systemPrompt` 是可选增强。
- **不 import `@deepseek-ai/*`**：手写 raw JSON Schema，`link:` 加载也不会解析失败。
- **子进程 stdio 指向文件**：受限沙箱里管道会 EPERM。
- **所有操作串行**：`draft_create` 会把 `media_id` 写回文章 front matter，
  `publish_submit` 依赖它，并发会互相踩踏。
- **重新 apply 先释放旧注册**：配置变更会重新调用 `apply`。

## 卸载

```powershell
# 1. 从 profile 清单里去掉依赖与 bundles 条目
#    %USERPROFILE%\.dsh\profiles\<profile>\package.json
# 2. 删链接
Remove-Item "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@local\wxmp" -Force
# 3. 重启 DSH
```

插件只是把 CLI 注册成工具；卸载不会删除 `G:\AI PGRM\DSH\wxmp` 本身，也不影响已发布的文章。
