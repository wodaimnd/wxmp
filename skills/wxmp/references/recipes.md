# 常见配方

| 想做的事 | 怎么做 |
|---|---|
| 从零写一篇并发布 | SKILL.md 的「从零发一篇」整条链路 |
| 只做封面不动别的 | `cover`（只写回 `cover:` 一行） |
| 清空作者名 | `article_set_author`，`author: ""` |
| 改标题 | 工具侧没有 set-title：直接编辑 .md 的 `title:`，或用 `article_new` + `force: true` 重建（**会覆盖正文，慎用**） |
| 看草稿箱 | `draft_list`；单条 `draft_get`；总数 `draft_count` |
| 改完稿更新草稿 | `draft_update`（复用 `mediaId`）——**别重复 `draft_create`**，否则堆重复草稿 |
| 查发布进度/结果 | `publish_status` 查一次；要等终态用 `publish_wait`（默认 120s 超时、5s 轮询） |
| 看已发布列表 / 删一篇 | `publish_list`；`publish_delete`（要 `yes: true`） |
| 换打分标准 | `article_review` 传 `preset`（一次性）或 `article_preset_use`（长期） |
| 用别人分享的预设 | 先把 JSON write 到磁盘 → `article_preset_import`（同名加 `force: true`） |
| 先不真发，看会传什么 | `draft_create` 传 `dryRun: true`；`publish_submit` 不传 `yes` |
| 本地看排版 | `article_preview` |
| 从别人的公众号文章起步 | CLI：`wxmp article import <url>`（工具侧没有，见 `cli-only.md`） |
| 起标题 / 定大纲 / 写简报 | CLI：`article titles` / `article outline` / `article brief`（见 `cli-only.md`） |

## 封面细节

```json
{"operation":"cover","params":{"file":"<文章.md>"}}
```

- 默认输出 `<文章目录>/<文章名>-cover.png`——**每篇独立**，不会互相覆盖。
- 生成后**自动把 `cover:` 写回 front matter**；`data.frontMatter.written` 是写回结果，
  失败时返回里会给出手动要补的那一行。封面不在文章目录里就不改 front matter。
- 背景三档优先级（前者可用就赢）：`bg`（自己的底图，最可控）→ `imageGen`（AI 生成，需配 key，
  失败**自动回落渐变并把原因写在 `background.note`**）→ 都不给就用内置渐变。
- 尺寸默认 **900×383（2.35:1，微信大图封面档）**，`data.coverSize` 回报最终值；越界会夹边、比例偏会警告。
- `subtitle` 不传时用文章的 `author`；`badge` 是封面角标。
- `data.method`：`composite` = AI/底图 + GDI 中文标题；`gdi` = GDI+ 渲染（含中文标题）；
  其他 = 纯色渐变回退（**无文字**）。
- **缺封面时微信报 `40007 invalid media_id`**（它把「缺参数」也报成素材无效）——别去查素材库，先跑 `cover`。
  front matter 没写 `cover:` 时，`draft_create` 会认领同目录的 `<文章名>-cover.png` 兜底；
  再没有则本地就拦下（`cover_required`），不会让你撞到微信那条错。
- 自定义画面描述与尺寸（`--prompt` / `--width` / `--height`）**工具侧没接线**，只能走 CLI。

## 数据落点与副作用边界

- 文章：`%LOCALAPPDATA%\wxmp\articles\`（可用环境变量 `WXMP_HOME` 改）。
- 配置与凭据：`config.json`（同目录）；输出里凭据一律打码。
- 插件调用日志 + `mount-state.json`：`<stateDir>/logs\`。出问题先读这两个文件，不要靠复现。
- `publish_submit` / `publish_delete` **必须显式 `yes: true`**，默认 dry-run。
- 面板与后端只走本机回环 `/api/wxmp`（要求同源），外部访问返回 403。
- 卸载插件**不会**删文章与配置。
