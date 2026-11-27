#!/usr/bin/env node
/**
 * handoff-check.mjs —— 交接报告与代码的一致性校验（让「改插件就得改报告」变成机械规则，不是自觉）。
 *
 * 设计原则：
 *  1. **只查能机械判定的东西**。「报告描述的行为还对不对」是人判的，机器判不了；
 *     但「报告里列了 41 个 op，代码里有 43 个」机器一定判得出，而且这往往就是漏更新报告的那一刀。
 *  2. **每条断言都必须能失败**。写死一个恒真的断言等于没查，还给假信心。
 *     所以每一项都对比「报告里抽出来的事实」与「从代码里现取的事实」。
 *  3. **输出要能直接照着改**：每条失败给「报告说 X / 代码是 Y / 改哪个文件哪一行」。
 *
 * 退出码：0 = 一致；1 = 有阻断项；2 = 报告文件缺失。
 *
 * 用法：node tools/handoff-check.mjs [--json]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const HANDOFF = path.join(pluginDir, 'HANDOFF.md')
const JSON_OUT = process.argv.includes('--json')

const problems = []
const passes = []
const warns = []

/** 阻断项：报告与代码事实冲突。 */
const fail = (item, detail) => problems.push({ level: 'ERROR', item, detail })
/** 通过项：留痕，证明这项真的查了（不是静默跳过）。 */
const pass = (item, detail) => passes.push({ item, detail })
/** 警告项：可能是问题，但不阻断（如行数漂移）。 */
const warn = (item, detail) => warns.push({ level: 'WARN', item, detail })

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// ── 0. 报告存在吗 ────────────────────────────────────────────
if (!fs.existsSync(HANDOFF)) {
  console.error(`✖ 交接报告缺失：${HANDOFF}`)
  console.error('  规则：插件必须带 HANDOFF.md（见 SKILL.md「交接报告维护规则」）。')
  process.exit(2)
}
const handoff = readText(HANDOFF)

// ── 取代码侧事实 ────────────────────────────────────────────
const indexSrc = readText(path.join(pluginDir, 'index.js'))
const uiSrc = readText(path.join(pluginDir, 'ui-backend.js'))
const pkgRaw = readText(path.join(pluginDir, 'package.json'))
const patchSrc = readText(path.join(pluginDir, 'cordis.patch.yml'))
const clientSrc = readText(path.join(pluginDir, 'client.js'))

let pkg = {}
try {
  pkg = JSON.parse(pkgRaw)
} catch {
  fail('package.json', '无法解析 JSON，后续版本号比对跳过')
}

/** 从 index.js 的 `export const OPERATIONS = [ ... ]` 抽出 op 名。 */
function extractOperations(src) {
  const match = src.match(/export const OPERATIONS = \[([\s\S]*?)\n\]/)
  if (!match) return []
  return [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** 从 ui-backend.js 的 `UI_OPERATIONS = [ ... ]` 抽出面板 op 名。 */
function extractUiOperations(src) {
  const match = src.match(/export const UI_OPERATIONS = \[([\s\S]*?)\n\]/)
  if (!match) return []
  return [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])
}

/** 从 buildArgv 抽 `case 'op':` 分支名。 */
function extractBuildArgvCases(src) {
  const start = src.indexOf('export function buildArgv')
  if (start < 0) return []
  const body = src.slice(start, start + 20000)
  return [...body.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1])
}

/** 从 failure() 的 FAILURE_HINTS 抽短码。 */
function extractFailureHints(src) {
  const match = src.match(/const FAILURE_HINTS = \{([\s\S]*?)\n\}/)
  if (!match) return []
  return [...match[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1])
}

/** 从 LOCAL_OPERATIONS 抽本地 op 名。 */
function extractLocalOperations(src) {
  const match = src.match(/const LOCAL_OPERATIONS = new Set\(\[([^\]]*)\]\)/)
  if (!match) return []
  return [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** 从 cordis.patch.yml 抽 config 的键值（只认字面量，不执 `!!js` 表达式）。 */
function extractPatchConfig(src) {
  const out = {}
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s{8}([A-Za-z]\w*):\s*(.+?)\s*$/)
    if (m) {
      const raw = m[2].replace(/^['"]|['"]$/g, '')
      out[m[1]] = /^\d+$/.test(raw) ? Number(raw) : raw
    }
  }
  return out
}

/** 从 index.js 的 DEFAULTS 抽字面量。 */
function extractDefaults(src) {
  const match = src.match(/const DEFAULTS = \{([\s\S]*?)\n\}/)
  if (!match) return {}
  const out = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+):\s*(.+?),\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1)
    else if (v === 'DEFAULT_TIMEOUT_MS') {
      const d = src.match(/const DEFAULT_TIMEOUT_MS = (\d+)/)
      v = d ? Number(d[1]) : v
    } else if (/^\d[\d_ *+]*$/.test(v)) {
      // 处理 `2 * 1024 * 1024` 这类算术表达式
      try {
        v = Number(v.replace(/_/g, ''))
        if (!Number.isFinite(v)) v = Function(`"use strict";return (${m[2]})`)()
      } catch {
        /* 保持原样 */
      }
    }
    out[m[1]] = v
  }
  return out
}

