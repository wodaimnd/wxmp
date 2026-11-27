/**
 * 公众号素材库 —— 直接调用微信 `batchget_material` 列出后台素材。
 *
 * ## 关键发现（2026-11-08 实测）
 * `batchget_material` 返回的每条素材都带 `url` 字段，是**可直接在正文里用的 mmbiz 链接**：
 *   https://mmbiz.qpic.cn/mmbiz_png/.../0?wx_fmt=png
 *
 * 这条事实决定了整个实现方式：
 *   - **不需要下载再上传**：直接把 url 写进 Markdown 即可，微信不会过滤
 *     （`review.js` 的 `image_remote` 规则本来会拦外链，但对 mmbiz 域名是放行的）
 *   - 省掉一次往返、省掉 uploadimg 的 1 MB 限制、也不占正文图片配额
 *   - 素材本身已经在微信服务器上，加载更快
 *
 * ## 素材库的真实状况（实测你的号）
 * 41 张图里有 35 张叫 `粘贴图片_20240201231712` / `_c4e7623c-82dd-...` 这类无意义名字，
 * 只有 6 张有真实语义（工业AI、吉祥物红包、道歉信、封面）。
 *
 * 所以"按语义匹配"必须诚实：**文件名无意义时匹配不出来**。
 * 这里的做法是：
 *   1. 文件名能读出词 → 参与匹配
 *   2. 文件名读不出（粘贴图片/纯 UUID/cover）→ 标为 `untagged`，
 *      不参与语义匹配，但会**提示用户改名**（改名是唯一能低成本提升匹配率的办法）
 *   3. 支持 `tags` 字段（微信原生支持素材标签）作为第二来源
 */

import { WechatClient } from './wechat.js'
import { resolveCredentials } from './state.js'

/** 文件名里这些词说明是自动生成的，没有语义。 */
const MEANINGLESS_PATTERNS = [
  /^粘贴图片[_\d]*$/,
  /^[_-]?[0-9a-f]{8}(-[0-9a-f]{4}){2,}/i, // UUID 片段
  /^cover$/i,
  /^img[_\d]*$/i,
  /^image[_\d]*$/i,
  /^\d+$/,
  /^未命名/,
  // 相机/下载器自动命名：OIP-C、DSC001、IMG-20240101、Screenshot_...
  /^[a-z]{2,4}[-_]?\d+$/i,
  /^oip([-_]c)?$/i,
  /^dsc[_-]?\d+$/i,
  /^screenshot/i,
]

/** 判断一个素材名是否有语义（能参与内容匹配）。 */
export function isMeaningfulName(name) {
  const base = String(name || '')
    .replace(/\.[a-z0-9]+$/i, '') // 去扩展名
    .trim()
  if (!base) return false
  for (const pattern of MEANINGLESS_PATTERNS) {
    if (pattern.test(base)) return false
  }
  // 去掉「xxx-cover」这种自动后缀后如果还剩东西，就算有意义
  const stripped = base.replace(/-?cover$/i, '').trim()
  if (!stripped) return false
  // 纯符号/纯数字都不算
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(stripped)) return false
  // 短的无意义英文缩写（OIP-C、IMG-01、DSC001）也排除：
  // 它们看着像名字，实际对内容匹配毫无信息量。
  if (/^[a-z]{1,5}([-_]\d+)?$/i.test(stripped)) return false
  return true
}

/**
 * 从文件名里抽出可匹配的词。
 *
 * ## 为什么不用"按 2 字滑窗切中文"
 * 第一版对「吉祥物红包」切成「吉祥 / 物红」，全是碎片，匹配时反而干扰。
 * 中文分词需要词典，为一个选图功能引入分词器不值得。
 *
 * ## 现在的做法
 * 只在文件名里**命中已知领域词表**时才抽出来，其余一律不参与匹配。
 * 宁可少匹配（漏几张图），也不要拿着「物红」这种碎片去乱插图片。
 */
