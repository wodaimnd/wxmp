---
name: wxmp
description: >-
  在本地制作并发布微信公众号文章：Markdown 写稿 → 体检打分 → 生成封面 → 草稿箱 → 发布/查状态。
  模型侧用 `wxmp` 工具以 {operation, params} 调用，文章是一个本地 .md 文件（front matter + 正文）。
  article_review 返回 0~100 分，每条问题带**原文行号**和改法；写完必须先体检、按 line 改到 pass=true 再发布。
  也能导入在线文章、出选题简报/大纲/标题。用户说「写篇公众号文章」「发到公众号」「公众号排版」
  「生成/换个封面」「查草稿箱」「文章打个分/体检」「导入这篇公众号文章」时使用。
---

# wxmp — 微信公众号文章（写稿 → 体检 → 封面 → 草稿箱 → 发布）

## 先记住三件事

1. **调用形态是工具，不是 shell。**
   `wxmp({ operation: "article_review", params: { file: "<文章.md>" } })`
   返回 `{ok, exitCode, data, text}`：`text` 紧凑可读（截断 4000），`data` 结构化。别用 shell 敲 `wxmp …`。
2. **文章 = 一个本地 Markdown 文件（front matter + 正文），它是唯一真相。**
   每个操作都传这个路径；结果会**回写进 front matter**（`cover:`、`mediaId:`、`thumbMediaId:`），
   重读文件就是最新状态。
3. **顺序不许跳**：`article_new` → 写正文 → `article_review`（改到 `pass: true`）→ `article_check`
   → `cover` → `draft_create` → `publish_submit(yes: true)` → `publish_wait`。

细节在同级 `references/`，用到哪篇读哪篇：`operations.md`（41 项 params/`data`）·
`review-and-presets.md`（打分与检查码）· `troubleshooting.md`（报错全表）·
`writing.md`（依据、骨架、红线）· `ecosystem.md`（7 个外部 skill 的吸收判定）·
`cli-only.md`（仅 CLI 的残留）· `recipes.md`（配方）。

## 从零发一篇（照抄即可）

```jsonc
{"operation":"article_new","params":{"title":"标题","author":"作者","theme":"default"}}
```
→ `data.path` 是新建的 .md。**用编辑器/工具把正文写进这个文件**（Markdown），再往下走：

```jsonc
{"operation":"article_review","params":{"file":"<data.path>"}}
```
→ 拿到 `data.review.score` 与 `data.review.findings`。**逐条按 `findings[].line` 跳过去改**，再 review，
直到 `data.review.pass == true`。要硬门槛就传 `minScore`（不达标时工具返回 `ok:false`）。

```jsonc
{"operation":"article_check","params":{"file":"<文章.md>"}}
{"operation":"cover","params":{"file":"<文章.md>"}}
{"operation":"draft_create","params":{"file":"<文章.md>"}}
{"operation":"publish_submit","params":{"file":"<文章.md>","yes":true}}
{"operation":"publish_wait","params":{"publishId":"<上一步的 data.publishId>"}}
```

**四个必须知道的行为**：
- `article_review` 未达标时返回 **`ok:false` + `exitCode:1`** —— 这是**设计出来的正反馈，不是报错**。
  读 `data.review.findings` 继续改，别把它当失败重试。
- `draft_create` 会把 `mediaId`、`thumbMediaId` 写回 front matter；改稿后想更新草稿用 `draft_update`
  （复用 `mediaId`），**不要重复 `draft_create`**，否则草稿箱里会堆重复草稿。
- `publish_submit` 不带 `yes: true` 只做 dry-run（`data.dryRun === true`）。
  **提交成功 ≠ 发布成功**，平台还要审核/原创校验，必须 `publish_wait` 拿终态。
- `publish_wait` 的 CLI 默认等待 120000ms，插件的默认调用超时也是 120000ms——**两者同时到点**。
  要等超过一分钟，显式传小一点的 `timeoutMs`（如 `60000`），再用 `publish_status` 接着轮询。

## operation 速查（41 个）

每个 operation 的完整 params、别名与 `data` 字段见 `references/operations.md`。

- **配置**：`config_show` · `config_set` · `config_clear` · `config_set_image_key` ·
  `config_set_image_provider` · `image_providers` · `doctor`
- **写稿与清理**：`article_new` · `article_import` · `article_brief` · `article_outline` ·
  `article_titles` · `article_list` · `article_show` · `article_delete`
