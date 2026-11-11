# 还剩下什么只能走 CLI

`wxmp` 工具现在有 **40 个 operation**，CLI 的创作链路（导入、起标题、写作简报、大纲、
素材库、插图、改标题、预设增删、AI 配图 key、清凭据）**全部已接通**。下面只剩几件
工具层没有对应 operation 的小事，需要时用 shell：

```
node <插件目录>/../bin/wxmp.js <命令>
```

| CLI 命令 | 干什么 | 为什么没做成 operation |
|---|---|---|
| `wxmp article review --file <md> --no-next` | 关掉 `nextActions`，输出更短 | 省 token 的偏好，不是能力 |
| `wxmp draft create --comments 1` / `draft update --comments 1` | 建/改草稿时开启评论 | 用得少；`draft_update` 已能改文章再提交 |
| `wxmp draft get --media-id <id> --raw` | 草稿原始 JSON | 排障用，`draft_get` 已给结构化结果 |
| `wxmp publish list --full` | 已发布列表带正文 | 正文很占上下文，默认不带更安全 |
| `wxmp --version` / `wxmp help` | 版本与总帮助 | 版本号有坑，见文末 |

## ⚠ 工具侧没有 `publish list --full`，别硬要

`publish_list` 只接受 `offset` / `count`。已发布正文动辄几千字，进上下文会把一篇稿子的
预算吃光。真要正文，走 `article import <那篇的 url>` 拿成 .md，比拉 JSON 干净。

## CLI 参数解析的坑（只有走 shell 才需要看）

- **`--yes true` 是静默陷阱。** `yes` / `apply` / `audit` / `usable` / `brief` / `guide` /
  `image-gen` / `allow-builtin` / `custom` 都**不在**布尔 flag 白名单里，`--yes true` 会被
  解析成字符串 `"true"`，而判断是 `=== true`，于是**等于没给**，命令照样 dry-run。
  CLI 上要写 **`--yes`**（裸 flag）。
  **工具侧不存在这个问题**：`params.yes = true` → 裸 `--yes`；`params.yes = "true"`
  → `--yes true` → 被判成没给。所以模型必须传布尔 `true`，不要传字符串。
- 写命令（`article set-author` / `set-title`）**必须写明 `--file`**，不会默认改「最近那篇」。
  工具侧同理：`article_set_title` / `article_set_author` 的 `file` 是必填。
- `--theme` 显式给错会直接 `theme_unknown`（exit 2），不会静默回落 `default`。
- `--base-url` 有两个含义：全局网关（走 `clientFromOptions`）和 `config set --image-provider`
  的供应商接入地址。工具层已经避免重复追加，shell 里两个别混着传。

## 版本号三分裂（报 bug 时注意）

`bin/wxmp.js` 报 `wxmp 1.7.1`，`package.json` 与插件 `index.js` 都是 `1.7.7`。
`wxmp --version` 的输出**不等于**包版本，别拿它判断装的是哪一版。
