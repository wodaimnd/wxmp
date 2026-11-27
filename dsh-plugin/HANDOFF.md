# HANDOFF — wxmp 插件交接报告

> **这份文件是插件的活体状态卡，不是历史归档。**
> 任何改动插件的行为、契约、数据结构、错误码、测试的修改，**必须在同一个改动里更新本文件**
> （见文末「交接报告维护规则」）。报告与代码不一致时，**代码是错的还是报告是错的，必须当场判定**，
> 不许放着不管 —— 下一轮接手的人会照报告办事，报告骗人比没有报告更糟。
>
> 校验：`node tools/handoff-check.mjs`（本包自带，改动后必跑，退出码非 0 = 报告已过期）。

| 项 | 值 |
|---|---|
| 插件名 | `@local/wxmp`（模型侧工具名 `wxmp`，面板 `panellist.id = wxmp`） |
| 版本 | **1.8.3** |
| 插件真家 | `G:\AI PGRM\DSH\wxmp\dsh-plugin` ← **只改这里** |
| CLI 真家 | `G:\AI PGRM\DSH\wxmp`（`bin/` `src/` `lib/` `tools/` `test/`） |
| 报告生成时间 | 2026-11-14 10:16 +08:00（1.8.2 时更新；1.8.3 仅改版本号与发布形态，内容未变） |
| 最近验证 | `npm run verify` = `handoff-check` 19 项 OK + 全量 328 用例 pass |

⚠️ **路径陷阱（已踩过一次）**：`G:\AI PGRM\GZH\wxmp` 是 1.7.7 的**临时副本**，
不是插件真家。上一轮 O2 修复曾改在副本上，等于没改。判断标准：真家有 `bin/ src/ lib/ test/ tools/`
五个目录与 `.git`；副本只有 12 个文件。

---

## 一、一句话现状

公众号文章工作台：Markdown 写稿 → 体检打分（0~100，带行号）→ 生成封面 → 建草稿 → 发布/查状态。
双半结构：**Host 半**（`index.js` 模型工具 + `ui-backend.js` 面板 HTTP 后端）与
**浏览器半**（`client.js` 三栏面板）。两半只通过 `POST /api/wxmp` 通信。

**当前状态：可用，测试全绿，无已知阻断缺陷。** 唯一未闭环项是外部凭据轮换（见第七节）。

---

## 二、文件地图（改动前先看这里）

| 文件 | 行数 | 角色 | 改它要连带改什么 |
|---|---|---|---|
| `index.js` | ~1359 | Host 半：注册 `wxmp` 工具、CLI 串行队列、失败形状、`article_delete` 本地 op、挂载 `/api/wxmp` | `OPERATIONS` ↔ `buildArgv` ↔ `PARAMETER_HINTS` 三处必须同步；`DEFAULTS` ↔ `cordis.patch.yml` 逐字一致 |
| `ui-backend.js` | ~923 | 面板 HTTP 后端：`UI_OPERATIONS` 白名单、`buildUiArgv`、`deleteArticleFile`、`createUiHandler` | 新增 op 要同时加进 `UI_OPERATIONS` 与 `client.js` 调用点 |
| `client.js` | ~4491 | 浏览器半：`window.__ModuleLoader__.load` 入口、`sidebar.panellist` + `main` 两个槽位 | 改槽位名会直接让面板消失 |
| `logger.js` | ~161 | 插件日志（JSONL + 轮转 + `clear()`） | 别动 `clear()` 的返回语义（`clearPluginData` 依赖它返回 boolean） |
| `cordis.patch.yml` | 43 | 装载行：`wxmp`（工具+面板）+ `wxmp-skills`（技能根） | `config` 必须与 `DEFAULTS` 逐字一致；**不给开关行加 `!!js` 条件** |
| `package.json` | 73 | `exports` / `files` / `dsh.bundle` / `dsh.forge.effects` | 加文件要进 `files`；加副作用要进 `effects` |
| `skills/wxmp/SKILL.md` | 188 | 随包技能（模型读的说明书） | **字符预算 8192，现用 7856，只剩约 116 字符** |
| `skills/wxmp/references/*.md` | 7 篇 | 技能细节（operations / troubleshooting / writing / ecosystem / recipes / review-and-presets / cli-only） | 超 8192 字符就往这里拆 |

