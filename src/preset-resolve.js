/**
 * 体检预设的解析与选择。
 *
 * 这一层是 **CLI / 工具 / 面板三条入口共用的唯一真相**：
 * 三条入口都不许自己去拼路径或自己决定回合，否则「面板显示 short-punch，CLI 却按 standard 打分」
 * 这种分歧必然出现，而且极难查（两处都对，只是不一致）。
 *
 * 回落顺序（前一个可用就赢）：
 *   1. 显式传入的 presetId（`--preset`）
 *   2. config.json 里保存的 `reviewPreset`（用户上次选的）
 *   3. 内置 standard
 * 任何一步失败都**不抛**，退回 standard 并在 `notes` 里说清为什么——
 * 体检是反馈通道，它自己不能因为「预设目录里有个坏文件」就整体失效。
 */

import fs from 'node:fs'
import path from 'node:path'

import { BUILTIN, listPresetDirs, presetRoot, readPresetDir, ensureBuiltinPresets } from './presets.js'
import { PRESETS, builtinPresetById } from './builtin-presets.js'
import { homeDir, loadConfig, saveConfig } from './state.js'

/** 预设根目录（跟随 WXMP_HOME / %LOCALAPPDATA%）。 */
export function presetsDir() {
  return presetRoot(homeDir())
}

/** 首次使用时把内置预设落盘（幂等，绝不覆盖用户已改的）。 */
export function ensurePresets() {
  return ensureBuiltinPresets(presetsDir(), PRESETS)
}

/**
 * 列出可用预设：磁盘目录优先，缺的内置预设用内存里的版本补上（不会因为没落盘就看不到）。
 * @returns {{presets: Array, root: string, error: string|null}}
 */
export function listPresets() {
  const root = presetsDir()
  let error = null
  try {
    const ensured = ensurePresets()
    if (ensured.error) error = ensured.error
  } catch (e) {
    error = e.message
  }

  const fromDisk = listPresetDirs(root)
  const byId = new Map(fromDisk.map((item) => [item.id, item]))
  const rows = []
  for (const preset of PRESETS) {
    if (byId.has(preset.id)) continue
    // 没落盘（或目录被删）就展示内置版本，标记 source=builtin
    rows.push({ ...preset, source: 'builtin', ok: true, errors: [], dir: '' })
  }
  for (const item of fromDisk) {
    rows.push({ ...item, source: 'disk' })
  }
  rows.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return { presets: rows, root, error }
}

/** 读某个预设；不存在则回落 standard。 */
export function loadPreset(id) {
  const wanted = String(id ?? '').trim()
  const root = presetsDir()
  if (wanted) {
    const dir = path.join(root, wanted)
    if (fs.existsSync(dir)) {
      const fromDisk = readPresetDir(dir, { id: wanted })
      return { preset: fromDisk, notes: fromDisk.ok ? [] : fromDisk.errors, fallback: !fromDisk.ok }
    }
    const builtin = builtinPresetById(wanted)
    // 内置对象没有 ok 字段（那是磁盘加载的健康标记）。这里补上 ok:true，
    // 与 listPresets 的内置行同一惯例——否则全新环境里 savePresetSelection
    // 会把 !preset.ok 当「预设不合法」拒掉，preset use 在首次使用时必挂。
    if (builtin) return { preset: { ...builtin, source: 'builtin', ok: true, errors: [], warnings: [] }, notes: [], fallback: false }
  }
  // 没指定/找不到：用 standard（磁盘版优先，保证用户改过的 standard 生效）
  const stdDir = path.join(root, BUILTIN.id)
  if (fs.existsSync(stdDir)) {
    const fromDisk = readPresetDir(stdDir, { id: BUILTIN.id })
    if (fromDisk.ok) return { preset: fromDisk, notes: [], fallback: false }
    return {
      preset: { ...BUILTIN, source: 'builtin', ok: true, errors: [], warnings: [] },
      notes: [...fromDisk.errors, '内置 standard 预设目录损坏，已退回出厂默认值'],
      fallback: true,
    }
  }
  return { preset: { ...BUILTIN, source: 'builtin', ok: true, errors: [], warnings: [] }, notes: [], fallback: false }
}

