# Changelog

## 1.8.3 — 2026-11-14

发布形态修正：仓库第一次包含完整项目，不再只有插件半边。

- 修复（**发布**）：此前仓库只推了 `dsh-plugin/` 子目录，`bin/` `src/` `lib/` 全部缺失，
  `wxmp doctor` 一律报 `cli_not_found`。现改为推送项目根（含 CLI 与插件），
  插件按 `pluginDir/../bin/wxmp.js` 即可自动定位 CLI，无需配置 `cliPath`。
- 版本号与 tag 对齐：`package.json` 与 `dsh-plugin/package.json` 同步为 `1.8.3`，
  对应 tag `v1.8.3-full`。

代码未改动；本版仅修正分发内容与版本声明。

## 1.8.2 — 2026-11-14

失败形状收口（O2）+ 交接报告机制。

- 修复（**O2**）：`runCli` 的三条失败出口（spawn 抛错 / 子进程 error / 超时）与 `parseCliOutput` 的兜底分支各自返回裸对象，**顶层缺 `code` / `error` / `hint`** —— 模型按工具描述读顶层时拿到 `undefined`。F19 当时只治了工具入参校验那条路径。
  - `failure()` 与 `FAILURE_HINTS` 提到 `parseCliOutput` 之前，五处出口共用同一个形状。
  - 新增两个短码提示：`spawn_failed`、`cli_error`（`timeout` 也有了专门的下一步建议）。
  - 三条边界保持不变：成功结果不塞顶层 `code`；CLI 没给稳定短码时不编造；已带 `code` 的不重复套。
- 新增：`HANDOFF.md` —— 插件交接报告，十节结构（现状 / 文件地图 / 双半契约 / 错误形状 / op 清单 / 超时重试 / 未闭环项 / 故障对照 / **维护规则** / 开工顺序）。
- 新增：`tools/handoff-check.mjs` —— 报告与代码的一致性校验，**19 项**，靠「从代码现取事实」比对而不是关键词匹配：版本号、op 数量与逐项覆盖、幽灵 op、`buildArgv` 分支、本地 op、`FAILURE_HINTS` 短码、`patch config ↔ DEFAULTS`、6 条结构断言（`failure()` 在 `runCli` 之前 / 只有一份 / `promoteCliFailure` 被调用 / `inject=[]` / exact+prefix 双路由 / `panellist.id == main.key`）、引用文件存在、报告 ≤ 400 行、`SKILL.md` 预算。
- 新增：`skills/wxmp/references/handoff.md` —— 交接规则全文（为什么、跑什么、12 项必须更新报告的触发条件、校验器查什么、不许改坏校验器的四条）。
- 新增：根 `package.json` 脚本 `handoff:check` / `handoff:check:verbose` / `verify`。
- 测试：`test/plugin.test.js` 增 O2 回归锁（顶层 code/error/hint 三样 + 与 `data.error.code` 同源 + 成功不带 code）。已做变异验证：改回裸对象立刻红，还原即绿。
- 测试：全量 328 个用例通过。

## 1.8.1 — 2026-11-12

预览与本地文件从「藏起来」变成「钉在面板上」。

- 新增：预览卡片常驻「文件路径」一行（`article.path`，等宽字体、点击复制全路径）——以前路径只在生成预览后的提示里闪一次，想改 `.md` 只能凭记忆猜目录。
- 新增：快捷打开三件套——「🌐 打开本地预览」生成 HTML 后直接用默认浏览器打开（`preview-article` 支持 `open` 参数，落到 CLI `--open`）；「📂 所在文件夹」用资源管理器定位选中；「📄 打开文件」交给系统默认 .md 程序。
- 新增：面板后端本地操作 `open-article`（`what: file | folder`），与「删除文章」同一条判定链（只 .md、realpath 拦目录穿越与软链），打开动作由宿主注入实现，测试可替换。
- 变更：预览主按钮升级为 primary 强调色；三个快捷按钮同行排列，窄栏自动换行。

## 1.8.0 — 2026-11-12

预设升级为双重身份：**先当写作提示词用，再当打分标准复核**。

- 新增：预设可选 `style.md` 风格提示词；三个内置预设（standard / short-punch / deep-longform）自带成稿风格文案（开头钩子、段落节奏、语气、结尾动作、忌）。
- 新增：`article_preset_prompt`（CLI `article preset prompt [id]`）交付拼好的完整写作提示词（风格正文 + 阈值节奏）；面板「🎯 打分预设」浮窗加「复制写作提示词」，列表行有风格的带 📝 按钮。
- 新增：`article_brief` 任务书内嵌当前预设风格节（`--preset` 可换），写前拿风格不用单独取。
- 变更：预设导出格式 version 2（多带 `style` 字段）；v1 旧文件仍可导入，只是没有风格提示词。
- 变更：升级时逐文件补齐内置预设缺失的文件——存量 1.7.x 用户自动获得 `style.md`，用户自建预设（如自定义阈值）一个字节不动；`force` 覆盖导入会同步删掉残留的旧 `style.md`。
- 修复：全新环境下首次 `article preset use/export <内置>` 误报「预设不合法」（内置回落对象缺 `ok:true`，1.7.7 起）。
- 修复：`preset prompt` 对不存在的 id 静默回落 standard——现在照样给结果，但 notes 与输出里明说「找不到预设 X，本次按 standard」。
- 修复：无风格预设的 prompt 提示里目录显示 `undefined`。
- 测试：全量 322 个用例通过（含预设风格化回归、1.7.x 升级路径、全新环境内置预设回归）。

## 1.7.7 — 2026-11-11

插件工程化版本：预设持久化选择、体检预设切换、面板预设浮窗、文章删除操作、cliPath/stateDir 自动定位。