**测试**：`test/` 下 19 个套件，`npm test` 全量（在 `G:\AI PGRM\DSH\wxmp` 根跑）。
单套件跑法：`node --test test/plugin.test.js`。

---

## 三、双半契约（改动最容易翻车的地方）

1. **禁止跨进程 import**：浏览器半不得 `import '@deepseek-ai/*'`；Host 半只用注入服务。
2. **路由两条**：`kind:'exact'` 的 `POST /api/wxmp`（严格白名单 op）+ `kind:'prefix'` 兜住
   `GET /api/wxmp/cover`。**缺 prefix 会让封面图 403**（历史坑：`403 Browser access is disabled`
   看着像权限问题，其实是没人接请求）。
3. **`inject` 必须留空 `[]`**：模块级 `inject` 是全有全无的。只写 `['tools']` 会让 `webServer`
   拿不到，面板静默不挂载 —— 这是 0.1.0「工具能用、面板打不开」的根因。
   正确做法：每块功能各自 `ctx.inject([...])`。
4. **槽位只有两个**：`sidebar.panellist`（`id='wxmp'`, order 30）与 `main`
   （`key` 必须与 panellist 的 `id` **字面相同**）。不一致的后果是「侧栏有条目、点进去永远空白」。
5. **串行队列**：所有 CLI 调用走 `enqueue()`。`draft create` 把 mediaId 写回 front matter，
   `publish submit` 依赖它，并发会互相踩踏。

---

## 四、错误形状契约（**O2 已修，改动时别退回去**）

三条失败来源必须同形，顶层都要有 `code` / `error` / `hint`：

| 来源 | 构造者 |
|---|---|
| 宿主半自己判定的失败 | `failure(code, message, exitCode?, hint?)`（`index.js` L542） |
| 本地 op（`article_delete`） | `ui-backend.deleteArticleFile` 的 `fail()` |
| CLI 自己报的失败 | `promoteCliFailure(result)`（`index.js` L696，被 L1133 调用） |

**宿主半构造的短码全集**（`FAILURE_HINTS` 有专门 hint 的这 6 个；其余码走兜底提示）：

| code | 含义 | 下一步 |
|---|---|---|
| `cli_not_found` | 找不到 `bin/wxmp.js` | 配置 `cliPath` 或设 `WXMP_CLI_JS` |
| `unknown_operation` | op 不在 `OPERATIONS` 里 | 先看工具描述的 op 列表，或 `doctor` |
| `invalid_params` | 必填项缺失/空串 | 按参数提示补齐；探路用只读 op |
| `spawn_failed` | 子进程起不来 | 确认 `cliPath` 指向的文件存在 |
| `timeout` | 超过 `timeoutMs` | 写类先别重试，先查首次是否已被受理 |
| `cli_error` | CLI 退出非 0 且无 JSON 可解析 | 看 `text` 原文，必要时 `doctor` |


**历史缺陷 O2**：`failure()` 原本定义在 `runCli` 之后，于是 `runCli` 的三条出口
（spawn 抛错 / 子进程 error / 超时）与 `parseCliOutput` 的兜底分支各写一份裸对象，
顶层三样全缺。F19 只治了工具入参校验那条路径。

**修复要点（三处，缺一即回归）**：
- `failure()` 与 `FAILURE_HINTS` 提到 `parseCliOutput` **之前**；
- `runCli` 三条出口全部改走 `failure()`（`spawn_failed` exit 1 / `timeout` exit 124）；
- `parseCliOutput` 兜底分支走 `failure('cli_error', …)`，且 `exitCode===0` 时仍 `ok:true`。

