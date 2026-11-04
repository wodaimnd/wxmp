# @local/wxmp — DSH 插件

把 [wxmp](../README.md) CLI 注册成一个模型工具 `wxmp`，用于制作与发布微信公众号文章。

## 安装

```powershell
dsh plugin --profile web add G:\AI PGRM\DSH\wxmp\dsh-plugin
```

或把本目录链接到 DSH 的本地插件目录（本工作区是 `G:\AI PGRM\DSH\plugins\`）。

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

| operation | params |
|-----------|--------|
| `config_show` | — |
| `config_set` | `appid`, `secret` |
| `doctor` | — |
| `article_new` | `title`（必填）, `author?`, `theme?`, `cover?`, `force?` |
| `article_list` | — |
| `article_show` / `article_check` | `file?`（缺省取最新一篇） |
| `article_preview` | `file?`, `out?`, `open?` |
| `cover` | `file?`, `subtitle?`, `badge?`, `theme?`, `out?` |
| `draft_create` | `file?`, `dryRun?`, `thumbMediaId?` |
| `draft_list` | `offset?`, `count?`, `full?` |
| `draft_get` / `draft_delete` | `mediaId` |
| `draft_update` | `file?`, `mediaId?`, `index?`, `dryRun?` |
| `draft_count` | — |
| `publish_submit` | `file?` 或 `mediaId`, `yes?` |
| `publish_status` / `publish_wait` | `publishId`, `timeoutMs?`, `intervalMs?` |
| `publish_list` | `offset?`, `count?` |
| `publish_delete` | `articleId`, `yes?`, `index?` |

所有操作都接受 `baseUrl`（指向自建/内网网关，默认 `api.weixin.qq.com`）。
`mediaId` 也接受 `media_id`、`publishId` 也接受 `publish_id` 等下划线写法。

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
#    %USERPROFILE%\.dsh\profiles\desktop\package.json
# 2. 删链接
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\wxmp" -Force
# 3. 重启 DSH
```

插件只是把 CLI 注册成工具；卸载不会删除 `G:\AI PGRM\DSH\wxmp` 本身，也不影响已发布的文章。
