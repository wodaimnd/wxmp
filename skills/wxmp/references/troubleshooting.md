# 报错全表 → 处置

判断依据是 `data.error.code`（`message` 里通常还带一句人话修复提示）。以本地 `config.json` 与 `doctor` 的结论排版。

## 凭据 / 账号

| code | 原因 | 处置 |
|---|---|---|
| `credentials_missing` | 没配 AppID/AppSecret | `config_set`，或设环境变量 `WXMP_APPID` / `WXMP_SECRET`（不落盘） |
| `appid_invalid` | AppID 格式不对（应为 `wx` 开头 18 位） | 跟公众号后台「基本配置」核对 |
| `wechat_40001` / `wechat_40125` | AppSecret 不对 / 已被刷新 | 重新 `config_set`；检查空格与大小写 |
| `wechat_40013` | AppID 无效 | 核对是否与后台一致 |
| `wechat_40164` | 调用 IP 不在白名单 | 公众平台 → 开发 → 基本配置 → IP 白名单，把本机出口 IP 加进去 |
| `wechat_48001` | 接口未授权：账号不是认证服务号，没有 `freepublish` 权限 | **草稿已经进草稿箱了**，去 mp.weixin.qq.com「草稿箱」手动群发。这不是工具坏了 |

## 内容 / 素材

| code | 原因 | 处置 |
|---|---|---|
| `wechat_40007` | 封面 `thumb_media_id` 无效/过期，**或压根没传封面** | 先 `cover` 重建（自动写回 front matter），再 `draft_create` |
| `wechat_45166` | 正文里有外链图片（微信过滤非 mmbiz 域名） | 把图片换成本地文件让 `draft_create` 自动 `uploadimg`。此码**没有内置修复提示**，`message` 偏通用 |
| `wechat_53503` | 草稿没过发布检查：标题/正文超长、图片非 mmbiz 域名、缺封面 | 对着这四项查 |
| `wechat_53504` / `wechat_53505` | 需要在官网手动使用 / 先手动保存一次该草稿 | 去 mp.weixin.qq.com 操作一次 |
| `wechat_53404` | 账号被限制带货能力 | 删掉商品卡片重试 |
| `wechat_88000` | 没有评论权限 | front matter 设 `comments: false` |
| `cover_required` | 文章没封面，本地就拦下了 | 先 `cover`；同目录有 `<文章名>-cover.png` 会自动认领 |
| `content_image_too_large` | 正文图 > 1 MB | 压缩后再传 |
| `article_invalid` | 硬限制没过 | 看 `data.issues[]` 逐条改（与 `article_check` 同源） |

## 频率 / 配额

| code | 原因 | 处置 |
|---|---|---|
| `wechat_45009` | 当天接口调用额度用尽 | 明天再试 |
| `wechat_45011` | 调用太频繁 | 等一分钟 |

## 用法 / 本地

| code | 原因 | 处置 |
|---|---|---|
| `article_exists` | 同名文章已存在 | 换标题，或 `force: true` 覆盖 |
| `title_too_long` / `author_too_long` | 超 32 / 16 字 | 改短；这两条在建文章时就拦，比等微信报错早 |
| `theme_unknown` | 主题名不对 | 只能是 `default` / `dark` / `magazine` |
| `media_id_required` | 文章还没建过草稿 | 先 `draft_create`，或显式传 `mediaId` |
| `publish_id_required` | 缺 publishId | 先 `publish_submit`（`yes: true`）拿 `publishId` |
| `preset_*` | 预设不存在/不合法/已存在/被保护 | `preset_invalid` 会列出哪一项不合规；`standard` 不允许删 |
| `unknown_subcommand` / `args_required` | 子命令或参数写错 | 看 `message` 里的「可用: …」 |
| `cli_not_found` | 找不到 `bin/wxmp.js` | 检查插件配置 `cliPath` 或环境变量 `WXMP_CLI_JS` |
| `timeout`（工具层，`exitCode: 124`） | 子进程超过 `timeoutMs`（默认 120000） | 多为 AI 出图 / 大批图片上传；拆小或调大插件配置 |

## 发布终态（`publish_wait` / `publish_status` 的 `statusLabel`）

`0` 发布成功 · `1` 发布中 · `2` 原创校验失败（重复度高，改写后重提）· `3` 常规失败（看 `fail_idx`）
· `4` 平台审核不通过（内容需修改）· `5` 发布后被删除 · `6` 发布后被系统封禁。

**只有 `0` 是成功**；其他都返回 `ok:false`，别当成功收尾。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（`--version` / `help` 也是 0） |
| `1` | 业务失败；也是**所有未分类异常的兜底**。含 `article_check` 不过、`review` 低于 `minScore`、`publish_wait` 终态非 0 或超时、`doctor` 关键项不过 |
| `2` | 用法错误（缺参、未知命令/子命令、非法枚举） |
| `3` | **仅一处**：`article illustrate --apply` 写盘未生效（CLI-only 能力） |
| `124` | **不是 CLI 的码**，是插件层表示「调用 CLI 超时」 |

`ok` 就是 `exitCode === 0`。注意 `publish_wait` 自己要等 120s，与插件默认超时同为 120000ms——
等长任务请显式传小一点的 `timeoutMs`。
