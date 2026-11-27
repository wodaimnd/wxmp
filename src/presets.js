/**
 * 体检预设：把「什么算写得好」从代码里拆出来，变成可导入导出、可选择的文件。
 *
 * 设计照 DSH 的 agent 预设（`~/.dsh/.agent-presets/<id>/preset.yml`）：
 * 一个目录一个预设，目录名就是 id，`preset.yml` 只认三个字段。
 * 这里多一个 `review.json`（规则本体）——YAML 写嵌套规则太容易手抖出错，
 * 而 preset.yml 只承担「叫什么、干什么、排第几」。
 *
 * 三条硬约束（对应三类真实故障）：
 *  1. **预设坏了不能让体检崩**：任何读取/解析失败都退回内置默认，并把原因报出来。
 *     体检是反馈通道，它自己挂掉等于 AI 又瞎了。
 *  2. **不能覆盖用户的文件**：导入时同名默认拒绝，要覆盖必须显式 force；
 *     导出不改动源文件。用户的调参成果不能被一次导入抹掉。
 *  3. **数值必须可信**：每个字段都做范围校验与补齐，坏值不静默吞掉——
 *     权重加起来不是 100 就像分数失去意义，这种错误必须当场拒绝，而不是算出一个怪分数。
 *
 * 目录约定：
 *   <stateDir>/presets/<id>/preset.yml     元信息（name/description/order）
 *   <stateDir>/presets/<id>/review.json    规则本体
 *   <stateDir>/presets/<id>/style.md       风格提示词（可选；1.8.0 起）
 *
 * style.md 为什么是独立文件而不是 preset.yml 的一个字段：
 * 提示词是几十行的多行文本，扁平 YAML 解析器（见 parseSimpleYaml）只认单行标量，
 * 塞进去要么换行全丢、要么引入真 YAML 依赖。风格文本「一段一文件」也更符合
 * 「一目录一预设」的约定，用户可以直接用编辑器改，不用懂 JSON。
 */

import fs from 'node:fs'
import path from 'node:path'

/* ── 内置默认：与 review.js 的出厂值完全一致，作为兜底与「恢复默认」依据 ── */
export const BUILTIN = {
  id: 'standard',
  name: '标准公众号',
  description: '通用公众号长文：小节 3~8 个，段落 200 字内，句子 60 字内，及格线 80。',
  order: 10,
  thresholds: {
    paragraphLong: 200,
    paragraphHuge: 320,
    paragraphAvg: 150,
    sentenceLong: 60,
    headingLong: 15,
    sectionsMin: 3,
    sectionsMax: 8,
    codeLinesWarn: 20,
    tableColsWarn: 5,
    hookChars: 100,
    passScore: 80,
  },
  // 新增 content 层后重新分配，总和仍必须是 100（normalizePreset 会拒绝不等于 100 的预设）。
  // 分配依据：硬限制仍最高（发不出去谈别的没意义），内容层与结构并列——
  // 「写得对不对」和「排得顺不顺」对公众号同样重要。
  weights: { limits: 25, structure: 20, readability: 20, assets: 15, content: 20 },
}

/** 各阈值的合法区间与语义（用于校验与面板提示，超界直接拒绝而不是截断）。 */
export const THRESHOLD_SPEC = {
  paragraphLong: { min: 40, max: 2000, step: 10, label: '段落算「长」的字数' },
  paragraphHuge: { min: 40, max: 4000, step: 10, label: '段落算「过长」的字数' },
  paragraphAvg: { min: 20, max: 1000, step: 5, label: '平均段落字数上限' },
  sentenceLong: { min: 10, max: 400, step: 5, label: '单句算「长」的字数' },
  headingLong: { min: 4, max: 60, step: 1, label: '小标题算「长」的字数' },
  sectionsMin: { min: 0, max: 20, step: 1, label: '推荐小节数下限' },
  sectionsMax: { min: 1, max: 40, step: 1, label: '推荐小节数上限' },
  codeLinesWarn: { min: 3, max: 200, step: 1, label: '代码块超过多少行提示' },
  tableColsWarn: { min: 2, max: 20, step: 1, label: '表格超过多少列提示' },
  hookChars: { min: 20, max: 600, step: 10, label: '开头检查多少字有没有钩子' },
  passScore: { min: 0, max: 100, step: 1, label: '及格线（低于它就是未达标）' },
}

