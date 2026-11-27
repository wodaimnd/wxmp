/**
 * wxmp 发布驱动 — 绕过 multi-platform-releaser 工具的宿主序列化故障，
 * 直接驱动同一套 lib/publisher.mjs（工具与面板共用的实现）。
 *
 * 用法：
 *   node tools/publish-driver.mjs preflight          # 只读预检
 *   node tools/publish-driver.mjs preflight --diag   # 附带定位 lossless-JSON 违规字段
 *   node tools/publish-driver.mjs publish            # 预检通过后真发布（GitHub）
 */
import { pathToFileURL } from 'node:url'

const PUBLISHER_DIR = 'G:/AI PGRM/DSH/plugins/dsh-github-publisher'
const DATA_DIR = 'C:/Users/Shinelon/.dsh/github-publisher'
const PLUGIN_PATH = 'G:/AI PGRM/DSH/wxmp/dsh-plugin'

const RELEASE_NOTES = [
  '预览从「生成完就没了」变成钉在面板上：文件路径常驻，三枚按钮一步打开。',
  '',
  '- 新增：预览卡片常驻「文件路径」一行，显示文章 .md 的完整路径，点击即复制',
  '- 新增：「🌐 打开本地预览」生成 HTML 后自动在默认浏览器打开（preview 支持 --open 透传）',
  '- 新增：「📂 所在文件夹」资源管理器定位选中、「📄 打开文件」交给系统默认 .md 程序',
  '- 新增：面板后端本地 op open-article（what=file|folder），与「删除文章」同一条判定链：只 .md、realpath 拦目录穿越与软链，判定不过绝不碰 shell',
  '- 变更：预览主按钮升级为 primary 强调色，三枚按钮同行排列、窄栏自动换行',
  '- 修复：multi-platform-releaser 预检结果无法被宿主序列化（共享引用 + undefined 键），整个工具调用报 invalid output —— 即上一个 1.8.0 版本只能用驱动脚本发布的那个故障',
  '- 全量 324 个用例通过（新增 2 个：open 透传、open-article 判定链）',
  '',
  '完整变更见 CHANGELOG.md。',
].join('\n')

const FORM = {
  name: 'wxmp',
  platforms: ['github'],
  // auto = 已有 README 就保留（1.8.0 那次 regenerate 是首次生成卡片；
  // 现在 README 里有人读指引、目录树和手写徽章，不能再整文件覆盖）。
  readmeMode: 'auto',
  createRelease: true,
  releaseNotes: RELEASE_NOTES,
}

const { ConfigStore } = await import(pathToFileURL(`${PUBLISHER_DIR}/lib/store.mjs`))
const { Publisher } = await import(pathToFileURL(`${PUBLISHER_DIR}/lib/publisher.mjs`))

const store = new ConfigStore(DATA_DIR)
const publisher = new Publisher({ store, getWorkspacePaths: () => [] })

const mode = process.argv[2] || 'preflight'
const diag = process.argv.includes('--diag')

/** 找出宿主 lossless JSON 序列化不了的值（诊断工具崩溃用）。 */
function findBadPaths(value, path = '$', out = [], seen = new Set()) {
  if (value === null) return out
  const t = typeof value
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    out.push(`${path} (${t})`)
    return out
  }
  if (t === 'number' && !Number.isFinite(value)) {
    out.push(`${path} (${value})`)
    return out
  }
  if (t === 'object') {
    if (seen.has(value)) {
      out.push(`${path} (circular)`)
      return out
    }
    seen.add(value)
    if (value instanceof Date || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) {
      out.push(`${path} (${value.constructor && value.constructor.name})`)
      return out
    }
    for (const [k, v] of Object.entries(value)) findBadPaths(v, `${path}.${k}`, out, seen)
  }
  return out
}

const pre = await publisher.preflight({ path: PLUGIN_PATH, form: FORM })

if (diag) {
  const bad = findBadPaths(pre)
  console.log(
    bad.length
      ? `lossless-JSON 违规字段 ${bad.length} 个:\n  ${bad.join('\n  ')}`
      : '预检结果可被 lossless JSON 序列化（工具崩溃另有原因）',
  )
}

console.log(`canPublish=${pre.canPublish}`)
console.log(`blocking=${JSON.stringify(pre.blocking)}`)
for (const c of pre.checks || []) console.log(`[${c.status}] ${c.id}: ${c.detail || c.title || ''}`)
for (const w of pre.warnings || []) console.log(`[warn] ${typeof w === 'string' ? w : JSON.stringify(w)}`)

if (mode === 'publish') {
  if (!pre.canPublish) {
    console.error('预检未通过，放弃发布')
    process.exit(1)
  }
  const { jobId } = await publisher.publish({ path: PLUGIN_PATH, form: FORM })
  // publish() 返回 { jobId }，任务在 #runJob 里异步跑；用 getJob(jobId) 每轮取快照轮询到终态
  const deadline = Date.now() + 280000
  let job = publisher.getJob(jobId)
  while (!['succeeded', 'partial', 'failed', 'cancelled'].includes(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    job = publisher.getJob(jobId)
    if (!job) {
      console.error(`job ${jobId} 丢失`)
      process.exit(2)
    }
    const done = (job.steps || []).filter((s) => s.status && s.status !== 'pending')
    const last = done[done.length - 1]
    console.log(`status=${job.status} lastStep=${last ? last.id : '-'}`)
  }
  console.log(`final=${job.status}`)
  for (const s of job.steps || []) console.log(`  [${s.status}] ${s.id}${s.detail ? `: ${s.detail}` : ''}${s.error ? ` ERROR: ${s.error}` : ''}`)
  if (job.result) {
    console.log('result=' + JSON.stringify(job.result, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2))
  }
  process.exit(job.status === 'succeeded' ? 0 : 3)
}