**三条不许动的边界**：
1. 成功结果**不塞**顶层 `code`；
2. CLI 没给稳定短码时**不编一个码**出来（宁可少字段，不给假码）；
3. 已带顶层 `code` 的（本地 op、`failure()` 构造的）**不重复套**。

> 回归锁：`test/plugin.test.js` 的「O2：CLI 失败路径顶层带 code / error / hint」。
> 该断言已做过**变异验证**：把兜底分支改回裸对象 → 立刻红（pass 6 / fail 1）；
> 还原 → 绿（pass 7 / fail 0）。**改这段代码前先跑它，改完再跑它。**

---

## 五、operation 清单（42 个工具 op + 面板 op）

工具侧 `OPERATIONS`（42 个）与面板侧 `UI_OPERATIONS`（约 40 个）**不是同一份**：
面板 op 是 kebab-case（`article-delete` / `list-drafts`），工具 op 是 snake_case。
两份清单各自维护，**新增能力通常两边都要加**。

分类速查：
- 配置：`config_show` `config_set` `config_clear` `config_set_image_key` `config_set_image_provider` `image_providers` `doctor`
- 写稿清理：`article_new` `article_import` `article_brief` `article_outline` `article_titles` `article_list` `article_show` `article_delete`
- 体检改稿：`article_check` `article_review` `article_set_title` `article_set_author` `article_library` `article_illustrate` `article_preview`
- 预设：`article_presets` `article_preset_show` `article_preset_prompt` `article_preset_use` `article_preset_export` `article_preset_import` `article_preset_remove` `article_preset_reset`
- 封面：`cover`
- 草稿：`draft_create` `draft_list` `draft_get` `draft_update` `draft_delete` `draft_count`
- 发布：`publish_submit` `publish_status` `publish_wait` `publish_list` `publish_delete`

**本地 op（不经 CLI）**：`LOCAL_OPERATIONS = new Set(['article_delete'])`。
CLI 没有 `article delete` 子命令，删除由 Host 半自己 `fs` 完成，复用
`ui-backend.deleteArticleFile` —— **面板路径与工具路径同一份实现**，所以同一输入给同一错误码。
它**不进 `enqueue` 串行队列、不进超时重试**（重试会撞上「第一次已删掉」的 ENOENT，把成功报成失败）。

`article_delete` 错误码：`article_missing_arg` / `article_not_md` / `article_not_found` /
`article_outside_dir` / `article_delete_failed`。

---

## 六、超时与重试（写类不许自动重试）

- `DEFAULT_TIMEOUT_MS = 120000`；`publish_wait` 默认也 120s → **两者同时到点**。
  要等更久必须显式传更小的 `timeoutMs`（如 60000）再用 `publish_status` 续轮询。
- **只有只读调用允许自动重试**（`RETRYABLE_CALLS` 白名单，最多 2 次，退避 1s/2s）。
  写类（publish submit / draft create / draft delete / article import / config set）超时后
  **一次都不重试** —— timeout ≠ 服务端没执行，重试等于重复发布/重复建稿。
- 白名单用**逐级前缀匹配**（`isReadOnlyCall`）：`article brief 我的选题`（面板位置参数）
  与 `article brief --topic X`（工具）必须得到同一判定。
  **不许把 `article` / `config` / `draft` / `publish` 这类命名空间前缀放进表**，
  否则 `article import` 会被误判成读类。

---

## 七、未闭环项（**下一手必须知道**）

| # | 项 | 状态 | 谁来做 |
|---|---|---|---|
| 1 | ModelScope 图像 API key 轮换 | **待用户操作** | 用户：去 ModelScope 控制台吊销并重建 key，再 `config_set_image_key` |
| 2 | `config.json` 中明文凭据 | **待用户决定** | 用户；若要加密存储需改 CLI 侧，属新需求不是 bug |
| 3 | 工作区未提交 | 当前 `dsh-plugin/` 有未提交改动（含本次 O2 修复） | 发布前由用户确认后 commit |
| 4 | `G:\AI PGRM\GZH\wxmp` 临时副本 | 1.7.7 快照，**含上一轮误改** | 建议直接删除，避免下次又改错地方 |
| 5 | `.audit/` 与 `.f6-residue-*` | 历史审计产物，非运行依赖 | 想清理就清理，不影响功能 |