export const WEIGHT_SPEC = {
  limits: '硬限制（超了发不出去）',
  structure: '结构（小节、层级、大纲）',
  readability: '可读性（段落、句子、重复、钩子）',
  assets: '素材（封面、图片、表格、代码块）',
  content: '内容（标题吸引力、开头钩子、依据、体裁完整性）',
}

/* ── 极简 YAML：预设只写三个扁平字段，不值得为它引入依赖 ──────────── */
/** 解析 `key: value` 这类扁平 YAML；返回对象。不处理嵌套/数组（预设用不到）。 */
export function parseSimpleYaml(text) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value)
    out[match[1]] = value
  }
  return out
}

/** 把三个元字段写成 preset.yml。值里有换行就压成空格（解析器只接受单行）。 */
export function stringifyPresetYml({ name, description, order }) {
  const one = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  return [
    `name: ${one(name) || '未命名预设'}`,
    `description: ${one(description)}`,
    `order: ${Number.isFinite(Number(order)) ? Number(order) : 10}`,
    '',
  ].join('\n')
}

/* ── 校验：坏值必须报出来，不许静默截断 ──────────────────────────── */
/**
 * 校验并补齐一份预设。返回 `{ ok, preset, errors, warnings }`。
 * ok=false 时 preset 是**补齐后的可用版本**（这样调用方还能继续体检，只是要告知用户）。
 */
