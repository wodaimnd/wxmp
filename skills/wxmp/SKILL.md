---
name: wxmp
description: >-
  在本地制作并发布微信公众号（服务号/订阅号）文章：Markdown 写稿 → 校验微信硬限制 → 生成封面
  → 建草稿箱 → 提交发布 → 轮询结果。用户说「写篇公众号文章发出去」「把这份文档发到公众号」
  「做个封面」「查一下草稿箱」「这篇文章发出去了吗」时使用。不用于小程序（用 winpilot）、
  不用于自动撰写无授权内容。
---

# wxmp（微信公众号文章制作与发布）

## 何时用

- 用户要把内容发到**微信公众号**：写稿、排版、配封面、进草稿箱、正式发布。
- 用户要查草稿箱/已发布列表、查发布状态。
- 用户要一篇「能直接在微信里看」的排版（内联样式、图片必须走 mmbiz）。

不要用：小程序（用 winpilot）、朋友圈/视频号、第三方平台代运营账号（那要走 authorizer_access_token）。

## 前置条件（缺一不可）

1. 公众号是**服务号**，或**已认证**的订阅号——发布能力（`freepublish`）只对这些账号开放。
2. 公众平台「设置与开发 → 基本配置」拿到 AppID / AppSecret。
3. **IP 白名单**里加上本机出口 IP，否则 token 接口直接 40164。
4. 一次配置：`wxmp config set --appid <AppID> --secret <AppSecret>`。

## 标准流程

```bash
wxmp doctor                                  # 凭据 + 连通 + 草稿接口 + 封面渲染自检
wxmp article new --title "文章标题" --author "作者"
#   → 编辑 <文章目录>/文章标题.md 的正文（Markdown）
wxmp article check --file <文章.md>           # 硬限制校验：标题 32 字、摘要 120 字、正文 2 万字/1MB
wxmp article preview --file <文章.md> --open   # 本地手机框预览，看排版
wxmp cover --file <文章.md>                   # 生成 900×383 封面（含中文标题）
wxmp draft create --file <文章.md>            # 上传封面(永久素材)+正文图(uploadimg) → 建草稿 → 回写 mediaId
wxmp publish submit --file <文章.md> --yes     # 提交发布任务
wxmp publish wait --publish-id <id>           # 轮询到终态，拿到文章链接
```

## 命令速查

| 意图 | 命令 |
|------|------|
| 配置凭据 | `config set --appid <id> --secret <secret>` |
| 查看/清除 | `config show` / `config clear` |
| 环境自检 | `doctor` |
| 新建文章 | `article new --title "标题" [--author 作者] [--theme default\|dark\|magazine]` |
| 列表/详情 | `article list` / `article show --file <md>` |
| 校验 | `article check --file <md>`（不通过 exit 1） |
| 本地预览 | `article preview --file <md> [--open]` |
| 封面 | `cover --file <md> [--theme ...] [--subtitle ...] [--badge ...]` |
| 建草稿 | `draft create --file <md> [--dry-run]` |
| 草稿箱 | `draft list` / `draft get --media-id <id>` / `draft count` |
| 改草稿 | `draft update --file <md> [--media-id <id>] [--index 0]` |
| 删草稿 | `draft delete --media-id <id>` |
| 发布 | `publish submit --media-id <id> --yes` |
| 查状态 | `publish status --publish-id <id>` / `publish wait --publish-id <id>` |
| 已发布 | `publish list` / `publish delete --article-id <id> --yes` |

全局：`--json`、`--verbose`。

## 文章文件格式

```markdown
---
title: 标题（必填，≤32 字）
author: 作者（≤16 字）
digest: 摘要（≤120 字，不填自动截取正文）
cover: ./cover.png        封面：本地路径或 https URL
sourceUrl: https://...    「阅读原文」
theme: default
comments: false
---

正文 Markdown：标题、列表、引用、表格、代码块、图片都支持。
```

## Agent 决策要点

1. **先 `article check`**，别把超限草稿推上去再吃 `53503`。
2. **正文图片必须走工具**：`draft create` 会自动 `uploadimg` 并把 src 换成 mmbiz URL。
   正文图片硬限制 **<1 MB、jpg/png**；超了先压缩。
3. **封面走永久素材**（`thumb_media_id`），所以 `cover` 生成图后别忘了 front matter 写 `cover:`。
4. **发布要显式确认**：`publish submit` 不带 `yes` 只 dry-run。用户没明确说「发」就先 dry-run。
5. **发布是异步的**：`submit` 成功只代表任务提交；必须 `publish wait` 或 `publish status` 才能知道结果。
6. **改写要更新草稿**：`draft update` 复用同一个 mediaId，别重复 `draft create` 堆垃圾。
7. `state` 文件：`%LOCALAPPDATA%\wxmp\`（文章在 `articles/`，预览在 `previews/`）。

## 退出码

- `0` 成功；`1` 业务失败（校验不过、接口报错、发布失败/超时）；`2` 用法错误。

## 排错表

| 现象 | 处理 |
|------|------|
| `credentials_missing` | `wxmp config set --appid ... --secret ...` 或设 `WXMP_APPID`/`WXMP_SECRET` |
| `wechat_40125` | AppSecret 错（检查空格/大小写） |
| `wechat_40164` | 出口 IP 不在白名单，去公众平台加 |
| `wechat_48001` | 接口未授权：账号不是服务号/未认证，发布能力没有 |
| `wechat_53503` | 草稿没过发布检查：标题/正文超长、缺封面、正文图非 mmbiz |
| `wechat_45166` | 正文里有外链图片，用 `draft create` 让它自动上传 |
| `content_image_too_large` | 正文图 >1 MB，压缩后再传 |
| `publish_id_required` | 先 `publish submit` 拿 publish_id |
| 发布状态 2/3/4 | 原创失败/常规失败/审核不通过，看 `fail_idx`，改写后重新提交 |
| 预览里图片不显示 | 本地图片用 file:// 替换了；确认 front matter 的 `cover` 路径对 |

## 安全边界

- 凭据只落本地 `config.json`，输出里一律打码。
- `publish submit` / `publish delete` 必须显式 `--yes`，默认 dry-run。
- 不自动抓取外部内容发布；正文与封面由用户/Agent 提供。