const codeOps = extractOperations(indexSrc)
const uiOps = extractUiOperations(uiSrc)
const argvCases = extractBuildArgvCases(indexSrc)
const hints = extractFailureHints(indexSrc)
const localOps = extractLocalOperations(indexSrc)
const patchConfig = extractPatchConfig(patchSrc)
const defaults = extractDefaults(indexSrc)

// ── 1. 版本号三处一致 ──────────────────────────────────────
const codeVersion = pkg.version || ''
const handoffVersion = (handoff.match(/^\|\s*版本\s*\|\s*\*\*([\d.]+)\*\*/m) || [])[1] || ''
if (!handoffVersion) {
  fail('版本号', 'HANDOFF.md 里找不到「| 版本 | **x.y.z** |」这一行')
} else if (handoffVersion !== codeVersion) {
  fail(
    '版本号不一致',
    `报告写 ${handoffVersion}，package.json 是 ${codeVersion} —— 改版本号时同步 HANDOFF.md 第二行表格`,
  )
} else {
  pass('版本号', `${codeVersion}（报告与 package.json 一致）`)
}

// ── 2. OPERATIONS 数量与逐项存在 ───────────────────────────
if (!codeOps.length) {
  fail('OPERATIONS', 'index.js 里抽不出 OPERATIONS 数组（正则失效或结构变了）')
} else {
  // 报告里「operation 清单（41 个工具 op ...）」这类数字
  const claimed = (handoff.match(/operation 清单（(\d+)\s*个工具 op/) || [])[1]
  if (claimed === undefined) {
    warn('OPERATIONS', '报告里找不到 op 数量声明（「operation 清单（N 个工具 op」），无法比对数量')
  } else if (Number(claimed) !== codeOps.length) {
    fail(
      'OPERATIONS 数量',
      `报告写 ${claimed} 个，index.js 实际 ${codeOps.length} 个 —— 增删 op 后必须同步 HANDOFF.md 第五节与 SKILL.md`,
    )
  } else {
    pass('OPERATIONS 数量', `${codeOps.length} 个（报告一致）`)
  }

  // 报告第五节的速查列表必须覆盖全部 op（逐个 backtick 名比对）
  const missingInHandoff = codeOps.filter((op) => !handoff.includes(`\`${op}\``))
  if (missingInHandoff.length) {
    fail(
      'OPERATIONS 覆盖',
      `这些 op 在代码里有、HANDOFF.md 里没出现：${missingInHandoff.join(', ')}`,
    )
  } else {
    pass('OPERATIONS 覆盖', `${codeOps.length} 个 op 全部在报告里出现`)
  }

  // 报告里出现却没在代码里的 snake_case op（多半是删了 op 没改报告）
  const appearanceOps = [...handoff.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1])
  const knownNonOps = new Set([
    'article_missing_arg',
    'article_not_md',
    'article_not_found',
    'article_outside_dir',
    'article_delete_failed',
    'spawn_failed',
    'cli_not_found',
    'invalid_params',
    'unknown_operation',
    'cli_error',
    'credentials_missing',
    'wechat_40164',
    'wechat_48001',
    'wechat_40007',
    'article_invalid',
    'cover_required',
    'content_image_too_large',
    'title_too_long',
    'mount_state',
    'plugin_log',
    'call_log',
    'preset_import',
    'image_gen',
    'media_id',
    'publish_id',
    'article_id',
    'min_score',
    'base_url',
    'dryRun',
    'imageGen',
    'allowBuiltin',
    'logMaxBytes',
    'logLevel',
    'timeoutMs',
    'cliPath',
    'stateDir',
    'thumbMediaId',
    'publishId',
    'articleId',
    'mediaId',
    'minScore',
    'passScore',
    'as_default',
    'file_missing',
    'handoff_check',
  ])
  const ghostOps = [...new Set(appearanceOps)].filter(
    (op) => !codeOps.includes(op) && !knownNonOps.has(op) && !op.startsWith('article_preset'),
  )
  // 只报「像本插件的 op 但代码里没有」的：含下划线、不在白名单、也不是面板 op。
  // 再排除掉**宿主工具名**（guard_check_bundle / guard_audit 这类是 DSH 自带工具，不是本插件 op）。
  const hostToolPrefixes = ['guard_', 'cordis_', 'hindsight_', 'job_', 'team_', 'session_', 'weknora_']
  const realGhosts = ghostOps.filter(
    (op) => !uiOps.includes(op) && !hostToolPrefixes.some((p) => op.startsWith(p)),
  )
  if (realGhosts.length) {
    warn(
      '可能的幽灵 op',
      `报告里出现、代码 OPERATIONS 里没有（若确属错误码/文件名请忽略）：${realGhosts.join(', ')}`,
    )
  } else {
    pass('幽灵 op 检查', '报告里没有代码中不存在的 op 名')
  }
}