export function normalizePreset(raw = {}) {
  const errors = []
  const warnings = []
  const thresholds = { ...BUILTIN.thresholds }
  const weights = { ...BUILTIN.weights }

  const t = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {}
  for (const [key, spec] of Object.entries(THRESHOLD_SPEC)) {
    if (t[key] === undefined) continue
    const value = Number(t[key])
    if (!Number.isFinite(value)) {
      errors.push(`thresholds.${key} 不是数字：${JSON.stringify(t[key])}`)
      continue
    }
    if (value < spec.min || value > spec.max) {
      errors.push(`thresholds.${key} = ${value}，超出允许范围 ${spec.min}~${spec.max}`)
      continue
    }
    thresholds[key] = value
  }

  const w = raw.weights && typeof raw.weights === 'object' ? raw.weights : {}
  // ── 旧预设迁移 ────────────────────────────────────────────────
  /* ── 拒绝旧格式，并给出可直接照抄的写法 ──────────────────────
   * content 类别是后加的。老预设文件只有 4 个键。
   * 早先这里做过「自动按比例折算」，但那是**静默改用户数据**：
   * 用户以为自己设的是 30/25/25/20，实际跑的是 24/20/20/16/20，
   * 而且只在升级那一刻发生一次，之后再也看不出来。
   * 现在磁盘上的预设已全部升级为 5 键，这里改为明确报错 + 给出改法，
   * 让问题当场暴露，而不是在心里埋一个不准的分数。
   */
  const providedWeightKeys = Object.keys(w).filter((key) => key in WEIGHT_SPEC)
  const missingWeightKeys = Object.keys(WEIGHT_SPEC).filter((key) => !(key in w))
  let weightKeysIncomplete = false
  if (providedWeightKeys.length > 0 && missingWeightKeys.length > 0) {
    weightKeysIncomplete = true
    // 给出等比例缩放的参考值，用户复制粘贴即可，不用自己算
    const legacyTotal = providedWeightKeys.reduce((sum, key) => sum + (Number(w[key]) || 0), 0)
    const targetShare = 100 - BUILTIN.weights.content
    const suggestion = {}
    for (const key of providedWeightKeys) {
      const share = legacyTotal > 0 ? (Number(w[key]) || 0) / legacyTotal : 1 / providedWeightKeys.length
      suggestion[key] = Math.round(share * targetShare)
    }
    suggestion.content = BUILTIN.weights.content
    const drift = 100 - Object.values(suggestion).reduce((sum, value) => sum + value, 0)
    if (drift !== 0) {
      const biggest = Object.keys(suggestion).reduce((a, b) => (suggestion[a] >= suggestion[b] ? a : b))
      suggestion[biggest] = Math.max(0, suggestion[biggest] + drift)
    }
    errors.push(
      `weights 缺少类别：${missingWeightKeys.join('、')}。` +
        `现有 ${Object.keys(WEIGHT_SPEC).length} 个类别必须全部给出且合计 100。` +
        `按你原来的侧重折算后可以写成：${JSON.stringify(suggestion)}`,
    )
  }

  for (const key of Object.keys(WEIGHT_SPEC)) {
    if (weightKeysIncomplete) break // 已经报过错，不再逐个覆盖
    if (w[key] === undefined) continue
    const value = Number(w[key])
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`weights.${key} 必须是 0~100 的数字，实际 ${JSON.stringify(w[key])}`)
      continue
    }
    weights[key] = value
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
  if (total !== 100) {
    // 权重和不是 100 时分数会失去绝对意义；这是设计错误，必须拒绝而不是静默归一化
    errors.push(`weights 合计 ${total}，必须正好 100（否则分数无法横向比较）`)
  }

  if (!(thresholds.sectionsMin <= thresholds.sectionsMax)) {
    errors.push(`sectionsMin(${thresholds.sectionsMin}) 不能大于 sectionsMax(${thresholds.sectionsMax})`)
  }
  if (!(thresholds.paragraphLong <= thresholds.paragraphHuge)) {
    errors.push(`paragraphLong(${thresholds.paragraphLong}) 不能大于 paragraphHuge(${thresholds.paragraphHuge})`)
  }

  const name = String(raw.name ?? '').trim()
  if (!name) warnings.push('预设没有 name，面板会显示目录名')

  // style（风格提示词）：可选字段，透传不校验内容——它是给人/AI 读的文案，
  // 不是数值规则，长度与写法都不该被代码审判。缺了只提醒，不算错误。
  const style = String(raw.style ?? '').trim()
  if (!style) warnings.push('没有风格提示词：这个预设只能打分，写作侧拿不到它的文风要求（补 style.md，或在导入 JSON 里带 style 字段）')

  return {
    ok: errors.length === 0,
    preset: {
      id: String(raw.id ?? '').trim(),
      name: name || String(raw.id ?? '') || '未命名预设',
      description: String(raw.description ?? '').trim(),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 10,
      style,
      thresholds,
      weights,
    },
    errors,
    warnings,
  }
}

/** 带错误码的异常：上层靠 code 区分「不存在 / 已存在 / 不合法 / 受保护」，不靠猜 message。 */
function presetError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
/* ── 目录操作 ──────────────────────────────────────────────────── */
/** 预设根目录：<stateDir>/presets */
export function presetRoot(stateDir) {
  return path.join(String(stateDir || ''), 'presets')
}

/** 预设 id 白名单：只允许字母数字连字符下划线，避免目录穿越。 */
export function safePresetId(id) {
  const value = String(id ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/.test(value)) {
    throw presetError(
      'preset_id_invalid',
      `预设 id 不合法：${value || '(空)'}（只允许字母、数字、-、_，最长 49）`,
    )
  }
  return value
}