const DOMAIN_TERMS = [
  // 技术架构类
  '架构', '流程图', '流程', '时序', '拓扑', '模块', '分层', '调用链', '数据流',
  '界面', '截图', '终端', '命令行', '控制台', '报错', '日志', '代码',
  '性能', '对比', '基准', '压测', '监控', '指标', '图表', '曲线',
  // 内容主题类
  '工业', '教育', '医疗', '金融', '电商', '游戏', '机器人', '自动化',
  '红包', '吉祥物', '活动', '海报', '封面', '头图', '配图', '插图',
  // 常见英文
  'ai', 'api', 'sdk', 'gpu', 'cpu', 'llm', 'gpt', 'dsh', 'ui', 'ux',
]

export function extractKeywords(name) {
  const raw = String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/-?cover$/i, '')
  const lower = raw.toLowerCase()
  const found = []

  for (const term of DOMAIN_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      found.push(term)
    }
  }

  // 文件名里恰好是 2~4 个中文字且不在词表里（如「道歉信」），也收下：
  // 这种短名字本身就是有效语义。
  const pureChinese = raw.match(/^[\u4e00-\u9fa5]{2,4}$/)
  if (pureChinese && !found.includes(raw)) found.push(raw)

  return [...new Set(found)]
}

/**
 * 判断一张素材是否适合当**正文插图**。
 *
 * 素材库里大量图片是历史文章的封面（名字带 `-cover`、或就叫 `cover.png`）。
 * 这些图是 900×383 的横图，放进正文会显得奇怪，而且它们是封面的备份，
 * 不是文章内容的一部分。所以正文配图时应排除。
 *
 * 注意：这不影响它们被当作**封面**使用 —— 那是另一条路径。
 */
export function isCoverLike(name) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '')
  return /(?:^|[-_\s])cover$/i.test(base) || /^封面$/.test(base) || /封面$/.test(base) || /头图$/.test(base)
}

/**
 * 列出素材库里的图片。
 * @param {object} options
 * @param {number} options.count 每页条数（微信上限 20）
 * @param {number} options.max 最多取多少条（默认全取）
 * @param {boolean} options.onlyMeaningful 只要文件名有语义的
 * @returns {Promise<{items, total, untagged}>}
 */
export async function listLibraryImages(options = {}) {
  const cred = resolveCredentials()
  if (!cred.appid || !cred.secret) {
    throw new Error('没有公众号凭据：先跑 wxmp config set --appid <id> --secret <key>')
  }
  const client = options.client || new WechatClient({ appid: cred.appid, secret: cred.secret })
  const pageSize = Math.min(20, Math.max(1, Number(options.count) || 20))
  const max = Number(options.max) > 0 ? Number(options.max) : 500

  const all = []
  let offset = 0
  while (all.length < max) {
    const res = await client.request('/cgi-bin/material/batchget_material', {
      method: 'POST',
      body: { type: 'image', offset, count: pageSize },
    })
    if (res.errcode && res.errcode !== 0) {
      throw new Error(`微信错误 ${res.errcode}：${res.errmsg}`)
    }
    const items = res.item || []
    all.push(...items)
    const total = Number(res.total_count) || 0
    if (items.length === 0 || all.length >= total) break
    offset += items.length
  }

  const normalized = all.slice(0, max).map((item) => {
    const meaningful = isMeaningfulName(item.name)
    return {
      mediaId: item.media_id,
      name: item.name || '(无名)',
      url: item.url || '',
      updateTime: Number(item.update_time) || 0,
      tags: Array.isArray(item.tags) ? item.tags : [],
      meaningful,
      // 封面类：不适合作正文插图（它们是 900×383 横图，且是封面备份）
      coverLike: isCoverLike(item.name),
      // 关键词：文件名 + 标签，都参与内容匹配
      keywords: [...extractKeywords(item.name), ...(Array.isArray(item.tags) ? item.tags : [])],
    }
  })

  const untagged = normalized.filter((item) => !item.meaningful)
  const result = options.onlyMeaningful ? normalized.filter((item) => item.meaningful) : normalized

  return {
    items: result,
    total: normalized.length,
    untagged: untagged.length,
    // 改名提示：这是提升匹配率唯一低成本的办法
    hint: untagged.length
      ? `${untagged.length} 张素材的文件名没有语义（如"粘贴图片_2024…"），无法参与内容匹配。去公众号后台给它们改个能看出内容的文件名，匹配率会立刻提高。`
      : '',
  }
}
