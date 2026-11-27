# 打分怎么算 + 预设机制

## 报告长什么样

```json
{ "score": 74, "grade": "C", "pass": false,
  "preset": { "id": "standard", "name": "标准公众号" },
  "breakdown": { "limits": 25, "structure": 14, "readability": 12, "assets": 15, "content": 8 },
  "weights":   { "limits": 25, "structure": 20, "readability": 20, "assets": 15, "content": 20 },
  "counts": { "error": 0, "warn": 3, "info": 4 },
  "findings": [ { "level": "warn", "category": "readability", "code": "paragraph_long",
                  "message": "第 2 段 358 字，一屏读不完",
                  "suggest": "在「…」这里断开，拆成 2~3 段，每段 ≤ 200 字",
                  "line": 12 } ],
  "nextActions": ["L12: 在「…」这里断开，拆成 2~3 段，每段 ≤ 200 字"] }
```

## 分数是怎么出来的（`src/review.js:283-318`）

1. `breakdown` 每个类别**从权重分起扣**，扣分表（`DEDUCT`）按类别不同：

| 类别 | `warn` 扣 | `info` 扣 | 说明 |
|---|---|---|---|
| `limits` | — | — | 任一 `error` **直接清零**（`breakdown.limits = 0`） |
| `structure` | **8** | 3 | 结构问题最贵 |
| `readability` | **6** | 2 | |
| `assets` | **6** | 2 | |
| `content` | 内容层自己的两个值 | | 内容层都是建议性质，扣分轻 |

   没在上面列出的类别走兜底 **warn 4 / info 2**。**不要按「warn 一律 4 分」手算**，会跟报告对不上。
2. `score = round(Σ各类得分 ÷ Σ权重 × 100)`——所以换预设（权重变了）分数就变，这是设计意图。
3. `pass = score >= passScore && 一条 error 都没有`。
4. `grade`：`A` ≥90、`B` ≥ `passScore`、`C` ≥70、`D` 其余。
5. `metrics` 是原始数字（段落/句子平均长度、最长段落、图片数、外链图数、小节数…），想自己算趋势就用它。

`findings` 已按 `error → warn → info` 再按行号排好，从上往下做即可。
finding 共 39 个 `code`，按类别大致分：

- `limits`：`title_missing`、`title_long`、`author_long`、`digest_long`、`content_long`、`content_big`
- `structure`：`no_outline`、`first_heading_level`、`level_jump`、`heading_long`、`few_sections`、`many_sections`、`h1_many`
- `readability`：`paragraph_long`、`paragraph_avg`、`sentence_long`、`sentence_long_many`、
  `paragraph_duplicated`、`blank_lines`、`punct_mixed`、`weak_hook`、`weak_ending`
- `assets`：`cover_missing`、`image_remote`、`image_no_alt`、`code_long`、`table_wide`
- `content`：标题吸引力、开头钩子、依据/体裁完整度相关（结构层 27 + 内容层 12）

## 预设

同一套规则引擎，只换**阈值与权重与风格**——短稿被嫌「没结构」、长稿被嫌「太啰嗦」，是同一把尺子造成的。

**预设的第一身份是写作提示词**（1.8.0 起）：每个预设带一份 `style.md` 风格提示词，
定义开头怎么钩人、段落什么节奏、什么语气、结尾给什么动作。写之前取它、照它写，
体检只是写完后的复核——顺序是 **use → prompt → 写 → review**，不是写完再对着分数返工。

| id | 名字 | 适用 | 段落长/过长 | 段落均 | 句子长 | 小节 | 代码行 | 表列 | 及格线 | 权重 限制/结构/可读/素材/内容 |
|---|---|---|---|---|---|---|---|---|---|---|
| `standard` | 标准公众号 | 通用长文（兜底） | 200 / 320 | 150 | 60 | 3~8 | 20 | 5 | 80 | 25 / 20 / 20 / 15 / 20 |
| `short-punch` | 短平快三点式 | 通知、活动、单点方法论 | 120 / 200 | 90 | 45 | 2~5 | 12 | 4 | 80 | 20 / 15 / **25** / 15 / **25** |
| `deep-longform` | 深度长文 | 复盘、方法论、长案例 | 300 / 450 | 240 | 80 | 4~10 | 30 | 6 | 75 | 20 / **30** / 20 / 15 / 15 |

- `article_presets` 看有哪些（`current` 是当前生效的；带 `style.md` 的会标「有风格提示词」）；
  `article_preset_show` 看某个的完整阈值/权重/风格。
- **`article_preset_prompt <id>`**（不带 id 就用当前生效的预设）返回拼好的完整写作提示词：
  风格正文 + 六行节奏参考（段长/句长/小节/钩子字数/代码表格/及格线）。写之前拿它当指令。
- `article_brief` 的任务书**已内嵌当前预设的风格节**（`--preset` 可换），用它就不必单独取 prompt。
- `article_review` 的 `preset` 参数**只对这一次生效**；`article_preset_use` 把选择存进 config，之后默认用它。
- 选法：短通知用 `short-punch`，认真写的方法论/复盘用 `deep-longform`，拿不准用 `standard`。
- **换预设会改变分数，这是设计意图**，报告里 `preset.id` 会自报用的哪把尺子。

### 自定义 / 导入导出

- 目录：`<stateDir>/presets/<id>/{preset.yml, review.json, style.md}`；`preset.yml` 只认 `name`/`description`/`order`，
  规则本体在 `review.json`，风格提示词在 `style.md`（可选，多行纯文本，直接编辑器改）。
  没有 `style.md` 的预设只能打分，写作侧拿不到文风要求（`preset show` / 导入 warnings 会提醒）。
- 分享复用：`article_preset_export` 出单文件 JSON（`format: "wxmp-review-preset"`，**`version: 2`**，
  v2 多带 `style` 字段；v1 旧文件仍可导入，只是导入后没有风格提示词），
  别人 `article_preset_import` 即可；**同名默认拒绝**，要覆盖得传 `force: true`（覆盖会同步删掉旧的 style.md 残留）。
- 两条硬约束：
  - `weights` **五个类别必须全给且合计正好 100**。缺类会**报错并给出等比折算建议**，不会静默改你的数字。
  - `thresholds` 必须在各自允许区间内；且 `sectionsMin <= sectionsMax`、`paragraphLong <= paragraphHuge`。
  - `style` 不做校验（是人/AI 读的文案，不是数值规则）。
- 不合法就回退内置值并把原因报出来，报错码形如 `preset_invalid`（会列出具体哪一项不合规）。
- `standard` 是兜底预设，**不允许删**（`preset_protected`）。
- `article_preset_reset` 逐文件补齐：1.7.x 升上来的用户目录里已有 yml+json，
  会补上缺失的 `style.md`，且**不动你改过的任何文件**。