- **体检与改稿**：`article_check` · `article_review` · `article_set_title` · `article_set_author` ·
  `article_library` · `article_illustrate` · `article_preview`
- **预设**：`article_presets` · `article_preset_show` · `article_preset_use` · `article_preset_export` ·
  `article_preset_import` · `article_preset_remove` · `article_preset_reset`
- **封面**：`cover`
- **草稿**：`draft_create` · `draft_list` · `draft_get` · `draft_update` · `draft_delete` · `draft_count`
- **发布**：`publish_submit` · `publish_status` · `publish_wait` · `publish_list` · `publish_delete`

两条**别手搓**的路：
- 稿子**已经在线**（要改写/归档别人的或自己的旧文）→ `article_import`（`url`，或 `list` 指一个
  一行一个链接的文件）。同名不覆盖，自动 `-2`/`-3`。别一次性粘正文。
- 卡在选题 / 结构 / 标题 → `article_brief`（该搜什么、按什么骨架写）→ `article_outline`（块级骨架）
  → `article_titles`（机械候选 + 起标题任务书）。这三个**不替你写**，是把方法论变成作业单。

**删除只动本地文件**：`article_delete(file)` 删文章目录里的那篇 `.md`；微信草稿与已发文章不受影响（删草稿用 `draft_delete`）。

`file` 强烈建议**每次都显式给**（写命令不会默认改「最近那篇」）。别名：`mediaId`=`media_id`、
`publishId`=`publish_id`、`articleId`=`article_id`、`minScore`=`min_score`、`imageGen`=`image_gen`；
布尔位只认真值 `true`。除 `config_set_image_provider` 外所有 operation 都额外接受 `baseUrl`
（那一个的 `baseUrl` 是**供应商接入地址**，不是网关）。
工具层自己会报 `invalid_params`（必填项缺失/空串）与 `unknown_operation`。

## 文章文件格式

```markdown
---
title: 标题             # 必填 ≤32 字；author ≤16；digest ≤120 不填自动截取
cover: ./标题-cover.png  # cover 自动写回；sourceUrl=阅读原文；theme: default|dark|magazine
comments: false          # 没评论权限时必须 false；mediaId/thumbMediaId 由 draft_create 写回，别手改
---

正文用 Markdown：标题、列表、引用、表格、代码块、图片都能转成微信内联样式。
```

- 正文**第一个小标题必须是 `##`**（H1 属于 title），之后每次最多 +1 级。
- 正文图片必须是**本地文件**（`draft_create` 自动走 `uploadimg` 换 mmbiz URL；微信过滤外链图）。
- 正文里的原生 HTML 标签会被**转义成纯文本**（安全考虑），别指望手写 `<div>`。

## 硬限制（超了发不出去，先跑 `article_check`）

| 字段 | 上限 | 备注 |
|---|---|---|
| `title` | **32 字** | 超了直接拒（`title_too_long`） |
| `author` | **16 字** | 微信不认更长的作者名 |
| `digest` | **120 字** | 不填自动截取 |
| 正文 HTML | **19999 字符**（上限 20000） | 纯文本转 HTML 会膨胀，别按字数估 |
| 正文 HTML | **1 MB**（字节） | 图片多/内联多时先看这条 |
| 正文图片单张 | **< 1 MB** | 超了报 `content_image_too_large`；**本地只校验体积，不校验格式** |

## 体检怎么读（本插件的核心价值）

`article_review` 回答「**写得好不好**」，`article_check` 只回答「**能不能发**」。两个都要跑。

- `findings[]` 每条：`level` = `error`（发不出去，必须改）/ `warn`（该改）/ `info`（可选）；
  `line` 是**原文绝对行号**（`null` = 整体性问题）；`suggest` 直接照做，别自己发明改法。
- `pass` = `score >= passScore` **且一条 `error` 都没有**。
- `grade`：`A` ≥90、`B` ≥ `passScore`、`C` ≥70、`D` 其余。
- `breakdown` 是**扣分制**：每类从权重分起扣（各规则扣分不同，见 references）；
  `limits` 类只要有一条 `error` 就**直接清零**——发不出去谈别的没意义。
- **循环姿势**：`article_review` → 按 `line` 改 → 再 review → …… 直到 `pass: true`。
  文章文件是唯一状态，不用记上一轮报告。

## 打分标准 = 预设

同一套规则引擎，只换**阈值与权重**。