/** 读一个预设目录；失败时给出可诊断的原因而不是抛。 */
export function readPresetDir(dir, { id } = {}) {
  const ymlPath = path.join(dir, 'preset.yml')
  const jsonPath = path.join(dir, 'review.json')
  const stylePath = path.join(dir, 'style.md')
  const presetId = id || path.basename(dir)

  let meta = {}
  let metaError = null
  if (fs.existsSync(ymlPath)) {
    try {
      meta = parseSimpleYaml(fs.readFileSync(ymlPath, 'utf8'))
    } catch (error) {
      metaError = `preset.yml 读取失败：${error.message}`
    }
  } else {
    metaError = '缺少 preset.yml'
  }

  let rules = {}
  let rulesError = null
  if (fs.existsSync(jsonPath)) {
    try {
      rules = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    } catch (error) {
      rulesError = `review.json 解析失败：${error.message}`
    }
  } else {
    rulesError = '缺少 review.json（规则本体），将使用出厂默认值'
  }

  // style.md 是可选的：老预设（1.7.x）没有它，不算坏，只是写作侧少一份提示词
  let style = ''
  if (fs.existsSync(stylePath)) {
    try {
      style = fs.readFileSync(stylePath, 'utf8').trim()
    } catch {
      // 读不动就当没有：风格提示词缺失不该让打分失效
    }
  }

  const normalized = normalizePreset({ id: presetId, ...meta, ...rules, style })
  const loadErrors = [metaError, rulesError].filter(Boolean)
  return {
    id: presetId,
    dir,
    name: normalized.preset.name,
    description: normalized.preset.description,
    order: normalized.preset.order,
    style: normalized.preset.style,
    thresholds: normalized.preset.thresholds,
    weights: normalized.preset.weights,
    // 元信息缺失只是「不好看」，规则坏了才是「算得不对」——分开报
    ok: normalized.ok && !rulesError,
    errors: [...loadErrors, ...normalized.errors],
    warnings: normalized.warnings,
    raw: { meta, rules, style },
  }
}

/** 列目录下所有可用预设（按 order 升序，id 兜底排序）。 */
export function listPresetDirs(root) {
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    try {
      safePresetId(entry.name)
    } catch {
      continue // 目录名不合法就跳过，不让它污染列表
    }
    const preset = readPresetDir(path.join(root, entry.name), { id: entry.name })
    rows.push(preset)
  }
  rows.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return rows
}

/** 把内置三个预设落到目录（逐文件幂等：已有哪个文件就不动哪个，绝不覆盖用户调参）。 */
export function ensureBuiltinPresets(root, builtins) {
  const created = []
  const skipped = []
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (error) {
    return { created, skipped, error: `预设目录不可写：${error.message}` }
  }
  for (const preset of builtins) {
    const dir = path.join(root, preset.id)
    const ymlPath = path.join(dir, 'preset.yml')
    const jsonPath = path.join(dir, 'review.json')
    const stylePath = path.join(dir, 'style.md')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      skipped.push(`${preset.id}（${error.message}）`)
      continue
    }
    // 逐文件补齐而不是整个目录跳过：1.7.x 装过的用户目录里已有 yml+json，
    // 升级后 style.md 缺失——补上它，「预设成为写作提示词」才能对存量用户生效。
    let wrote = false
    try {
      if (!fs.existsSync(ymlPath)) {
        fs.writeFileSync(ymlPath, stringifyPresetYml(preset), 'utf8')
        wrote = true
      }
      if (!fs.existsSync(jsonPath)) {
        fs.writeFileSync(
          jsonPath,
          `${JSON.stringify({ thresholds: preset.thresholds, weights: preset.weights }, null, 2)}\n`,
          'utf8',
        )
        wrote = true
      }
      // style 是可选内容：内置预设都带；空字符串就不落文件（目录里没有 style.md = 没有风格提示词）
      const styleText = String(preset.style ?? '').trim()
      if (styleText && !fs.existsSync(stylePath)) {
        fs.writeFileSync(stylePath, `${styleText}\n`, 'utf8')
        wrote = true
      }
    } catch (error) {
      skipped.push(`${preset.id}（${error.message}）`)
      continue
    }
    if (wrote) created.push(preset.id)
    else skipped.push(preset.id)
  }
  return { created, skipped, error: null }
}

/**
 * 导出一个预设为可分享的单文件（JSON，含元信息与规则）。
 * 用单文件而不是打包目录：别人拿到一个文件就能导入，不用管目录结构。
 */