**发布前检查**（用户说「发布」时才做）：
`node tools/handoff-check.mjs` → 全量 `npm test` → `guard_check_bundle` → 才谈 `multi-platform-releaser`。

---

## 八、常见故障 → 先看哪个文件

出问题**先读数据面，不要靠复现**：

| 症状 | 先看 |
|---|---|
| 面板打不开 / 侧栏没条目 | `<stateDir>/logs/mount-state.json`（`mounted` / `reason`）→ `plugin.log` |
| 工具能用、面板空白 | `cordis.patch.yml` 的 `wxmp-skills` 装载行 → `mount-state.json` |
| 封面图 403 | 是否只注册了 `exact` 而漏了 `prefix`（第三节） |
| 某个 op 报 `unknown_operation` | `OPERATIONS` 有、`buildArgv` 没分支 |
| 面板发 op 后端不认 | `UI_OPERATIONS` 没加 |
| 失败结果读不到 code | 第四节（O2），先跑那条回归测试 |
| 装了插件技能看不到 | `cordis.patch.yml` 的 `bundledSkillDir` 表达式；缺它 `skills/` 是死文件且**不报错** |

`stateDir` 默认 `%LOCALAPPDATA%\wxmp`（可用 `WXMP_HOME` 或 config `stateDir` 改）。

---

## 九、交接报告维护规则（**硬规则，与代码同级**）

**改动代码 = 改动报告。** 两者必须在同一个改动里完成，不许「先合代码，报告下次再说」。

### 必须更新本文件的触发条件（任一命中就要动）

1. 增删改任何 `OPERATIONS` / `UI_OPERATIONS` 的 op
2. 增删改任何错误码（`failure()` 的 code、`FAILURE_HINTS` 键、`article_delete` 系列）
3. 改返回结构的形状（顶层字段、`data` 结构、`text` 语义）
4. 改槽位（槽位名、`panellist.id`、`order`、`main.key`）
5. 改路由（路径、`kind`、方法、白名单）
6. 改 `DEFAULTS` / `cordis.patch.yml` 的 config
7. 改持久化落点或文件名
8. 改超时 / 重试策略
9. 增删测试套件，或改动「回归锁」类断言
10. 改版本号
11. 文件地图里的行数偏差超过 ±20%（说明结构动过了）
12. 修复或新发现缺陷 → 同步第七节「未闭环项」

### 只改文案 / 注释 / 排版 → 不必更新本文件，但要跑一次校验

### 怎么校验（机械拦截，不靠自觉）

```powershell
cd "G:\AI PGRM\DSH\wxmp\dsh-plugin"
node tools/handoff-check.mjs
```

退出码 **0 = 报告与代码一致**；非 0 会逐条打印「哪条契约对不上、文件:行号、改法」。
**退出码非 0 时不许宣称改动完成**，也不许为了让它变绿去放宽检查项。

### 不许做的事

- 不许把本文件改写成「历史归档」口吻（它是活体状态卡，写现在，不写流水账）
- 不许写「应该没问题」「基本可用」这类没有证据的结论
- 不许删掉「未闭环项」来让报告看起来干净 —— 未闭环项是交接的核心价值
- 不许让本文件长到没人读：**超过 400 行就该把细节挪进 `docs/handoff-*.md` 并在此留指路条**

---

## 十、给下一手的开工顺序

1. 读本文件（你正在读）→ 读 `CHANGELOG.md` 最新一段 → 读 `skills/wxmp/SKILL.md` 的「先记住三件事」
2. `node tools/handoff-check.mjs` 确认报告没过期
3. 要改代码：先定位到第二节的行，看「改它要连带改什么」那一列
4. 改完：跑对应单套件 → 跑 `node tools/handoff-check.mjs` → 按第九节更新本文件
5. 涉及发布：第七节的发布前检查四步，一步不许跳