| id | 名字 | 适用 | 段落长/过长 | 小节 | 及格线 |
|---|---|---|---|---|---|
| `standard` | 标准公众号 | 通用长文（兜底） | 200 / 320 | 3~8 | 80 |
| `short-punch` | 短平快三点式 | 通知、活动、单点方法论 | 120 / 200 | 2~5 | 80 |
| `deep-longform` | 深度长文 | 复盘、方法论、长案例 | 300 / 450 | 4~10 | 75 |

- `article_review` 传 `preset` **只对这一篇生效**；`article_preset_use` 把选择存进 config 长期生效。
- **换预设会改变分数，这是设计意图**，报告里 `preset.id` 会自报用的哪把尺子。
- 拿不准就用 `standard`。自定义/导入导出的硬约束见 `references/review-and-presets.md`。

## 封面

- 默认输出 `<文章目录>/<文章名>-cover.png`（**每篇独立**），并**自动把 `cover:` 写回 front matter**
  （`data.frontMatter.written` 是写回结果）。背景三档：`bg`（自己的底图）→ `imageGen`（AI 生成，
  失败**自动回落渐变**并写明原因）→ 内置渐变。尺寸默认 **900×383**，`width`/`height` 可改。
- **缺封面时微信报 `40007 invalid media_id`**（缺参数也一并报这条）——别去查素材库，先跑 `cover`。
  front matter 没写 `cover:` 时 `draft_create` 会认领同目录的 `<文章名>-cover.png`，没有则本地拦下。

## 报错 → 处置

判断依据是 `data.error.code`（`message` 里通常还带一句人话修复提示）。全表见 `references/troubleshooting.md`。

| code | 原因 | 处置 |
|---|---|---|
| `credentials_missing` | 没配 AppID/AppSecret | `config_set` |
| `wechat_40164` | 调用 IP 不在白名单 | 公众平台 → 开发 → 基本配置 → IP 白名单 |
| `wechat_48001` | 账号没有 `freepublish` 权限 | **草稿已在草稿箱**，去 mp.weixin.qq.com 手动群发 |
| `wechat_40007` | 封面素材无效，**或压根没传封面** | 先 `cover` 重建，再 `draft_create` |
| `article_invalid` | 硬限制没过 | 看 `data.issues[]` 逐条改 |
| `cover_required` / `content_image_too_large` | 封面缺失 / 正文图 > 1 MB | 先 `cover`；图片压缩后再传 |

## 已知偏差（声明的参数 ≠ 实际生效）

- 布尔参数按「真值才转发」：`yes`/`force`/`imageGen`/`dryRun`/`apply`/`usable`/`audit`/`brief`/
  `allowBuiltin`/`custom` 传 `false` 或字符串 `"true"` 都等于**不传**，想开启必须布尔 `true`。
- CLI 的 `help` 文案里还写着旧权重「限制 30 / 结构 25 / 可读 25 / 素材 20」，
  实际 `standard` 是 5 类 `25/20/20/15/20`。**以 `article_preset_show` 的返回为准**。
- `image_providers` 没配 key 时 `cover(imageGen)` **不报错**，而是回落渐变并把原因写进
  `data.background.note`。

## 退出码与副作用边界

- 退出码：`0` 成功 · `1` 业务失败（校验不过、接口报错、发布失败/超时、**review 未达标**、`doctor` 关键项不过）
  · `2` 用法错误 · `3` 仅一处（`article_illustrate` 带 `apply` 时写盘未生效，文件不动）· `124` 插件层调用 CLI 超时。
  `ok` 就是 `exitCode === 0`。
- `publish_submit` / `publish_delete` **必须显式 `yes: true`**，默认 dry-run。
- 数据落点：文章与 `config.json` 在 `%LOCALAPPDATA%\wxmp\`（可用 `WXMP_HOME` 改），
  插件日志与 `mount-state.json` 在 `<stateDir>/logs\`。凭据只落本地、输出里打码。

## 前置条件（缺一不可）

1. 公众号是**服务号或已认证订阅号**——`freepublish` 只对它们开放（未认证跑发布会得 `48001`）。
   未认证也能用：写稿、体检、封面、**建草稿**，然后去官网手动群发。
2. 公众平台「基本配置」拿 AppID / AppSecret，并把本机出口 IP 加进 **IP 白名单**（否则 `40164`）。
   一次性配置：`config_set`（`appid` + `secret`），然后 `doctor` 自检一遍。