// ── 3. OPERATIONS ↔ buildArgv 分支一一对应 ─────────────────
if (codeOps.length && argvCases.length) {
  const missingCases = codeOps.filter((op) => !argvCases.includes(op))
  if (missingCases.length) {
    fail(
      'buildArgv 分支缺失',
      `OPERATIONS 有、buildArgv 没有 case 的 op：${missingCases.join(', ')}（模型调用只会得到 unknown_operation）`,
    )
  } else {
    pass('buildArgv 分支', `${codeOps.length} 个 op 全部有 case 分支`)
  }
}

// ── 4. LOCAL_OPERATIONS 必须在报告里写明 ───────────────────
if (localOps.length) {
  const notMentioned = localOps.filter((op) => !handoff.includes(op))
  if (notMentioned.length) {
    fail('本地 op', `LOCAL_OPERATIONS 里的 ${notMentioned.join(', ')} 没在 HANDOFF.md 出现`)
  } else {
    pass('本地 op', `${localOps.join(', ')}（报告已写明不经 CLI）`)
  }
} else {
  warn('本地 op', '抽不出 LOCAL_OPERATIONS（结构可能变了）')
}

// ── 5. 失败短码：代码里有的必须报告里提过 ──────────────────
if (hints.length) {
  const unreported = hints.filter((code) => !handoff.includes(code))
  if (unreported.length) {
    fail(
      'FAILURE_HINTS 短码',
      `代码里新增了短码但报告没提：${unreported.join(', ')} —— 改错误码必须同步第四节`,
    )
  } else {
    pass('FAILURE_HINTS 短码', `${hints.length} 个短码全部在报告中出现`)
  }
} else {
  fail('FAILURE_HINTS', '抽不出 FAILURE_HINTS —— 若被删除，第四节的错误形状契约已失效')
}

// ── 6. patch config ↔ DEFAULTS 逐字一致 ───────────────────
if (Object.keys(patchConfig).length && Object.keys(defaults).length) {
  const mismatch = []
  for (const key of Object.keys(defaults)) {
    if (!(key in patchConfig)) {
      mismatch.push(`${key}: patch 缺失`)
      continue
    }
    if (String(patchConfig[key]) !== String(defaults[key])) {
      mismatch.push(`${key}: patch=${patchConfig[key]} / DEFAULTS=${defaults[key]}`)
    }
  }
  if (mismatch.length) {
    fail('patch config ↔ DEFAULTS', `不一致项：${mismatch.join('；')}`)
  } else {
    pass('patch config ↔ DEFAULTS', `${Object.keys(defaults).length} 个键逐字一致`)
  }
} else {
  warn('patch config ↔ DEFAULTS', '一侧抽不出配置，跳过比对')
}