export function exportPreset(preset) {
  const normalized = normalizePreset(preset)
  if (!normalized.ok) {
    throw presetError('preset_invalid', `预设不合法，拒绝导出：\n${normalized.errors.join('\n')}`)
  }
  return (
    JSON.stringify(
      {
        format: 'wxmp-review-preset',
        // v2 加了 style（风格提示词）。v1 文件没有 style 也能导入——只是导入后
        // 这个预设只剩打分阈值，写作侧拿不到文风要求（importPreset 不看版本号）。
        version: 2,
        exportedAt: new Date().toISOString(),
        name: normalized.preset.name,
        description: normalized.preset.description,
        order: normalized.preset.order,
        style: normalized.preset.style,
        thresholds: normalized.preset.thresholds,
        weights: normalized.preset.weights,
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * 从一个文件内容导入预设。
 * @returns {{ ok, preset, errors, warnings }}
 * 不认识 format 也接受（宽松导入），但缺字段会补齐并给出 warnings。
 */
export function importPreset(text, { id } = {}) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ''))
  } catch (error) {
    return {
      ok: false,
      preset: null,
      errors: [`不是合法 JSON：${error.message}`],
      warnings: [],
    }
  }
  if (parsed && parsed.format && parsed.format !== 'wxmp-review-preset') {
    return {
      ok: false,
      preset: null,
      errors: [`format 不是 wxmp-review-preset（实际 ${parsed.format}）`],
      warnings: [],
    }
  }
  const normalized = normalizePreset({ id: id || parsed.id || '', ...parsed })
  return { ...normalized, preset: normalized.preset }
}

/** 把预设写进目录；已存在且没 force 就拒绝（保护用户的调参成果）。 */
export function writePresetDir(root, preset, { force = false } = {}) {
  const id = safePresetId(preset.id)
  const normalized = normalizePreset({ ...preset, id })
  if (!normalized.ok) {
    throw presetError('preset_invalid', `预设不合法，拒绝写入：\n${normalized.errors.join('\n')}`)
  }
  const dir = path.join(root, id)
  const ymlPath = path.join(dir, 'preset.yml')
  if (!force && fs.existsSync(ymlPath)) {
    throw presetError(
      'preset_exists',
      `预设 ${id} 已存在。要覆盖请显式加 force（避免抹掉你调好的参数）`,
    )
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(ymlPath, stringifyPresetYml(normalized.preset), 'utf8')
  // 只写规则本体，格式对齐导出文件，方便互相 copy
  fs.writeFileSync(
    path.join(dir, 'review.json'),
    `${JSON.stringify({ thresholds: normalized.preset.thresholds, weights: normalized.preset.weights }, null, 2)}\n`,
    'utf8',
  )
  // 风格提示词跟规则一起同步：有就写 style.md；没有就删掉残留的旧文件——
  // 否则 force 覆盖成「无风格」后，目录里还留着上一版的 style.md，
  // 写作侧会拿到一份调用方已经删掉的提示词（静默不一致，比缺失更难查）。
  const stylePath = path.join(dir, 'style.md')
  if (normalized.preset.style) {
    fs.writeFileSync(stylePath, `${normalized.preset.style}\n`, 'utf8')
  } else if (fs.existsSync(stylePath)) {
    fs.rmSync(stylePath, { force: true })
  }
  return { id, dir, preset: normalized.preset }
}

/** 删除一个预设目录（默认拒绝删内置 standard，免得把兜底删没了）。 */
export function removePresetDir(root, id, { allowBuiltin = false } = {}) {
  const safe = safePresetId(id)
  if (safe === 'standard' && !allowBuiltin) {
    throw presetError('preset_protected', '内置 standard 预设不允许删除（它是兜底，坏了要靠它恢复）')
  }
  const dir = path.join(root, safe)
  if (!fs.existsSync(dir)) {
    throw presetError('preset_not_found', `预设不存在：${safe}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { id: safe, dir }
}
