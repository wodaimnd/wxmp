# wxmp

**微信公众号文章制作与发布 CLI + DSH 插件。**

在本地写 Markdown → 转成微信能吃的内联样式 HTML → 生成封面 → 上传素材 → 进草稿箱 → 提交发布 → 轮询结果。
零依赖（不需要 npm install），Node.js ≥ 18。

与 [`winpilot`](../winpilot) 是姊妹项目：那个驱动**小程序**，这个管理**公众号文章**。两者共用同一套 CLI/插件约定（`--json` 输出、4000 字符截断、dry-run 默认安全、子进程走文件句柄）。

```
文章.md (Markdown + front matter)
   │  article check        校验微信硬限制
   │  article preview      本地手机框预览
   │  cover                900×383 封面（GDI+ 排中文）
   ▼
draft create ──► 上传封面(永久素材) + 正文图(uploadimg) ──► /cgi-bin/draft/add
   │                                                        （mediaId 回写 front matter）
   ▼
publish submit --yes ──► /cgi-bin/freepublish/submit ──► publish wait 轮询终态、拿永久链接
```

## 为什么是这套设计

| 真实约束 | 处理方式 |
|----------|----------|
| 微信正文**剥掉** `<script>`、`<style>`、`class` 和外部 CSS | 自己渲染：所有样式**内联**到 `style` 属性 |
| 正文图片**必须**来自 mmbiz，外链被过滤 | `draft create` 自动 `uploadimg` 并把 `src` 换成返回的 URL |
| 正文图 **<1 MB** 且只支持 jpg/png；封面走**永久素材**（≤10 MB） | 上传前检查大小，分两条上传路径 |
| `uploadimg` 与 `add_material` 是**不同接口**，配额也不同 | 分开实现，封面绝不走 uploadimg |
| 草稿 `<32` 字标题、`<120` 字摘要、`<2 万字符/1 MB` 正文 | `article check` 前置校验，不合规直接 exit 1 |
| token 只有 7200s，且微信用 HTTP 200 + `errcode` 报错 | 本地缓存 + 提前 5 分钟过期；`40001/40014/42001` 自动刷新重试 |
| 发布是**异步任务**，提交成功 ≠ 发布成功 | `publish wait` 轮询到 0/2/3/4 终态 |
| 误发不可撤回 | `publish submit` 不带 `--yes` 一律 dry-run |

## 安装与配置

```powershell
cd G:\AI PGRM\DSH\wxmp

node bin\wxmp.js doctor                       # 环境自检
node bin\wxmp.js config set --appid <AppID> --secret <AppSecret>
node bin\wxmp.js doctor                       # 再跑一次：连通 + 草稿接口
```

凭据优先级：环境变量 `WXMP_APPID` / `WXMP_SECRET` → `%LOCALAPPDATA%\wxmp\config.json`。
**所有输出里 secret 都打码**（`test***et`），不落日志、不进 `--json`。

想少打字，把这个目录加进 PATH，或用包装脚本：

```bat
@echo off
node "G:\AI PGRM\DSH\wxmp\bin\wxmp.js" %*
```

## 快速开始

```powershell
wxmp article new --title "用 DSH 自动化发公众号" --author "YG"
# 编辑 %LOCALAPPDATA%\wxmp\articles\用-DSH-自动化发公众号.md 的正文

wxmp article check   --file <md>            # 硬限制校验
wxmp article preview --file <md> --open     # 手机框预览
wxmp cover           --file <md> --badge WXMP
wxmp draft create    --file <md>            # 上传素材 + 建草稿
wxmp publish submit  --file <md> --yes      # 正式发布
wxmp publish wait    --publish-id <id>      # 轮询结果
```

## 命令参考

```text
config  set --appid <id> --secret <secret> | show | clear
doctor
article new --title "标题" [--author 作者] [--theme default|dark|magazine] [--force]
article list | show --file <md> | check --file <md> | preview --file <md> [--out ...] [--open]
article brief [主题] [--form X] [--words N] [--audience X] [--angle X] [--preset id] [--file md]
article preset list | show <id> | prompt [id] | use <id>
        export <id> [--out file] | import <file> [--force] | remove <id> | reset
cover   --file <md> [--theme ...] [--subtitle ...] [--badge ...] [--out cover.png]
draft   create --file <md> [--dry-run] | list [--offset 0] [--count 20] [--full]
        get --media-id <id> | update --file <md> [--media-id <id>] [--index 0]
        delete --media-id <id> | count
publish submit --file <md>|--media-id <id> [--yes]
        status --publish-id <id> | wait --publish-id <id> [--timeout 120000]
        list [--offset 0] [--count 20] | delete --article-id <id> [--yes]
```

全局：`--json`（机器可读）、`--verbose`、`--base-url`（指向自建网关）。
退出码：`0` 成功 / `1` 业务失败（校验不过、接口报错、发布失败或超时）/ `2` 用法错误。

## 文章格式

```markdown
---
title: 标题（必填，≤32 字）
author: 作者（≤16 字）
digest: 摘要（≤120 字，留空自动截取正文并保证不超限）
cover: ./cover.png          # 本地路径或 https URL
sourceUrl: https://...      # 「阅读原文」
theme: default              # default / dark / magazine
comments: false             # 是否开启评论
---

正文 Markdown：标题、列表、引用、表格、代码块、图片、粗斜体删除线、链接全部支持。
```

支持的 Markdown 全部映射到微信能渲染的标签：`h1-h6`、`p`、`ul/ol`、`blockquote`、`pre/code`、`table`、`img`、`strong/em/span`、`a`。

### 三种排版主题