// ── 7. 报告声明的关键结构事实仍然成立 ──────────────────────
const structuralClaims = [
  {
    label: 'failure() 定义在 runCli 之前（O2 修复的结构前提）',
    ok: () => {
      const fIdx = indexSrc.indexOf('function failure(')
      const rIdx = indexSrc.indexOf('function runCli(')
      return fIdx > 0 && rIdx > 0 && fIdx < rIdx
    },
    detail: 'O2 修复要求 failure() 先于 runCli 定义，否则三条出口又会各写裸对象',
  },
  {
    label: 'promoteCliFailure 存在且被调用',
    ok: () => {
      const has = indexSrc.includes('function promoteCliFailure')
      const used = /promoteCliFailure\(\s*await\s+enqueue\(/.test(indexSrc)
      return has && used
    },
    detail: 'CLI 自己报的失败靠它把短码抬到顶层',
  },
  {
    label: 'failure() 只有一份定义',
    ok: () => (indexSrc.match(/function failure\(/g) || []).length === 1,
    detail: '出现两份说明有人复制粘贴过，两份会漂移',
  },
  {
    label: '模块级 inject 为空数组',
    ok: () => /export const inject = \[\]/.test(indexSrc),
    detail: '非空会让面板与工具互相拖死（0.1.0 的根因）',
  },
  {
    label: '路由同时注册 exact 与 prefix',
    ok: () => /kind:\s*'exact'/.test(indexSrc) && /kind:\s*'prefix'/.test(indexSrc),
    detail: '缺 prefix 会让 GET /api/wxmp/cover 403',
  },
  {
    label: 'panellist id 与 main key 字面相同',
    ok: () => {
      const id = (clientSrc.match(/const PANEL_ID = '([^']+)'/) || [])[1]
      if (!id) return false
      // main 槽位把 key 设成 PANEL_ID 或字面同名
      return clientSrc.includes("name: 'main'") && (clientSrc.includes('PANEL_ID') || clientSrc.includes(`'${id}'`))
    },
    detail: '不一致的后果：侧栏有条目、点进去永远空白',
  },
]
for (const claim of structuralClaims) {
  let ok = false
  try {
    ok = claim.ok()
  } catch {
    ok = false
  }
  if (ok) pass(claim.label, '成立')
  else fail(claim.label, `结构已变：${claim.detail}`)
}

// ── 8. 报告里引用的文件都真实存在 ──────────────────────────
const fileRefs = [
  'index.js',
  'ui-backend.js',
  'client.js',
  'logger.js',
  'cordis.patch.yml',
  'package.json',
  'skills/wxmp/SKILL.md',
  'CHANGELOG.md',
]
const missingFiles = fileRefs.filter((f) => !fs.existsSync(path.join(pluginDir, f)))
if (missingFiles.length) {
  fail('报告引用的文件', `不存在：${missingFiles.join(', ')}`)
} else {
  pass('报告引用的文件', `${fileRefs.length} 个文件全部存在`)
}

// ── 9. 报告不许超 400 行（自己定的规矩自己守） ─────────────
const handoffLines = handoff.split(/\r?\n/).length
if (handoffLines > 400) {
  warn('报告长度', `${handoffLines} 行 > 400 行上限：把细节挪进 docs/handoff-*.md 并在此留指路条`)
} else {
  pass('报告长度', `${handoffLines} 行（≤ 400）`)
}

// ── 10. SKILL.md 字符预算（顺带守住 8192） ─────────────────
const skillPath = path.join(pluginDir, 'skills', 'wxmp', 'SKILL.md')
if (fs.existsSync(skillPath)) {
  const skillChars = readText(skillPath).length
  const projected = skillChars + 220
  if (projected > 8192) {
    fail('SKILL.md 预算', `${skillChars} 字符 + 220 > 8192：超出会被宿主静默不加载`)
  } else {
    pass('SKILL.md 预算', `${skillChars} 字符（含余量 ${8192 - projected}）`)
  }
} else {
  warn('SKILL.md', '不存在，跳过预算检查')
}

// ── 11. 报告必须提到维护规则本身 ───────────────────────────
if (!/交接报告维护规则/.test(handoff)) {
  fail('维护规则', 'HANDOFF.md 里没有「交接报告维护规则」一节 —— 规则从报告里消失了，下一手就不知道要更新它')
} else {
  pass('维护规则', '第九节存在')
}

// ── 12. 不许出现无证据的结论口吻 ───────────────────────────
// 注意：规则条文本身会引用这些词（「不许写「应该没问题」」），
// 所以只统计出现在**负面清单之外**的用法：把含这些词的行排除在「禁止/不许/别/勿」语境之后。
const vaguePhrases = ['应该没问题', '基本可用', '应该是好的', '大概能用', '如有问题再找我']
const vagueHits = []
for (const line of handoff.split(/\r?\n/)) {
  const isRuleLine = /不许|禁止|别写|勿|不要写|换成|没有证据/.test(line)
  if (isRuleLine) continue
  for (const phrase of vaguePhrases) {
    if (line.includes(phrase)) vagueHits.push(`${phrase}（行：${line.trim().slice(0, 60)}）`)
  }
}
if (vagueHits.length) {
  fail('无证据结论', `报告里把「${vagueHits.join('；')}」当结论用了 —— 换成可验证的表述`)
} else {
  pass('无证据结论', '无当成结论使用的模糊表述')
}

// ── 输出 ──────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok: problems.length === 0,
        handoff: HANDOFF,
        version: codeVersion,
        counts: { pass: passes.length, warn: warns.length, error: problems.length },
        problems,
        warns,
        passes,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`交接报告校验：${path.relative(pluginDir, HANDOFF)}（插件 ${codeVersion}）`)
  console.log(`结果：${problems.length === 0 ? 'OK' : 'FAIL'} · PASS ${passes.length} / WARN ${warns.length} / ERROR ${problems.length}`)
  if (problems.length) {
    console.log('')
    for (const p of problems) {
      console.log(`  ✖ [${p.item}] ${p.detail}`)
    }
  }
  if (warns.length) {
    console.log('')
    for (const w of warns) {
      console.log(`  ⚠ [${w.item}] ${w.detail}`)
    }
  }
  if (process.argv.includes('--verbose')) {
    console.log('')
    for (const p of passes) console.log(`  ✔ [${p.item}] ${p.detail}`)
  }
}

process.exit(problems.length === 0 ? 0 : 1)