/**
 * 解析「这次体检用哪个预设」。CLI / 工具 / 面板都走这里。
 * @param {string} [explicitId] --preset 显式指定
 * @returns {{preset, notes, resolvedFrom, fallback}}
 */
export function resolvePreset(explicitId) {
  const notes = []
  let resolvedFrom = 'explicit'
  let id = String(explicitId ?? '').trim()

  if (!id) {
    const config = loadConfig()
    id = String(config.reviewPreset ?? '').trim()
    resolvedFrom = id ? 'config' : 'default'
  }

  const loaded = loadPreset(id)
  notes.push(...loaded.notes)

  // 显式指定但没找到：要说清，否则用户以为换成了却还在用旧的
  if (id && resolvedFrom === 'explicit' && loaded.preset.id !== id) {
    notes.push(`找不到预设 ${id}，本次按 ${loaded.preset.id} 打分`)
  }
  return { preset: loaded.preset, notes, resolvedFrom, fallback: loaded.fallback }
}

/** 记住用户选择的预设（存进 config.json，跟着 stateDir 走）。 */
export function savePresetSelection(id) {
  const loaded = loadPreset(id)
  if (loaded.preset.id !== String(id ?? '').trim()) {
    return { ok: false, error: `预设不存在：${id}`, preset: loaded.preset }
  }
  if (!loaded.preset.ok) {
    return { ok: false, error: `预设不合法，未保存：\n${loaded.notes.join('\n')}`, preset: loaded.preset }
  }
  saveConfig({ reviewPreset: loaded.preset.id })
  return { ok: true, preset: loaded.preset, error: null }
}

/** 当前生效的预设 id（给面板/工具显示「现在按哪个标准打分」）。 */
export function currentPresetId() {
  return resolvePreset().preset.id
}

/**
 * 把预设拆成「写作提示词」的原料：风格正文 + 阈值节奏行。
 *
 * 预设的第一身份是写作提示词（教 AI 怎么写），打分只是写完后的复核。
 * 这里只拆原料不拼版式：CLI `preset prompt`、面板「复制写作提示词」、
 * `article brief` 的风格节，各自要的版式不同，但原料必须同源——
 * 否则「brief 里的风格」和「prompt 命令输出的风格」迟早改岔。
 */
export function composePresetPrompt(preset) {
  const p = preset && preset.thresholds ? preset : BUILTIN
  const T = p.thresholds || BUILTIN.thresholds
  const style = String(p.style || '').trim()
  const rhythmLines = [
    `- 一段 ≤ ${T.paragraphLong} 字（到 ${T.paragraphHuge} 字算过长），平均段长 ≤ ${T.paragraphAvg} 字`,
    `- 一句 ≤ ${T.sentenceLong} 字，主语先出现`,
    T.sectionsMin > 0
      ? `- 小节 ${T.sectionsMin}~${T.sectionsMax} 个 ##，每个小标题 ≤ ${T.headingLong} 字`
      : `- 小节数不限（这个预设不要求分节），用到小标题时每个 ≤ ${T.headingLong} 字`,
    `- 开头 ${T.hookChars} 字内要出现钩子`,
    `- 代码块 ≤ ${T.codeLinesWarn} 行、表格 ≤ ${T.tableColsWarn} 列，超出时先想怎么拆`,
    `- 写完跑 wxmp article review 复查，这套标准的及格线 ${T.passScore} 分`,
  ]
  return {
    id: p.id || 'standard',
    name: p.name || p.id || '未命名预设',
    style,
    rhythmLines,
    hasStyle: Boolean(style),
  }
}