| 主题 | 气质 | 强调色 |
|------|------|--------|
| `default` | 微信编辑器默认观感，15px/1.75 | `#07C160` |
| `dark` | 技术文，深色代码块 | `#3EA6FF` |
| `magazine` | 衬线、宽行距，适合长文 | `#C0392B` |

## 打分预设：先当写作提示词用

预设的第一身份是**写作提示词**，体检只是写完后的复核。每个预设两份东西：阈值权重（给 `review` 当尺子）和可选的 `style.md` 风格提示词（开头钩子、段落节奏、语气、结尾动作）。

| id | 适用 | 段落长/过长 | 小节 | 及格线 |
|----|------|------------|------|--------|
| `standard` | 通用长文（兜底） | 200 / 320 | 3~8 | 80 |
| `short-punch` | 通知、活动、单点方法论 | 120 / 200 | 2~5 | 80 |
| `deep-longform` | 复盘、方法论、长案例 | 300 / 450 | 4~10 | 75 |

```powershell
wxmp article preset use deep-longform   # 换尺子（长期生效）
wxmp article preset prompt              # 拿当前预设的完整写作提示词
wxmp article brief "选题"               # 任务书内嵌风格节，写前不用单独取
```

三个内置预设都自带风格文案。自定义风格往 `%LOCALAPPDATA%\wxmp\presets\<id>\style.md` 写纯文本即可；导出是 version 2 JSON（带 style 字段），v1 旧文件仍可导入。硬约束见 `dsh-plugin/skills/wxmp/references/review-and-presets.md`。

## 封面生成

900×383（微信 2.35:1 封面比例）。Windows 上走 **PowerShell + GDI+**：
渐变底、右上角光斑、中文标题自动换行、副标题、胶囊角标。

- 脚本必须写 **UTF-8 BOM**：PowerShell 5.1 默认按 ANSI 读 `.ps1`，无 BOM 时中文会把引号配对搞坏；
- GDI 不可用（非 Windows / 无图形栈）时回退到**纯 JS PNG 编码器**：同样的渐变 + 光斑，但没有文字。

实测效果（本机 GDI 路径）：`docs/cover-sample.png`

## 作为 DSH 插件使用

```powershell
dsh plugin --profile web add G:\AI PGRM\DSH\wxmp\dsh-plugin
```

插件把 CLI 注册成单个模型工具 `wxmp`（`operation` + `params`），并自带 `dsh-plugin/skills/wxmp/SKILL.md`。

操作名（下划线把子命令拼起来），共 42 个，完整清单见 `dsh-plugin/skills/wxmp/references/operations.md`。写作链路：`article_new` → `article_brief` → `article_review` → `cover` → `draft_create` → `publish_submit`；预设八个：`article_presets` / `article_preset_show` / `article_preset_prompt` / `article_preset_use` / `article_preset_export` / `article_preset_import` / `article_preset_remove` / `article_preset_reset`。

不 import 任何 `@deepseek-ai/*`，只用 `ctx.tools.register()` + 手写 JSON Schema，因此 profile 安装和 `plugins/` link 加载都能工作。

## 架构

```
bin/wxmp.js            参数解析 + 输出/退出码
src/markdown.js        Markdown → AST → 微信内联样式 HTML（含摘要/大纲/统计）
src/article.js         front matter 解析、文章定位、mediaId 回写
src/wechat.js          微信 API 客户端：stable_token 缓存、errcode 检查、token 刷新重试
src/multipart.js       multipart 编码器（中文文件名可控）
src/preview.js         本地手机框预览 HTML
src/commands.js        全部命令
src/state.js           配置/凭据/token 缓存（凭据打码，原子写）
tools/cover.js         封面：GDI+ 生成器 + 纯 JS PNG 回退
dsh-plugin/            DSH 插件（工具注册 + skill）
test/                  322 个用例：单元测试 + 假微信服务器端到端
```

## 测试

```powershell
cd G:\AI PGRM\DSH\wxmp
npm test
# 或
node --test --test-isolation=none test/markdown.test.js test/unit.test.js test/cli.test.js test/plugin.test.js
```

**322 个用例全绿**，其中 `test/support/fake-wechat.js` 是一个真正的假微信服务器：

- 完整实现 `stable_token` / `uploadimg` / `add_material` / `draft/*` / `freepublish/*`
- 刻意模拟真实坑：首次 token 立刻作废（逼客户端走 `40001` → force_refresh 重试）、缺封面报 `53503`、正文有外链图报 `45166`、发布 1.2 秒后才成功
- 因此「上传 → 建草稿 → 提交 → 轮询成功 → 草稿被移除」这条链路是被真实协议行为验证的，不是 mock 一个 return 值

## 已知限制

- **只管服务号/已认证订阅号**：发布能力（`freepublish`）对未认证账号不开放（`48001`）。
- **不生成正文插图**：图片由用户/Agent 提供；工具负责校验大小并上传。
- **不做定时群发**：只有 `freepublish`（发布到图文页），没有 `mass/sendall`（推送给粉丝，配额与权限不同）。
- **没有评论管理/数据统计**：v1 聚焦「写 → 发」闭环。
- 发布审核（原创校验、平台审核）的价格由微信决定，`publish_status` 里如实反映，工具不做重试绕过。

## 许可

MIT。接口形态依据微信官方文档实现（[新增草稿](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add)、[发布草稿](https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_submit)、[发布状态](https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_get)、[上传图文消息图片](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_uploadimage)、[上传永久素材](https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_addmaterial)、[稳定版 token](https://developers.weixin.qq.com/doc/subscription/api/base/api_getstableaccesstoken)）。
微信公众平台相关接口归腾讯所有，本项目只是本地调用方。
