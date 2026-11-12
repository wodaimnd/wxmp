/**
 * 公众号文章工作台 · 浏览器半（A 三栏布局 + C 流水线引导的折中）
 *
 * 契约：`window.__ModuleLoader__.load({ id, factory(require) })`。
 * 只 require 宿主已提供的 `react`；所有颜色走 `--dsw-alias-*` token；
 * 数据来自 Host 的 `/api/wxmp`（受控白名单，见 ui-backend.js）。
 *
 * 三条贯穿全局的实现约束：
 *   1. 一屏一个主任务区：左「选文章」→ 中「看预览」→ 右「发出去」，主按钮固定在右栏顶部。
 *   2. 状态持久化走 localStorage（宿主同款做法），记住折叠、主题、上次选中的文章。
 *   3. 所有异步操作都有：进行中反馈（按钮禁用 + 文案）、成功轻提示、失败三段式。
 */

window.__ModuleLoader__.load({
  id: '@local/wxmp',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const API = '/api/wxmp'
    const STORE_KEY = 'wxmp.ui.v1'
    // F10: version-single-source —— 这不是「显示的版本」，只是后端拿不到 health 时的离线兜底值。
    // 面板显示一律走 resolveVersion(health)：后端在线时取 health.version，于是
    // package.json / index.js / 面板三处一旦不一致，界面会当场显示后端那个值（不再是硬编码的活值）。
    const FALLBACK_VERSION = '1.8.1'
    /**
     * F10：版本号只有一个真相 —— 后端 health 载荷的 version 字段（ui-backend.js 的 health case
     * 从 createUiHandler 的 version 参数回传，index.js 传的是 package.json 里的真实值）。
     * 拿不到 health（后端没响应 / 首帧那次请求还没回来）才回落到 FALLBACK_VERSION，不会闪错值。
     */
    const resolveVersion = (health) => {
      const fromBackend = health && typeof health.version === 'string' ? health.version.trim() : ''
      return fromBackend || FALLBACK_VERSION
    }

    /** 写作辅助面板的统一容器样式。 */
    const makeLabPanelStyle = () => ({
      border: `1px solid ${C.border1}`,
      borderRadius: 10,
      background: C.l3,
      padding: 11,
      marginBottom: 12,
    })

    /** 封面**推荐**规格 —— 界面显示的说明，必须与后端实际行为一致。
     *  900×383 来自 tools/cover-layout.js 的 COVER_SIZE；
     *  这里写死是因为面板半不 import 业务模块（只走 loopback 协议）。
     *  有测试比对两边一致，防止改了后端忘了改文案。
     *
     *  2026-11-09 起这不再是"不可修改"的硬规格：面板可以强行改尺寸，
     *  真正的收敛（越界夹边界、比例偏离给警告）在后端 normalizeCoverSize 里做，
     *  这里只保留一份**用于界面提示**的轻量判断。 */
    const COVER_SPEC = {
      width: 900,
      height: 383,
      ratio: 900 / 383,
      limits: { minWidth: 320, minHeight: 140, maxWidth: 4096, maxHeight: 4096 },
      note: 'AI 出的图会等比裁剪铺满，不会拉伸变形',
    }

    /** `900×383 像素（2.35:1）`。与后端 formatCoverSize 同格式。 */
    function formatCoverSize(width, height) {
      const w = Number(width) || COVER_SPEC.width
      const h = Number(height) || COVER_SPEC.height
      return `${w}×${h} 像素（${(w / h).toFixed(2)}:1）`
    }

    /** 界面侧的轻量判断：只用来生成"接下来会发生什么"的提示，不做拦截。
     *  返回 { ready, width, height, clamped, outOfRange, ratioWarn }。
     *  ready=false 表示填的不是正整数 —— 此时不该让用户点「确定改」。 */
    function inspectCoverSize(width, height) {
      const w = Number(width)
      const h = Number(height)
      const ready = Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0
      if (!ready) {
        return { ready: false, width: 0, height: 0, clamped: false, outOfRange: false, ratioWarn: '' }
      }
      const { limits } = COVER_SPEC
      const outOfRange =
        w < limits.minWidth || w > limits.maxWidth || h < limits.minHeight || h > limits.maxHeight
      const cw = Math.round(Math.min(Math.max(w, limits.minWidth), limits.maxWidth))
      const ch = Math.round(Math.min(Math.max(h, limits.minHeight), limits.maxHeight))
      const ratio = cw / ch
      const drift = Math.abs(ratio - COVER_SPEC.ratio) / COVER_SPEC.ratio
      return {
        ready: true,
        width: cw,
        height: ch,
        clamped: cw !== Math.round(w) || ch !== Math.round(h),
        outOfRange,
        // 2% 以内不算偏离：900×384 这种手抖不该天天弹警告
        ratioWarn:
          drift > 0.02
            ? `比例 ${ratio.toFixed(2)}:1 不等于微信推荐的 ${COVER_SPEC.ratio.toFixed(2)}:1，公众号会按推荐比例再裁一次`
            : '',
      }
    }

    /** 面板上预览"最终会提交的提示词"。
     *  必须与 tools/cover-imagegen.js 的 buildCoverPrompt 逻辑保持一致，
     *  否则用户看到的与实际提交的不是一回事（比不给看更糟）。
     *  注意：2026-11-09 起**不再追加任何约束** —— 写了什么就提交什么。 */
    function previewPrompt(customPrompt, theme) {
      const mine = String(customPrompt || '').trim()
      if (mine) return mine
      const palette = {
        default: 'deep forest green fading into soft teal',
        dark: 'deep navy blue fading into slate blue',
        magazine: 'deep crimson fading into warm amber',
      }[theme] || 'deep forest green fading into soft teal'
      // 内置兜底模板：只描述想要的画面，不含任何"不要什么"
      return [
        `A wide panorama of pure abstract light and color, ${palette}.`,
        'Smooth flowing gradients, soft glowing blooms of light, a quiet grainy texture, modern minimal editorial mood.',
      ].join(' ')
    }

    /** 设置页里可选的图片供应商。`__custom` 表示自建中转站（要额外填 baseUrl）。 */
    const IMAGE_PROVIDER_CHOICES = [
      { id: 'gemini', label: 'Gemini / Nano Banana（Google）' },
      { id: 'openai', label: 'OpenAI（gpt-image）' },
      { id: 'doubao', label: '豆包（火山方舟）' },
      { id: 'dashscope', label: '通义万相（DashScope）' },
      { id: 'jimeng', label: '即梦（火山方舟）' },
      { id: 'minimax', label: 'MiniMax' },
      { id: 'azure_openai', label: 'Azure OpenAI' },
      { id: 'openrouter', label: 'OpenRouter' },
      { id: 'replicate', label: 'Replicate' },
      { id: 'modelscope', label: '魔搭 ModelScope（国内直连）' },
      { id: '__custom', label: '自定义中转站（OpenAI 兼容）' },
    ]

    /* ── 持久化 ──────────────────────────────────────────────── */
    let prefsCorrupted = false
    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        prefsCorrupted = true
        return {}
      }
    }
    function savePrefs(patch) {
      try {
        const next = { ...loadPrefs(), ...patch }
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
        return next
      } catch {
        return patch
      }
    }
    const DEFAULT_PREFS = {
      railCollapsed: false, // 右栏（操作区）收起状态
      stageOpen: true, // 流水线区展开状态
      theme: 'default',
      lastFile: '',
      reduceMotion: false,
      statsOpen: false, // 字数统计默认收起
      promptOpen: false, // AI 提示词面板默认收起（只在换风格时才用）
      presetOpen: false, // 打分预设默认折叠（不常改，但占满上半屏）
      leftWidth: 248, // 左栏宽度（可拖拽）
      railWidth: 286, // 右栏宽度（可拖拽）
      customPrompt: '', // 用户写的画面描述
      mobilePreview: false, // 预览区是否用手机宽屏模拟（窄版）
      // 封面输出尺寸。null = 用推荐值 900×383；{width,height} = 用户强改过的尺寸。
      // 存成 null 而不是存 900/383，是为了以后改推荐值时老用户能自动跟着变。
      coverSize: null,
      page: 0, // 文章列表分页
      // unsaved-input-lost-on-remount：切走再回来不丢未提交的输入
      importUrl: '',
      titleInput: '',
      briefTopic: '',
      briefForm: '',
    }
    const PAGE_SIZE = 8

    /* ── 请求 ────────────────────────────────────────────────── */
    // skeleton-no-exit-no-timeout：默认给每条请求加 15 秒超时，避免骨架屏永远卡在 null。
    const DEFAULT_TIMEOUT_MS = 15000
    async function api(op, params, signal) {
      /* W4-R1：原来只有「调用方没传 signal」才挂 15s 超时，凡是传了 signal 的调用
       * （首屏 health / article_list / preset-list / image-providers 等 effect 内调用）
       * 完全绕开超时 —— 后端半死不活时骨架屏能一直挂着，用户看到的是"永远加载中"。
       * 现在统一：本地 controller 一定挂超时，外部 signal 通过 abort 事件联动到它，
       * 两条路径都受同一份 15s 约束，语义也仍是「超时 = AbortError 抛出」。
       * 另外补上收尾：定时器与外部监听都必须在请求结束后清掉，否则长会话里越积越多。 */
      const controller = new AbortController()
      // timedOut 用来区分「我们自己的超时」与「调用方卸载时主动 abort」：
      // 两者都是 AbortError，但前者必须让用户看见，后者必须保持静默（否则切文章会满屏报错）。
      let timedOut = false
      const timer = window.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, DEFAULT_TIMEOUT_MS)
      const onExternalAbort = () => controller.abort()
      if (signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', onExternalAbort, { once: true })
      }
      const done = () => {
        window.clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onExternalAbort)
      }
      try {
        let response
        try {
          response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op, params: params || {} }),
            signal: controller.signal,
          })
        } catch (error) {
          if (error && error.name === 'AbortError') {
            // W4-R1：超时不能伪装成「调用方主动取消」而被各调用点静默吞掉。
            // 自家超时转成一个带 code/hint 的普通错误，走上三段式提示。
            if (timedOut) {
              const err = new Error(`请求超时：${DEFAULT_TIMEOUT_MS / 1000} 秒内本机后端没有响应`)
              err.code = 'timeout'
              err.hint = '后端可能正卡在别的任务上。稍等再点一次；持续超时就点「诊断」看后端状态。'
              throw err
            }
            throw error
          }
          // 网络层就没通：插件 UI 已经渲染出来了，但宿主后端没接上
          const err = new Error('连不上本机后端')
          err.code = 'backend_unreachable'
          err.hint = '界面已经加载，但后台服务没响应。常见原因是宿主刚启动、或插件需要重载。先点「重试」；仍然不行就点「诊断」把信息给开发者。'
          throw err
        }
        if (!response.ok) {
          const err = new Error(`后台返回 HTTP ${response.status}`)
          err.code = 'http_' + response.status
          err.hint =
            response.status === 404
              ? '界面已生效，但本机后端路由 /api/wxmp 没挂上。通常是插件刚启用或宿主刚升级：重启 DSH，或新开一个会话再试。点「诊断」可确认。'
              : '界面已生效，但后台拒绝了这次请求。稍后重试；持续失败点「诊断」。'
          throw err
        }
        const payload = await response.json()
        return payload
      } finally {
        done()
      }
    }

    /** 统一成 { ok, text, data, error:{code,message,hint} } —— UI 只认这一种形状。 */
    function toOutcome(payload) {
      if (!payload) {
        return { ok: false, text: '', data: null, error: { code: 'empty', message: '没有收到数据', hint: '重试一次。' } }
      }
      if (payload.ok) return { ok: true, text: payload.text || '', data: payload.data || {}, error: null }
      const raw = (payload.data && payload.data.error) || {}
      return {
        ok: false,
        text: payload.text || '',
        data: payload.data || {},
        error: {
          code: raw.code || 'unknown',
          message: raw.message || payload.text || '操作失败',
          hint: hintFor(raw.code),
        },
      }
    }

    /** 错误码 → 人话下一步。UI 直接消费，不在别处再判一遍。 */
    function hintFor(code) {
      const map = {
        credentials_missing: '去「设置」填 AppID 和 AppSecret，或让管理员帮你配好。',
        wechat_40125: 'AppSecret 不对。检查有没有多余空格，或去公众号后台重新复制一次。',
        wechat_40013: 'AppID 不对，确认和公众号后台显示的一致。',
        wechat_40164: '本机出口 IP 不在白名单 —— 你的公网 IP 变了（换网络/重拨/VPN 都会变）。去公众号后台「开发 → 基本配置 → IP 白名单」把新 IP 加进去，然后点「刷新草稿数量」。这一项只影响草稿箱/发布，不影响写稿体检。',
        wechat_48001: '这个公众号没有发布接口权限（个人未认证订阅号就是这种情况）。草稿已经建好了，去后台手动点发表。',
        wechat_40007: '封面素材无效：多半是这篇文章还没有封面，或封面素材已过期。先点「重新生成封面」，它会自动把封面写回文章，再点「建草稿」。',
        cover_required: '这篇文章没有封面，微信不给建草稿。点「重新生成封面」——生成后会自动写回文章的 cover 字段，然后就能建草稿了。',
        cover_upload_failed: '封面没能上传成永久素材：图片格式或大小不对（jpg/png、10 MB 以内），换成别的图再试。',
        asset_not_found: '封面或正文里引用的图片文件找不到。确认路径是相对文章目录的，或重新生成封面。',
        media_id_required: '这篇还没有草稿。先点「建草稿」拿到 media_id，再点「发表到公众号」。',
        theme_unknown: '主题名不认识。去「设置」里换回 default。',
        wechat_53503: '草稿没通过发布检查：大概率是缺封面、标题超 32 字或正文超 2 万字。点「重新校验」看具体哪项。',
        wechat_45166: '正文里有外链图片。用「建草稿」让工具自动上传替换，别直接贴网图地址。',
        content_image_too_large: '正文图片超过 1 MB。压缩到 1 MB 以内再试。',
        article_not_found: '文章文件找不到了，可能被移动或重命名。点「刷新列表」。',
        article_invalid: '文章不满足微信的限制，先看「发布前检查」里标红的那几项。',
        title_too_long: '标题超过 32 字：微信只收 32 字以内的标题，改短一点再建。',
        author_too_long: '作者名超过 16 字：微信的上限是 16 字，改短一点再建。',
        ref_expired: '页面状态过期了，重试一次即可。',
        timeout: '操作超时。可能是网络慢或公众号接口繁忙，稍等再点一次。',
        network: '连不上本机后端 /api/wxmp。先点「重试」；仍不行就点「诊断」复制信息发给开发者。',
      }
      return map[code] || '可以先重试；反复失败点右上角「诊断」复制错误码，发给开发者。'
    }

    /* ── 视觉 token ──────────────────────────────────────────── */
    const C = {
      label1: 'var(--dsw-alias-label-primary, #e8e8e8)',
      label2: 'var(--dsw-alias-label-secondary, #a0a0a0)',
      label3: 'var(--dsw-alias-label-tertiary, #6f6f6f)',
      base: 'var(--dsw-alias-bg-base, #17171a)',
      l1: 'var(--dsw-alias-bg-layer-1, #202024)',
      l2: 'var(--dsw-alias-bg-layer-2, #26262b)',
      l3: 'var(--dsw-alias-bg-layer-3, #1c1c20)',
      border1: 'var(--dsw-alias-border-l1, #333338)',
      border2: 'var(--dsw-alias-border-l2, #3d3d44)',
      brand: 'var(--dsw-alias-state-business-primary, #07c160)',
      overlay: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.55))',
    }
    // hardcoded-state-colors：改用宿主主题 token，三套皮肤下都有对色。
    const WARN = 'var(--dsw-alias-state-warn-primary, #e8a33d)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #e05c5c)'
    const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    const MONO = 'ui-monospace, Consolas, "Liberation Mono", monospace'

    /* ⚠ 定位容器陷阱（真实故障，1.7.1 修复）
     *
     * 这里曾经有一行 CSS：`.wxmp-shell { container-type: inline-size }`。
     * 它让 .wxmp-shell 成为**定位容器** —— 内部所有 position:fixed 元素
     * 不再相对视口定位，而是相对这个容器；再叠加 pageStyle 的 overflow:hidden，
     * 浮窗被裁在面板区域内。
     *
     * 用户看到的现象是「点打分预设没反应」——其实它渲染了，只是看不见。
     *
     * 那个 container-type 是白设的：代码里没有任何 @container 查询依赖它，
     * 宽度判断走 ResizeObserver。所以直接删掉，不留替代方案。
     *
     * 回归防线在 test/ui.test.js 的「定位容器回归」用例里：
     * 任何人往 .wxmp-shell 加 container-type/transform/filter 都会让测试红。
     */
    const CSS = `
/* P13：焦点环不再自拼颜色，改用宿主焦点环 token（宿主换皮肤/调宽度时自动跟随）。
   宿主没给这两个 token 时才回落到品牌色，保证旧宿主上焦点环依然可见。 */
.wxmp-focus:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, color-mix(in srgb, ${C.brand} 78%, transparent)); outline-offset: 2px; }
/* T9-4 scrollbar-always-visible：用户原话「滚动条没有」。
   两个叠加原因：① scrollbar-width: thin 会让 Chromium 切到 overlay 滚动条 ——
   不占位、鼠标不悬停就完全看不见；② thumb 只有 label3 34% 的对比度，深色主题里几乎融进底色。
   现在：去掉 scrollbar-width（保持经典占位滚动条）+ scrollbar-gutter: stable（内容不因滚动条出现而横跳）
   + track 给一层可见底色 + thumb 55% / hover 78%。颜色全走 token 与 color-mix，不写死色值。 */
.wxmp-scroll { scrollbar-color: color-mix(in srgb, ${C.label3} 55%, transparent) color-mix(in srgb, ${C.label3} 9%, transparent); scrollbar-gutter: stable; }
.wxmp-scroll::-webkit-scrollbar { width: 12px; height: 12px; }
.wxmp-scroll::-webkit-scrollbar-track { background: color-mix(in srgb, ${C.label3} 9%, transparent); border-radius: 99px; }
.wxmp-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, ${C.label3} 55%, transparent);
  border-radius: 99px; border: 3px solid transparent; background-clip: padding-box;
}
.wxmp-scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, ${C.label3} 78%, transparent); }
.wxmp-scroll::-webkit-scrollbar-thumb:active { background: color-mix(in srgb, ${C.label3} 88%, transparent); }
.wxmp-scroll::-webkit-scrollbar-corner { background: transparent; }
.wxmp-card { transition: background-color 140ms ease, border-color 140ms ease; }
.wxmp-card:hover { background: ${C.l2} !important; border-color: ${C.border2} !important; }
.wxmp-btn { transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease, opacity 140ms ease, filter 120ms ease, transform 90ms ease; }
/* 悬停：整块提亮，而不是只换边框。
   深色主题下 border-l1 → border-l2 的差别几乎看不见，用户反馈"不知道这个能不能点"。
   注意 filter/transform 只能加在 .wxmp-btn 上，绝不能加到 .wxmp-shell —— 那会让它变成
   定位容器，把 position:fixed 的浮窗裁进面板（见上面「定位容器陷阱」，1.7.1 的真实故障）。 */
.wxmp-btn:hover:not(:disabled) { border-color: ${C.border2} !important; color: ${C.label1} !important; filter: brightness(1.16); }
/* 按下：轻微下沉 + 压暗。点击 100ms 内必须有视觉响应，否则用户会怀疑没点到而重复点。 */
.wxmp-btn:active:not(:disabled) { filter: brightness(0.9); transform: translateY(1px); }
.wxmp-btn:disabled { opacity: 0.5; cursor: not-allowed; border-color: ${C.border1} !important; }
.wxmp-anim { transition: opacity 160ms ease, transform 160ms ease; }
@media (prefers-reduced-motion: reduce) {
.wxmp-anim { transition: none !important; }
.wxmp-btn { transition: none !important; }
.wxmp-btn:active:not(:disabled) { transform: none !important; }
}
.wxmp-skel {
  background: linear-gradient(90deg, ${C.l2} 25%, ${C.l3} 37%, ${C.l2} 63%);
  background-size: 400% 100%;
  animation: wxmp-shimmer 1.4s ease infinite;
}
@keyframes wxmp-shimmer { 0% { background-position: 100% 50% } 100% { background-position: 0 50% } }
/* 系统级「减少动态效果」：和下面的手动开关覆盖同一批元素，两条路都真的生效 */
@media (prefers-reduced-motion: reduce) {
  .wxmp-skel { animation: none !important; }
  .wxmp-anim, .wxmp-btn, .wxmp-card { transition: none !important; }
  .wxmp-btn:active:not(:disabled) { transform: none !important; }
  .wxmp-scroll { scroll-behavior: auto !important; }
}
/* P15 reduceMotion-dead-config：reduceMotion 以前只写在 DEFAULT_PREFS 里、全库无人读 —— 死配置。
   现在两路都生效：上面那段 @media（跟随系统）+ 用户在设置页打开的开关。
   开关由根容器挂 .wxmp-reduce-motion，与 @media 覆盖同一批元素（含按钮按下位移）。 */
.wxmp-reduce-motion .wxmp-anim,
.wxmp-reduce-motion .wxmp-btn,
.wxmp-reduce-motion .wxmp-card { transition: none !important; }
.wxmp-reduce-motion .wxmp-btn:active:not(:disabled) { transform: none !important; }
.wxmp-reduce-motion .wxmp-skel { animation: none !important; }
.wxmp-reduce-motion .wxmp-scroll { scroll-behavior: auto !important; }

/* 三布局（宽 / 窄 / 小窗口）的宽度判断由 ResizeObserver 完成（见 narrow 状态），
   不用容器查询也不用媒体查询 —— 面板可能只占宿主右侧一小块，媒体查询会判断错误。 */
`

    /* ── 小工具 ──────────────────────────────────────────────── */
    /**
     * 按钮样式。
     *
     * ## 为什么要重设计
     * 用户反馈"按钮和背景没区分度"。原来 ghost 透明底、normal 背景太暗（l2 和 base 差几乎看不出）、primary 几乎透明，
     * 都在深色主题里"隐身"了。
     *
     * 现在靠**背景色 + 边框 + 文字颜色**三维度区分优先级，确保每个按钮都"跳"出来：
     *   accent  —— 实色填充 + 白字，最高对比。只给主操作（发表、建草稿、生成封面、导入）。一屏最多 1 个。
     *   primary —— 品牌色半透明底 + 白字 + 品牌色描边，次主操作（面板内确认动作）。
     *   normal  —— 亮灰底 + 主文字 + 边框，普通操作（刷新、确认、切换）。
     *   ghost   —— 透明底 + 次文字 + 边框，辅助操作（收起、诊断、重置）。靠边框和 hover 显示存在感。
     *   danger  —— 警告色半透明底 + 白字，破坏性操作（删除、重置）。
     */
    const btn = (variant = 'normal') => {
      const map = {
        normal: {
          // 背景比页面 base 明显亮，才能和深色主题背景区分开
          background: `color-mix(in srgb, #ffffff 10%, transparent)`,
          color: C.label1,
          border: `1px solid ${C.border2}`,
          fontWeight: 500,
        },
        // accent：实色 + 白字。品牌色压深后做底，保证白字对比度 ≥ 7:1（WCAG AAA）
        accent: {
          background: `color-mix(in srgb, ${C.brand} 58%, #000)`,
          color: '#ffffff',
          border: `1px solid ${C.brand}`,
          fontWeight: 600,
          boxShadow: `0 1px 3px color-mix(in srgb, ${C.brand} 30%, transparent)`,
        },
        primary: {
          // 品牌色半透明底，比 base 亮且有色，白字对比度高
          background: `color-mix(in srgb, ${C.brand} 22%, #000)`,
          color: '#ffffff',
          border: `1px solid color-mix(in srgb, ${C.brand} 70%, transparent)`,
          fontWeight: 600,
        },
        danger: {
          background: `color-mix(in srgb, ${DANGER} 14%, #000)`,
          color: '#ffffff',
          border: `1px solid color-mix(in srgb, ${DANGER} 50%, transparent)`,
          fontWeight: 600,
        },
        ghost: {
          background: 'transparent',
          color: C.label2,
          border: `1px solid ${C.border1}`,
        },
      }
      return {
        appearance: 'none',
        borderRadius: 9,
        padding: '7px 12px',
        font: `inherit`,
        fontFamily: FONT,
        fontSize: 12.5,
        lineHeight: 1.5,
        cursor: 'pointer',
        /* 可点性硬线（用户反馈"按钮不方便点"）：
         *   1. 所有按钮至少 30px 高 —— 即使某个调用点覆盖了 padding，也不会缩成一条细线；
         *   2. inline-flex + 居中：emoji 图标和文字不会各偏一边；
         *   3. nowrap：窄栏里文字不折行，按钮高度不会突然变成两行。 */
        minHeight: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        ...map[variant],
      }
    }

    function Badge({ tone, children }) {
      const tones = {
        ok: { color: C.brand, bg: `color-mix(in srgb, ${C.brand} 12%, transparent)`, bd: `color-mix(in srgb, ${C.brand} 32%, transparent)` },
        draft: { color: C.brand, bg: `color-mix(in srgb, ${C.brand} 12%, transparent)`, bd: `color-mix(in srgb, ${C.brand} 34%, transparent)` },
        warn: { color: WARN, bg: `color-mix(in srgb, ${WARN} 12%, transparent)`, bd: `color-mix(in srgb, ${WARN} 34%, transparent)` },
        idle: { color: C.label3, bg: C.l3, bd: C.border1 },
        err: { color: DANGER, bg: `color-mix(in srgb, ${DANGER} 12%, transparent)`, bd: `color-mix(in srgb, ${DANGER} 34%, transparent)` },
      }
      const t = tones[tone] || tones.idle
      return h(
        'span',
        {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '1px 7px', borderRadius: 99, fontSize: 10.5, fontWeight: 600,
            color: t.color, background: t.bg, border: `1px solid ${t.bd}`, whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }

    function Skeleton({ height = 14, width = '100%', radius = 6 }) {
      return h('div', { className: 'wxmp-skel', style: { height, width, borderRadius: radius, marginBottom: 8 } })
    }

    function SectionTitle({ children, extra }) {
      return h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px',
            fontSize: 11.5, fontWeight: 600, color: C.label2, letterSpacing: 0.5, textTransform: 'uppercase',
          },
        },
        h('span', null, children),
        extra ? h('span', { style: { marginLeft: 'auto', fontWeight: 500, color: C.label3, textTransform: 'none', letterSpacing: 0 } }, extra) : null,
      )
    }

    /** 三段式错误：发生了什么 + 可能原因 + 下一步。 */
    function ErrorBox({ error, onRetry, onDiagnose }) {
      if (!error) return null
      return h(
        'div',
        {
          role: 'alert',
          style: {
            border: `1px solid color-mix(in srgb, ${DANGER} 40%, transparent)`,
            background: `color-mix(in srgb, ${DANGER} 8%, transparent)`,
            borderRadius: 9, padding: '10px 12px', marginBottom: 12, fontSize: 12, lineHeight: 1.65,
          },
        },
        h('div', { style: { color: DANGER, fontWeight: 600, marginBottom: 3 } }, '出错了：', error.message),
        h('div', { style: { color: C.label2 } }, '可能原因：', error.hint),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
          onRetry ? h('button', { type: 'button', className: 'wxmp-btn wxmp-focus', style: btn('normal'), onClick: onRetry }, '重试') : null,
          // onDiagnose 这个 prop 一直存在但从来没人传过（写了没接线）—— 现在接到诊断浮窗上：
          // 出错时用户最需要的就是"把现场信息捞出来"，而不是自己回想刚才点了什么。
          onDiagnose ? h('button', { type: 'button', className: 'wxmp-btn wxmp-focus', 'aria-label': '打开诊断信息浮窗', style: btn('normal'), onClick: onDiagnose }, '🩺 查看诊断信息') : null,
          h('code', { style: { marginLeft: 'auto', fontSize: 11, color: C.label3, fontFamily: MONO } }, error.code),
        ),
      )
    }

    function Toast({ toast }) {
      if (!toast) return null
      const tone = toast.tone === 'err' ? DANGER : toast.tone === 'warn' ? WARN : C.brand
      return h(
        'div',
        {
          role: 'status',
          'aria-live': 'polite',
          className: 'wxmp-anim',
          style: {
            position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)',
            zIndex: 9999, padding: '9px 16px', borderRadius: 10,
            border: `1px solid color-mix(in srgb, ${tone} 46%, transparent)`,
            background: `color-mix(in srgb, ${C.l1} 96%, transparent)`,
            color: tone, fontSize: 12.5, fontWeight: 500,
            boxShadow: '0 8px 28px rgba(0,0,0,.28)', maxWidth: 520,
          },
        },
        toast.text,
      )
    }

    /* ── 主面板 ──────────────────────────────────────────────── */
    function Workbench(props) {
      // 全屏浮层删掉后，Workbench 只剩一个承载点（main 槽位），
      // 原来的 embedded 分支变成死代码（声明了从没有人读）—— 一并清掉。
      const prefs = useMemo(() => ({ ...DEFAULT_PREFS, ...loadPrefs() }), [])
      const [articles, setArticles] = useState(null) // null = 加载中
      const [listErr, setListErr] = useState(null)
      const [selected, setSelected] = useState(prefs.lastFile || '')
      const [detail, setDetail] = useState(null) // { data, text }
      const [detailBusy, setDetailBusy] = useState(false)
      const [detailErr, setDetailErr] = useState(null)
      const [draftCount, setDraftCount] = useState(null)
      const [busy, setBusy] = useState('') // 当前进行中的动作名
      // publishing 与 busy 分开：busy 在 submit 返回后立即释放，
      // publishing 覆盖整个“提交→轮询→终态”全过程，避免 60 秒窗口内重复点击。
      const [publishing, setPublishing] = useState(false)
      const [toast, setToast] = useState(null)
      const [railCollapsed, setRailCollapsed] = useState(prefs.railCollapsed)
      const [stageOpen, setStageOpen] = useState(prefs.stageOpen)
      const [showSettings, setShowSettings] = useState(false)
      const [page, setPage] = useState(prefs.page || 0)
      const [backendOk, setBackendOk] = useState(true)
      const [backendInfo, setBackendInfo] = useState(null) // health 返回：route / pid / cliPath / ops
      const [runtime, setRuntime] = useState({ health: null, logs: [], logFile: '' })
      const [runtimeBusy, setRuntimeBusy] = useState(false)
      const [runtimeNote, setRuntimeNote] = useState('')
      // F10：面板显示用的版本，三处显示点共用这一个值，不再各自引用本地常量。
      // 来源优先级：挂载/重新检查写入的 runtime.health > 首帧 health 落下的 backendInfo > 离线兜底常量。
      const displayVersion = resolveVersion((runtime && runtime.health) || backendInfo)
      /**
       * T9-1：删文章的能力探测。`article-delete` 是本轮宿主半新增的 op，老版本宿主没有它 ——
       * 那种情况下按钮**不出现**，而不是点一下报「未知操作」（这条依 lead 的明确要求：
       * 老宿主隐藏入口而不是报错）。拿不到 ops 数组时同样按「不支持」处理：
       * 文章列表与 health 是同一次挂载里并发拉的，health 稍晚到达时按钮会后出现一下，
       * 代价只是图标晚半拍；反过来（未知就显示）会在老宿主上给出一个必然失败的删除按钮。
       */
      const hostOps = (runtime && runtime.health && Array.isArray(runtime.health.ops))
        ? runtime.health.ops
        : (backendInfo && Array.isArray(backendInfo.ops) ? backendInfo.ops : null)
      const canDeleteArticle = Array.isArray(hostOps) && hostOps.indexOf('article-delete') !== -1
      // ── 诊断浮窗 ──
      // 旧实现：点「诊断」只是 setDiagText(一段 JSON) + 写剪贴板，而 diagText 唯一的展示点
      // 藏在设置页最底部的 <pre> 里 —— 于是用户看到的是"点了没反应"。
      // 现在：点一下立刻弹出浮窗，内容是给人读的键值行 + 日志尾巴，面板里带「复制全部」。
      const [diagOpen, setDiagOpen] = useState(false)
      const [diag, setDiag] = useState(null) // { at, ok, rows, payload, backendLogs, opsLog }
      const [diagBusy, setDiagBusy] = useState(false)
      const [diagCopied, setDiagCopied] = useState(false)
      const [flow, setFlow] = useState({ step: 0, log: [] })
      // 48001（这个号没有发布 API 权限）不是「错误」，是「改用人工这一步」：
      // 用一条常驻说明替代一次性 toast，不然用户点完就再也找不到那句话。
      const [manualPublish, setManualPublish] = useState(false)
      // ── 体检预设（打分标准）──
      const [presets, setPresets] = useState([])
      const [currentPreset, setCurrentPreset] = useState('')
      const [presetsBusy, setPresetsBusy] = useState(false)
      // 1.8.0：剪贴板不可用时的兜底——把写作提示词全文显示在浮窗里让用户手动复制
      const [promptPreview, setPromptPreview] = useState(null)
      const [reviewReport, setReviewReport] = useState(null)
      const [reviewBusy, setReviewBusy] = useState(false)
      const [reviewErr, setReviewErr] = useState(null)
      // 封面图版本号：封面文件变了必须换 query 才会重新拉图（否则吃缓存）
      const [coverV, setCoverV] = useState(Date.now())
      /* 详情版本号：写回标题/作者之后必须让详情 effect 重跑。
       * 原来那个 effect 只依赖 [selected]，所以改完标题面板里还是旧标题 ——
       * 用户会以为没生效（"操作了不给反馈"的另一种形态）。 */
      const [detailV, setDetailV] = useState(0)
      // 草稿数失败要有独立状态：null 只表示"还没读到"，失败是另一回事
      const [draftErr, setDraftErr] = useState(null)
      // AI 配图能力：进面板先探测一次，避免用户点了才发现没配 key
      const [imageGen, setImageGen] = useState({ available: false, busy: false, providers: [], note: '' })
      // 字数与体积默认折叠：它们不常看，却占了右栏三分之一高度
      const [statsOpen, setStatsOpen] = useState(Boolean(prefs.statsOpen))
      // AI 配图提示词：展开状态与用户写的内容都持久化，切走再回来不丢
      const [promptOpen, setPromptOpen] = useState(Boolean(prefs.promptOpen))
      const [customPrompt, setCustomPrompt] = useState(prefs.customPrompt || '')
      const [mobilePreview, setMobilePreview] = useState(Boolean(prefs.mobilePreview))
      // P15 reduceMotion-dead-config：以前只有 DEFAULT_PREFS.reduceMotion 这一行，
      // 没有任何组件读它 —— 用户在设置里打开也没用。这里给它一个状态镜像（改完立刻生效，
      // 不用刷新），根容器据此挂 .wxmp-reduce-motion，CSS 里统一掐动效。
      const [reduceMotion, setReduceMotion] = useState(Boolean(prefs.reduceMotion))
      const toggleReduceMotion = () => setReduceMotion((prev) => {
        const next = !prev
        savePrefs({ reduceMotion: next })
        return next
      })
      /* 封面输出尺寸：默认走推荐值，用户可以在规格区强改。
       *   coverSize        已生效的尺寸（null = 推荐值）
       *   coverEditing     是否正在编辑
       *   coverDraftW/H    编辑框里的草稿（与应用分离，取消不脏数据）
       *   coverConfirm     是否停在内联二次确认条上（改规格是会影响成品的操作，要拦一下） */
      const [coverSize, setCoverSize] = useState(prefs.coverSize || null)
      const [coverEditing, setCoverEditing] = useState(false)
      const [coverDraftW, setCoverDraftW] = useState('')
      const [coverDraftH, setCoverDraftH] = useState('')
      const [coverConfirm, setCoverConfirm] = useState(false)
      // 当前生效的尺寸（null 走推荐值）与编辑框的实时判断。
      // 只是界面提示，真正的收敛（夹边界/比例告警）在后端 normalizeCoverSize。
      const coverActive = coverSize || { width: COVER_SPEC.width, height: COVER_SPEC.height }
      const coverDraftInfo = inspectCoverSize(coverDraftW, coverDraftH)
      // 从链接导入：展开状态、输入内容、进行中、上次结果
      const [importOpen, setImportOpen] = useState(false)
      const [importUrl, setImportUrl] = useState(prefs.importUrl || '')
      const [importBusy, setImportBusy] = useState(false)
      const [importResult, setImportResult] = useState(null)
      // 写作辅助：标题 / 骨架 / 任务书。三个面板互斥展开，一次只做一件事。
      const [labOpen, setLabOpen] = useState('') // '' | 'titles' | 'outline' | 'brief' | 'images'
      const [labBusy, setLabBusy] = useState('')
      const [labResult, setLabResult] = useState({ titles: null, outline: null, brief: null, images: null })
      /* 列宽可拖拽（用户要"像 Excel 一样随意调"）。
       * 默认值与旧布局一致（248/286），所以默认长相不变。
       * 上下限：左栏 160~520（窄了看不见标题，宽了把预览挤没），
       *         右栏 220~560。存 localStorage，下次打开保持。 */
      const [leftWidth, setLeftWidth] = useState(Number(prefs.leftWidth) || 248)
      // 打分预设默认折叠：它不常改，却占了右栏上半屏
      const [presetOpen, setPresetOpen] = useState(prefs.presetOpen === true)
      /**
       * T9-2：全插件唯一的「破坏性操作确认」状态。
       * null = 没有待确认的操作；非 null 时渲染那个共用的 ConfirmModal。
       * 形状：{ title, body[], confirmLabel, busyLabel, danger, onConfirm }
       * 五个触发点（删文章 / 清凭据 / 清插件数据 / 清图片 key / 删预设）全都走 requestConfirm，
       * 谁都不许绕过它直接执行，也不许另弹一个自己的确认框。
       */
      const [confirmState, setConfirmState] = useState(null)
      const [railWidth, setRailWidth] = useState(Number(prefs.railWidth) || 286)
      const saveColumnWidths = useCallback((patch) => {
        try {
          savePrefs(patch)
        } catch {
          /* 存不了只影响记忆 */
        }
      }, [])
      // W8 残留：这两个输入框以前是 useState('')，onChange 里写进 prefs 却没人在初始化时读回来 ——
      // 切走（换文章/关设置/重挂载）再回来，用户刚敲的标题就没了。
      // 照 importUrl 的同型修法：初始化从 prefs 取回，写入点保持 savePrefs 不变。
      const [titleInput, setTitleInput] = useState(prefs.titleInput || '')
      /* 作者名可改。为什么值得一个入口：`article new --author` 只在建文章时能传一次，
       * 建完之后 front matter 里的 author 再没有别的地方能改 —— 而封面副标题、
       * 预览页 byline、面板作者行三处都直接读它。以前用户看到封面上顶着个旧名字，
       * 唯一的办法是拿编辑器去改 .md。 */
      const [authorEditing, setAuthorEditing] = useState(false)
      const [authorInput, setAuthorInput] = useState('')
      // W8 残留：写作任务书的主题与文体同样只在 onChange 里 savePrefs，从没读回 —— 一并恢复
      const [briefTopic, setBriefTopic] = useState(prefs.briefTopic || '')
      const [briefForm, setBriefForm] = useState(prefs.briefForm || '')
      const bgInputRef = useRef(null)
      const importInputRef = useRef(null)
      const toastTimer = useRef(0)
      const aliveRef = useRef(true)
      const styleRef = useRef(null)

      useEffect(() => () => {
        aliveRef.current = false
        clearTimeout(toastTimer.current)
      }, [])

      const notify = useCallback((text, tone = 'ok', holdMs = 3200) => {
        setToast({ text, tone })
        clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(() => setToast(null), holdMs)
      }, [])

      // prefs-read-corruption-silent：偏好读损坏时静默回落，改为一次性提示
      useEffect(() => {
        if (prefsCorrupted) {
          notify('界面偏好读不出来（已回落到默认）', 'warn', 5000)
        }
      }, [notify])

      const pushLog = useCallback((line) => {
        setFlow((prev) => ({ ...prev, log: [...prev.log.slice(-60), line] }))
      }, [])

      const refreshList = useCallback(async (signal) => {
        setListErr(null)
        let outcome
        try {
          outcome = toOutcome(await api('article_list', {}, signal))
        } catch (error) {
          // AbortError 是 effect 清理时主动 abort（比如切换 selected 重新加载），
          // 不是真正的网络失败。但必须也把 articles 置空，否则会卡在 null，
          // 骨架屏「正在读取文章…」永远不消失 → 用户感知为「白屏/没反应」。
          setArticles([])
          if (error && error.name === 'AbortError') return
          setBackendOk(false)
          setListErr({ code: error.code || 'backend', message: error.message, hint: error.hint || hintFor('') })
          return
        }
        setBackendOk(true)
        if (!aliveRef.current) return
        if (!outcome.ok) {
          setListErr(outcome.error)
          setArticles([])
          return
        }
        const items = (outcome.data && outcome.data.articles) || []
        setArticles(items)
        // 页码越界保护：新建/删除文章后，原 page 可能指向空页（如 5 篇文章时 page=1），
        // slice 返回空数组导致列表看起来「回到了第一篇」或空白。强制回到第 1 页。
        const maxPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1)
        if (page > maxPage) setPage(0)
        if (!selected && items.length) setSelected(items[0].path)
      }, [selected])

      useEffect(() => {
        const controller = new AbortController()
        // 初始化异步化：先画骨架，网络请求放微任务，不阻塞宿主输入框
        const kickoff = window.setTimeout(() => {
          // 先探一次后端：面板能渲染但路由没挂上，是这个插件最常见的故障，
          // 必须当场说清「缺什么、还能用哪部分」，而不是等到用户点报错。
          void api('health', {}, controller.signal)
            .then((payload) => {
              const outcome = toOutcome(payload)
              if (!aliveRef.current) return
              setBackendOk(outcome.ok)
              setBackendInfo(outcome.ok ? outcome.data : null)
              if (!outcome.ok) {
                setListErr({ code: 'backend_unreachable', message: '本机后端没有响应', hint: hintFor('backend_unreachable') })
              }
            })
            .catch(() => {
              if (!aliveRef.current) return
              setBackendOk(false)
              setBackendInfo(null)
              setListErr({ code: 'backend_unreachable', message: '连不上本机后端 /api/wxmp', hint: hintFor('backend_unreachable') })
            })
          void refreshList(controller.signal).catch((error) => {
            if (aliveRef.current) setListErr({ code: 'list_failed', message: error.message, hint: hintFor('') })
          })
          void api('state').then((payload) => {
            const outcome = toOutcome(payload)
            if (!aliveRef.current) return
            if (outcome.ok) {
              setDraftCount(outcome.data.total ?? 0)
              setDraftErr(null)
            } else {
              // 失败必须落到界面上。原来只在成功时写 draftCount，
              // 一失败就永远停在 null → 徽章永远显示「草稿读取中」，
              // 而真实原因（典型是 40164 IP 不在白名单）完全不可见。
              setDraftErr(outcome.error)
              setDraftCount(0)
            }
          }).catch((error) => {
            if (!aliveRef.current) return
            setDraftErr({ code: 'network', message: error.message, hint: hintFor('') })
            setDraftCount(0)
          })
        }, 0)
        return () => {
          controller.abort()
          clearTimeout(kickoff)
        }
      }, [refreshList])

      // 选中文章后拉详情（含校验）
      useEffect(() => {
        if (!selected) {
          setDetail(null)
          return
        }
        const controller = new AbortController()
        setDetailBusy(true)
        setDetailErr(null)
        void (async () => {
          try {
            const [show, check] = await Promise.all([
              api('read-article', { file: selected }, controller.signal),
              api('check-article', { file: selected }, controller.signal),
            ])
            if (!aliveRef.current) return
            const showOutcome = toOutcome(show)
            const checkOutcome = toOutcome(check)
            if (!showOutcome.ok) {
              setDetailErr(showOutcome.error)
              setDetail(null)
              return
            }
            setDetail({ article: showOutcome.data, report: checkOutcome.data && checkOutcome.data.report, checkOk: checkOutcome.ok })
            setFlow((prev) => ({ ...prev, step: checkOutcome.ok ? 2 : 1 }))
          } catch (error) {
            if (aliveRef.current && error.name !== 'AbortError') {
              setDetailErr({ code: 'load_failed', message: error.message, hint: hintFor('') })
            }
          } finally {
            if (aliveRef.current) setDetailBusy(false)
          }
        })()
        return () => controller.abort()
      }, [selected, detailV])

      // 选中文章后自动体检：用户不用先点按钮就知道分数
      useEffect(() => {
        if (!selected) {
          setReviewReport(null)
          setReviewErr(null)
          return
        }
        void runReview()
        // runReview 已依赖 selected；这里刻意不把它列入依赖，避免「体检→setState→再体检」循环
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selected])

      // 注意：预设列表的加载**不能**放在这里。
      // useEffect(fn, [refreshPresets]) 的依赖数组会在执行到该行时立即求值，
      // 而 refreshPresets 是下面的 const（useCallback）——放前面就触发暂时性死区，
      // 整个 main 槽直接崩掉（2026-11-05 实测：Cannot access 'refreshPresets' before initialization）。
      // 所以它被放到所有 useCallback 定义之后，见下方「首次拉预设」那段。

      const runAction = useCallback(
        async (name, op, params, label) => {
          if (busy) {
            notify(`上一个操作「${busy}」还在进行，稍等一下再点`, 'warn', 2600)
            return
          }
          setBusy(name)
          pushLog(`$ wxmp ${label}`)
          const attemptStart = Date.now()
          try {
            const outcome = toOutcome(await api(op, params))
            if (!aliveRef.current) return outcome
            if (outcome.ok) {
              pushLog(`✔ ${outcome.text.split('\n')[0] || '完成'}`)
              notify(outcome.text.split('\n')[0] || '完成', 'ok')
              return outcome
            }
            // 故障分类：给出可执行的下一步，不只是“失败”
            const err = outcome.error || {}
            const code = err.code || 'unknown'
            const hint = err.hint || hintFor(code)
            const isTransient = ['timeout', 'spawn_failed', 'backend_unreachable', 'http_502', 'http_503', 'http_504'].includes(code)
            pushLog(`✘ [${code}] ${err.message} | ${hint}`, {
              op,
              code,
              transient: isTransient,
              ms: Date.now() - attemptStart,
            })
            notify(`${err.message || '操作失败'} · ${hint}`, 'err', isTransient ? 4000 : 8000)
            return { ok: false, error: { ...err, transient: isTransient, hint } }
          } catch (error) {
            const err = { code: 'network', message: error.message, hint: hintFor('network'), transient: true }
            pushLog(`✘ [network] ${error.message}`, { op, transient: true, ms: Date.now() - attemptStart })
            notify(`网络故障：${error.message} · ${err.hint}`, 'err', 6000)
            return { ok: false, error: err }
          } finally {
            if (aliveRef.current) setBusy('')
          }
        },
        [busy, notify, pushLog],
      )

      /* ── T9-2 统一确认浮层的状态机 ─────────────────────────── */
      /** 请求一次确认 —— 所有破坏性操作的唯一入口。 */
      const requestConfirm = useCallback((config) => {
        setConfirmState({ error: null, running: false, danger: false, ...config })
      }, [])
      /** 取消 / 关闭确认浮层（三件套与「取消」按钮都走它）。 */
      const cancelConfirm = useCallback(() => setConfirmState(null), [])
      /**
       * 执行确认。成功关浮层；失败把浮层留着并显示三段式原因。
       * 为什么失败不关：这几条失败基本是后端不可达 / 超时，用户第一反应是重试 ——
       * 浮层留着才有「再点一次」这个动作可点。
       * outcome 为 undefined 表示 onConfirm 被执行守卫拦下（例如 runAction 发现别的操作在跑），
       * 那种情况 toast 已经说明了原因，这里直接收起浮层，不再多报一个假失败。
       */
      const runConfirm = useCallback(async () => {
        const pending = confirmState
        if (!pending || pending.running) return
        setConfirmState((prev) => (prev ? { ...prev, running: true, error: null } : prev))
        let outcome
        try {
          outcome = await pending.onConfirm()
        } catch (error) {
          outcome = {
            ok: false,
            error: {
              code: (error && error.code) || 'network',
              message: (error && error.message) || '操作失败',
              hint: hintFor((error && error.code) || 'network'),
            },
          }
        }
        if (!aliveRef.current) return
        if (!outcome || outcome.ok) {
          setConfirmState(null)
          return
        }
        setConfirmState((prev) => (prev
          ? {
              ...prev,
              running: false,
              error: (outcome && outcome.error) || { code: 'unknown', message: '操作失败', hint: hintFor('') },
            }
          : prev))
      }, [confirmState])

      async function createDraft() {
        const outcome = await runAction('draft', 'draft-create', { file: selected }, 'draft create')
        if (outcome && outcome.ok) {
          setFlow((prev) => ({ ...prev, step: 4 }))
          await refreshList()
          // 建草稿会写回 mediaId 与封面素材信息，详情必须重读，否则「封面素材」那行还是旧的
          setDetailV((n) => n + 1)
          void api('state').then((p) => { const o = toOutcome(p); if (o.ok) setDraftCount(o.data.total ?? null) }).catch(() => {})
        }
      }

      async function publishNow() {
        if (publishing) {
          notify('正在提交发布任务，请稍等…', 'warn', 2000)
          return
        }
        const mediaId = detail && detail.article && detail.article.article && detail.article.article.mediaId
        if (!mediaId) {
          notify('还没有草稿 id，先点「建草稿」', 'warn')
          return
        }
        setPublishing(true)
        setBusy('publish')
        pushLog(`$ wxmp publish-submit`)
        try {
          const outcome = await runAction('publish', 'publish-submit', { mediaId }, 'publish submit')
          if (!outcome || !outcome.ok) {
            // 48001：接口权限问题，不是操作失误。常驻一行说清怎么接着往下走。
            if (outcome && outcome.error && outcome.error.code === 'wechat_48001') {
              setManualPublish(true)
              notify('你的账号没有发布 API 权限（48001）。草稿已送进草稿箱，请在公众号后台人工发布。', 'err', 8000)
            } else {
              notify(outcome && outcome.error ? outcome.error.message : '提交失败', 'err', 6000)
            }
            return
          }
          setFlow((prev) => ({ ...prev, step: 5 }))
          const publishId = outcome.data && outcome.data.publishId
          if (!publishId) {
            notify('提交成功，但未返回发布 id，稍后在公众号后台查结果。', 'warn', 6000)
            return
          }
          pushLog(`$ wxmp publish status ${publishId}`)
          // 轮询：异步任务，submit 成功不等于发布成功
          let finished = false
          for (let attempt = 0; attempt < 20 && aliveRef.current && !finished; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000))
            const status = toOutcome(await api('publish-status', { publishId }))
            if (!status.ok) {
              pushLog(`! 查状态失败：${status.error?.message || '未知错误'}`)
              finished = true
              notify('发布状态查询失败，请在公众号后台确认结果。', 'err', 6000)
              break
            }
            const code = status.data && status.data.publish_status
            if (code === 1) {
              pushLog('  · 发布中…')
              continue
            }
            pushLog(code === 0 ? '✔ 发布成功' : `! 发布未通过（状态 ${code}）`)
            notify(code === 0 ? '发布成功，链接已拿到' : `发布未通过（状态 ${code}），请在公众号后台查看详情。`, code === 0 ? 'ok' : 'err', 6000)
            finished = true
          }
          if (!finished && aliveRef.current) {
            pushLog('! 轮询超时，发布结果未知')
            notify('发布轮询超时，结果未知，请在公众号后台确认。', 'warn', 6000)
          }
        } catch (error) {
          pushLog(`✘ ${error.message}`)
          notify(error.message || '发布出错', 'err', 6000)
        } finally {
          if (aliveRef.current) {
            setBusy('')
            setPublishing(false)
          }
        }
      }

      /* ── 封面：三种背景来源（与 CLI 的三档一一对应）───────
       *   不传 → 渐变（默认）
       *   { bg: 文件名 } → 用户底图（面板选的文件已复制进 articles/）
       *   { imageGen: true } → AI 生成（无 key 会回落并说明原因）
       * 三种情况共用同一条 op，只是参数不同 —— 避免三套代码三个 bug。
       *
       * 输出尺寸也从这里统一带出去：三条路径都经过本函数，
       * 所以「改过尺寸 → 换封面 / 选底图 / AI 配图」都会用同一个尺寸，不会出现
       * "改了尺寸但只有 AI 那条生效"这种一半生效的怪状态。
       */
      const regenerateCover = useCallback(async (extra = {}) => {
        if (!selected) return
        const sizeParams = coverSize
          ? { width: coverSize.width, height: coverSize.height }
          : {}
        setImageGen((prev) => ({ ...prev, busy: true }))
        try {
          const outcome = await runAction(
            'cover',
            'cover',
            { file: selected, badge: 'WXMP', ...sizeParams, ...extra },
            'cover',
          )
          // 换了新封面 = 换版本号，否则 <img> 还在用缓存里那张旧图
          setCoverV(Date.now())
          // AI 回落时把原因留在日志区（runAction 的 toast 只显示首行）
          if (outcome && outcome.ok && outcome.text && outcome.text.includes('注意：')) {
            const reason = outcome.text.split('注意：')[1]
            if (reason) pushLog(`! 封面回落：${reason.split('\n')[0]}`)
          }
          await refreshList()
        } finally {
          if (aliveRef.current) setImageGen((prev) => ({ ...prev, busy: false }))
        }
      }, [selected, coverSize, runAction, refreshList, pushLog])

      /** 面板选的底图：先复制到文章目录，再用文件名传给 CLI。
       *  为什么不用 data URL：图可能几 MB，塞进 JSON body 既慢又容易触上限；
       *  而且 CLI 的 --bg 本来就接受相对文章目录的路径。
       */
      const applyLocalBackground = useCallback(async (file) => {
        if (!file) return
        if (!selected) {
          notify('先选一篇文章，底图会放进那篇文章的目录', 'warn')
          return
        }
        const MAX = 12 * 1024 * 1024
        if (file.size > MAX) {
          notify(`底图 ${(Math.round(file.size / 1048576))} MB 超过 12 MB，先压缩`, 'err', 6000)
          if (bgInputRef.current) bgInputRef.current.value = ''
          return
        }
        setImageGen((prev) => ({ ...prev, busy: true }))
        try {
          // 读到 base64 交给后端落盘 —— 后端知道文章目录，前端不该自己拼路径
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result || ''))
            reader.onerror = () => reject(new Error('读取文件失败'))
            reader.readAsDataURL(file)
          })
          const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
          if (!match) throw new Error('不是有效的图片文件')
          const outcome = toOutcome(await api('save-background', {
            file: selected,
            name: file.name,
            mime: match[1],
            content: match[2],
          }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            return
          }
          const savedName = outcome.data && outcome.data.name
          notify(`底图已就位：${savedName}`, 'ok', 4000)
          await regenerateCover({ bg: savedName })
        } catch (error) {
          if (aliveRef.current) notify(`底图处理失败：${error.message}`, 'err', 6000)
        } finally {
          if (aliveRef.current) {
            setImageGen((prev) => ({ ...prev, busy: false }))
            if (bgInputRef.current) bgInputRef.current.value = ''
          }
        }
      }, [selected, notify, regenerateCover])

      /** 保存图片供应商 key：配完立刻重新探测，让顶栏按钮状态跟着变。 */
      const saveImageKey = useCallback(async (provider, key, baseUrl) => {
        try {
          const outcome = toOutcome(await api('config-set-image', {
            provider,
            key,
            ...(provider === '__custom' ? { baseUrl } : {}),
          }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            return
          }
          notify(outcome.text || '已保存', 'ok', 4000)
          const next = outcome.data && outcome.data.imageProviders
          if (next) {
            setImageGen((prev) => ({ ...prev, available: Boolean(next.available), providers: next.providers || [] }))
          }
        } catch (error) {
          if (aliveRef.current) notify(`保存失败：${error.message}`, 'err', 6000)
        }
      }, [notify])

      /** 清空所有已配的图片 key。 */
      const clearImageKeys = useCallback(async () => {
        try {
          const outcome = toOutcome(await api('config-clear-image', {}))
          if (!aliveRef.current) return { ok: true }
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            // T9-2：把失败结果回传给确认浮层（浮层留着 + 就地显示原因），别静默当成功
            return outcome
          }
          notify('已清空所有图片供应商 key', 'ok', 4000)
          setImageGen((prev) => ({ ...prev, available: false, providers: [] }))
          return outcome
        } catch (error) {
          if (aliveRef.current) notify(`清空失败：${error.message}`, 'err', 6000)
          // T9-2：网络层失败也回传结构化原因
          return { ok: false, error: { code: error.code || 'network', message: error.message, hint: error.hint || hintFor('network') } }
        }
      }, [notify])

      /**
       * T9-1：删除一篇本地文章。
       * 走统一确认浮层（T9-2）—— 删的是磁盘上的 .md 文件，没有回收站。
       * 微信后台的草稿不在删除范围内，确认文案里必须写明，否则用户会以为「一键全清」。
       */
      const deleteArticle = useCallback((item) => {
        if (!item || !item.path) return
        requestConfirm({
          title: '删除这篇文章？',
          body: [
            `要删的本地文件：${item.title || item.path}`,
            item.mediaId
              ? '这篇已经建过微信草稿：本次只删本机的 .md 文件，微信后台的草稿不会被删 —— 要删草稿请去公众号后台的草稿箱操作。'
              : '本次只删本机的 .md 文件；微信后台没有它的草稿，不需要额外操作。',
            '本地文件删掉之后没有回收站，也恢复不了。',
          ],
          confirmLabel: '删除',
          busyLabel: '删除中…',
          danger: true,
          onConfirm: async () => {
            const outcome = await runAction('delete', 'article-delete', { file: item.path }, 'article delete')
            if (outcome && outcome.ok) {
              // 删的正是当前选中：清掉选择，让中/右栏回到「先选一篇」的空态
              if (selected === item.path) {
                setSelected('')
                savePrefs({ lastFile: '' })
              }
              await refreshList()
              notify(`已删除本地文章：${item.title || item.path}`, 'ok', 5000)
            }
            return outcome
          },
        })
      }, [requestConfirm, runAction, selected, refreshList, notify])

      /**
       * 从链接导入文章。
       * 支持一次贴多个链接（一行一个）：后端会逐个抓，单篇失败不中断整批。
       * 结果要落在面板里而不是只弹 toast —— 批量导入失败时用户需要看到
       * 哪几篇失败、为什么失败，toast 几秒就消失了。
       */
      const runImport = useCallback(async () => {
        const lines = String(importUrl || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
        if (!lines.length) {
          notify('先粘贴至少一个公众号链接', 'warn')
          return
        }
        setImportBusy(true)
        setImportResult(null)
        try {
          const results = []
          for (const url of lines) {
            const outcome = toOutcome(await api('import-article', { url }))
            if (outcome.ok) {
              const imported = (outcome.data && outcome.data.results) || []
              results.push(...imported)
            } else {
              results.push({ ok: false, url, error: outcome.error.message, code: outcome.error.code })
            }
          }
          if (!aliveRef.current) return
          const okList = results.filter((item) => item.ok)
          const failList = results.filter((item) => !item.ok)
          const parts = []
          if (okList.length) {
            parts.push(`已导入 ${okList.length} 篇：`)
            for (const item of okList) parts.push(`· ${item.file}（${item.chars} 字）`)
          }
          if (failList.length) {
            if (parts.length) parts.push('')
            parts.push(`${failList.length} 篇失败：`)
            for (const item of failList) parts.push(`· [${item.code}] ${item.error}`)
          }
          setImportResult({ failed: failList.length, text: parts.join('\n') })
          if (okList.length) {
            // 导完立刻刷新列表，用户能马上看到新文章
            await refreshList()
            setImportUrl('')
          }
        } catch (error) {
          if (aliveRef.current) {
            setImportResult({ failed: 1, text: `导入失败：${error.message}` })
          }
        } finally {
          if (aliveRef.current) setImportBusy(false)
        }
      }, [importUrl, notify, refreshList])

      /**
       * 写作辅助三件套：标题 / 骨架 / 任务书。
       * 三者合用一个 lab 区域，互斥展开（一次只想做一件事）。
       * 结果落在面板里而不是 toast —— 这些产出都比较长，用户要能对着改。
       */
      const runLab = useCallback(async (which, params = {}) => {
        setLabBusy(which)
        try {
          const outcome = toOutcome(await api(which, params))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            return
          }
          const key = which === 'title-lab' ? 'titles'
            : which === 'outline-lab' ? 'outline'
            : which === 'illustrate' ? 'images'
            : 'brief'
          setLabResult((prev) => ({ ...prev, [key]: outcome }))
        } catch (error) {
          if (aliveRef.current) notify(`生成失败：${error.message}`, 'err', 6000)
        } finally {
          if (aliveRef.current) setLabBusy('')
        }
      }, [notify])

      /** 把选中的标题写回文章。必须由人点，绝不自动改。 */
      const applyTitle = useCallback(async (text) => {
        if (!selected || !text) return
        setLabBusy('set-title')
        try {
          const outcome = toOutcome(await api('set-title', { file: selected, title: text }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            return
          }
          notify('标题已更新', 'ok', 3000)
          setTitleInput('')
          await refreshList()
          // 详情在 effect 里按 selected 加载，光改文件它不会重跑 ——
          // 必须显式推一次 detailV，否则面板里还显示旧标题。
          setDetailV((n) => n + 1)
          setCoverV(Date.now())
        } catch (error) {
          if (aliveRef.current) notify(`写回失败：${error.message}`, 'err', 6000)
        } finally {
          if (aliveRef.current) setLabBusy('')
        }
      }, [selected, notify, refreshList])

      /**
       * 写回作者名。传空字符串 = 清空（front matter 里写成 `author:`）。
       *
       * 和标题写回同一个纪律：只由人点按钮触发，绝不自动改用户文件。
       * 改完要把面板缓存里的 article 也刷新 —— 否则作者行还显示旧名字，
       * 用户会以为没生效（这正是"操作了不给反馈"的另一种形态）。
       */
      const applyAuthor = useCallback(async (text) => {
        if (!selected) return
        const next = String(text == null ? '' : text).trim()
        setLabBusy('set-author')
        try {
          const outcome = toOutcome(await api('set-author', { file: selected, author: next }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            return
          }
          const changed = !outcome.data || outcome.data.changed !== false
          notify(
            changed
              ? (next ? `作者已改为「${next}」，封面和预览都会跟着变` : '作者已清空，封面与预览不再显示作者')
              : '作者没有变化',
            changed ? 'ok' : 'warn',
            4200,
          )
          setAuthorInput('')
          setAuthorEditing(false)
          await refreshList()
          // 详情 effect 只依赖 [selected]，不推版本号的话作者行还显示旧名字
          setDetailV((n) => n + 1)
          setCoverV(Date.now())
        } catch (error) {
          if (aliveRef.current) notify(`写回失败：${error.message}`, 'err', 6000)
        } finally {
          if (aliveRef.current) setLabBusy('')
        }
      }, [selected, notify, refreshList])

      /* ── 体检与预设 ────────────────────────────────────────── */

      const refreshPresets = useCallback(async (signal) => {
        setPresetsBusy(true)
        try {
          const outcome = toOutcome(await api('preset-list', {}, signal))
          if (!aliveRef.current) return
          if (outcome.ok) {
            const list = (outcome.data && outcome.data.presets) || []
            setPresets(list)
            setCurrentPreset((outcome.data && outcome.data.current) || (list[0] && list[0].id) || '')
          } else {
            // 预设读不出来不该阻断别的功能：记一条日志就够了
            pushLog(`✘ 预设列表读取失败：${outcome.error.message}`)
          }
        } catch (error) {
          if (aliveRef.current && error.name !== 'AbortError') pushLog(`✘ 预设列表读取失败：${error.message}`)
        } finally {
          if (aliveRef.current) setPresetsBusy(false)
        }
      }, [pushLog])

      const runReview = useCallback(async (presetId) => {
        if (!selected) return
        setReviewBusy(true)
        setReviewErr(null)
        try {
          const params = { file: selected }
          if (presetId) params.preset = presetId
          const outcome = toOutcome(await api('review-article', params))
          if (!aliveRef.current) return
          if (outcome.ok) {
            setReviewReport(outcome.data.review)
            if (outcome.data.review && outcome.data.review.preset) setCurrentPreset(outcome.data.review.preset.id)
          } else {
            // 分数没到及格线时 CLI 会 exit 1，但报告本身仍然有用 —— 照常展示
            const review = outcome.data && outcome.data.review
            if (review) {
              setReviewReport(review)
              if (review.preset) setCurrentPreset(review.preset.id)
            } else {
              setReviewErr(outcome.error)
            }
          }
        } catch (error) {
          if (aliveRef.current && error.name !== 'AbortError') {
            setReviewErr({ code: 'review_failed', message: error.message, hint: hintFor('') })
          }
        } finally {
          if (aliveRef.current) setReviewBusy(false)
        }
      }, [selected])

      const usePreset = useCallback(async (id) => {
        if (!id) return
        setPresetsBusy(true)
        try {
          const outcome = toOutcome(await api('preset-use', { id }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 5000)
            return
          }
          setCurrentPreset(id)
          notify(`已切换到「${(presets.find((p) => p.id === id) || {}).name || id}」标准`, 'ok')
          // 立刻用新标准重算，让用户看到分数变化（这就是选择预设的意义）
          await runReview(id)
        } catch (error) {
          // N2 preset-actions-unhandled-rejection：api() 网络层失败是 throw，
          // 这里原来只有 try/finally 没有 catch → 后端不可达时点击「使用此标准」
          // 界面毫无反馈，控制台只留一条 unhandled rejection。照 runLab 的样式补上。
          if (aliveRef.current) notify((error && error.message) || '操作失败', 'err', 5000)
        } finally {
          if (aliveRef.current) setPresetsBusy(false)
        }
      }, [notify, presets, runReview])

      /* 1.8.0 preset-prompt-copy：把当前预设拼成完整写作提示词复制到剪贴板。
         预设的第一身份是写作提示词——这份文本直接交给 AI 当写作指令，
         稿子自然长在这套标准的节奏上，review 只是写完后的复核。
         剪贴板不可用时（http 页面/权限拒绝）不静默：全文显示在浮窗里手动复制。 */
      const copyPresetPrompt = useCallback(async (id) => {
        const target = id || currentPreset
        if (!target) return
        setPresetsBusy(true)
        try {
          const outcome = toOutcome(await api('preset-prompt', { id: target }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 5000)
            return
          }
          const prompt = (outcome.data && outcome.data.prompt) || ''
          if (!prompt) {
            notify('提示词是空的（预设可能坏了，跑一次「恢复内置」试试）', 'warn', 5000)
            return
          }
          const name = (outcome.data && outcome.data.name) || target
          try {
            await navigator.clipboard.writeText(prompt)
            notify(`已复制「${name}」的写作提示词 —— 交给 AI 当写作指令`, 'ok', 6000)
          } catch {
            setPromptPreview({ name, text: prompt })
          }
        } catch (error) {
          if (aliveRef.current) notify((error && error.message) || '操作失败', 'err', 5000)
        } finally {
          if (aliveRef.current) setPresetsBusy(false)
        }
      }, [currentPreset, notify])

      const exportCurrentPreset = useCallback(async () => {        if (!currentPreset) return
        setPresetsBusy(true)
        try {
          const outcome = toOutcome(await api('preset-export', { id: currentPreset }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 5000)
            return
          }
          const json = (outcome.data && outcome.data.json) || ''
          // 浏览器里没有「静默写盘」，用下载是最直白、跨平台的导出方式
          try {
            const blob = new Blob([json], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${currentPreset}.wxmp-review.json`
            document.body.appendChild(link)
            link.click()
            link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 4000)
            notify(`已导出 ${currentPreset}.wxmp-review.json`, 'ok', 5000)
          } catch (error) {
            notify(`浏览器不支持下载，已复制到剪贴板前请手动保存：${error.message}`, 'err', 6000)
          }
        } finally {
          if (aliveRef.current) setPresetsBusy(false)
        }
      }, [currentPreset, notify])

      const importPresetFile = useCallback(async (file) => {
        if (!file) return
        if (file.size > 64 * 1024) {
          notify('预设文件超过 64 KB，看起来不是预设文件', 'err', 6000)
          return
        }
        setPresetsBusy(true)
        try {
          const text = await file.text()
          // 前端先做一次 JSON 语法校验：损坏的文件不应该交给后端，也不能让后续 usePreset/runReview 抛未捕获异常白屏整个面板
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch (jsonErr) {
            notify('导入失败：预设文件不是合法的 JSON，请检查文件内容', 'err', 6000)
            return
          }
          const asId = String(file.name || '').replace(/\.(wxmp-review\.)?json$/i, '').replace(/\.json$/i, '')
          const outcome = toOutcome(await api('preset-import', { content: text, as: asId }))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 6000)
            return
          }
          notify(`已导入「${(outcome.data && outcome.data.preset && outcome.data.preset.name) || asId}」`, 'ok', 5000)
          await refreshPresets()
        } catch (error) {
          if (aliveRef.current) notify(`导入失败：${error.message}`, 'err', 6000)
        } finally {
          if (aliveRef.current) {
            setPresetsBusy(false)
            if (importInputRef.current) importInputRef.current.value = ''
          }
        }
      }, [notify, refreshPresets])

      const resetPresets = useCallback(async () => {
        setPresetsBusy(true)
        try {
          const outcome = toOutcome(await api('preset-reset', {}))
          if (!aliveRef.current) return
          if (!outcome.ok) {
            notify(outcome.error.message, 'err', 5000)
            return
          }
          notify('内置预设已就位（已改过的不覆盖）', 'ok', 5000)
          await refreshPresets()
        } catch (error) {
          // N2（第二处）：同 usePreset，漏 catch 会让「恢复内置」静默失败。
          if (aliveRef.current) notify((error && error.message) || '恢复内置预设失败', 'err', 5000)
        } finally {
          if (aliveRef.current) setPresetsBusy(false)
        }
      }, [notify, refreshPresets])

      /**
       * T9-3：删除一个用户自建的预设（原来面板上根本没有这个入口 —— op `preset-remove`
       * 一直存在，但只能去命令行调，用户以为「删不掉」）。
       * 走统一确认浮层（T9-2）；内置预设不给删，见预设列表里的判定。
       */
      const removePreset = useCallback((item) => {
        if (!item || !item.id) return
        const name = item.name || item.id
        requestConfirm({
          title: `删除预设「${name}」？`,
          body: [
            `会删掉：本机预设目录里的 ${item.id}（那份打分标准 JSON）。`,
            '不会动：你的文章与草稿；其他预设；内置 standard 兜底预设。',
            currentPreset === item.id
              ? '这个预设正在被使用 —— 删掉之后打分标准会回落到内置 standard，需要的话再选一个。'
              : '删掉的预设没有回收站；内置那几个可以用「恢复内置」写回来。',
          ],
          confirmLabel: '删除',
          busyLabel: '删除中…',
          danger: true,
          onConfirm: async () => {
            const outcome = await runAction('presetRemove', 'preset-remove', { id: item.id }, 'preset remove')
            if (outcome && outcome.ok) {
              // 删的正是当前标准：清掉它，别让界面继续显示一个已经不存在的预设
              if (currentPreset === item.id) setCurrentPreset('')
              await refreshPresets()
            }
            return outcome
          },
        })
      }, [requestConfirm, runAction, currentPreset, refreshPresets])
      // 必须放在**所有** useCallback 之后：依赖数组在这一行立即求值，
      // 提前引用 const 会触发暂时性死区，整个 main 槽会崩掉
      // （2026-11-05 实测：Cannot access 'refreshPresets' before initialization）。
      useEffect(() => {
        const controller = new AbortController()
        void refreshPresets(controller.signal)
        void (async () => {
          try {
            const outcome = toOutcome(await api('image-providers', {}, controller.signal))
            if (!aliveRef.current) return
            if (outcome.ok) {
              setImageGen((prev) => ({
                ...prev,
                available: Boolean(outcome.data && outcome.data.available),
                providers: (outcome.data && outcome.data.providers) || [],
                note: (outcome.data && outcome.data.note) || '',
              }))
            }
          } catch {
            /* 探测失败不影响其它功能：按钮会显示「未配置」 */
          }
        })()
        return () => controller.abort()
      }, [refreshPresets])

      async function probeRuntime() {
        setRuntimeBusy(true)
        setRuntimeNote('')
        try {
          const healthOutcome = toOutcome(await api('health', {}))
          const logsOutcome = toOutcome(await api('logs', { lines: 20 }))
          if (!aliveRef.current) return
          setBackendOk(healthOutcome.ok)
          setRuntime({
            health: healthOutcome.ok ? healthOutcome.data : null,
            logs: logsOutcome.ok ? (logsOutcome.data && logsOutcome.data.lines) || [] : [],
            logFile: logsOutcome.ok ? (logsOutcome.data && logsOutcome.data.file) || '' : '',
          })
          if (!healthOutcome.ok) {
            setRuntimeNote(`后端没响应：${healthOutcome.error.message || '未知原因'}。${healthOutcome.error.hint || hintFor(healthOutcome.error.code)}`)
          }
        } catch (error) {
          if (aliveRef.current) {
            setBackendOk(false)
            setRuntimeNote(`取运行状态失败：${error.message}`)
          }
        } finally {
          if (aliveRef.current) setRuntimeBusy(false)
        }
      }

      /**
       * 收集诊断信息 → 弹出诊断浮窗。
       *
       * 为什么改成浮窗：用户原话是"点了没有任何反馈，操作了不给用户反馈是在刁难用户"。
       * 旧实现把结果写进一个只有设置页底部才看得见的 <pre>，点完屏幕上什么都不会发生。
       *
       * 两个设计决定：
       *   1. 先弹窗、后取数 —— 点击到出现 < 100ms，取数失败也不会让面板空着；
       *   2. 现取不用缓存 —— 直接打 health / logs 两个接口，不复用 state 里可能落后几秒的旧值。
       *
       * 刻意不自动写剪贴板：静默改剪贴板同样是一种"看不见的操作"。
       * 复制由浮窗里的「复制全部」按钮显式触发，复制完给 toast。
       */
      async function collectDiagnostics(options) {
        // 兼容被直接当 onClick 用：传进来的是事件对象时忽略它
        const opts = options && typeof options === 'object' && !('target' in options) ? options : {}
        // silent：只刷新数据、不弹窗（给以后"后台静默探测"留的口子）
        const silent = Boolean(opts.silent)
        if (!silent) {
          setDiagOpen(true)
          setDiagCopied(false)
        }
        setDiagBusy(true)
        let healthOutcome = { ok: false, data: null }
        let logs = []
        let logFile = ''
        try {
          healthOutcome = toOutcome(await api('health', {}))
          const logsOutcome = toOutcome(await api('logs', { lines: 20 }))
          if (logsOutcome.ok) {
            logs = (logsOutcome.data && logsOutcome.data.lines) || []
            logFile = (logsOutcome.data && logsOutcome.data.file) || ''
          }
          if (!aliveRef.current) return
          // 顺手把顶部"后台已连通"徽章也刷新了，省得它和诊断结论互相矛盾
          setBackendOk(healthOutcome.ok)
          setRuntime({ health: healthOutcome.ok ? healthOutcome.data : null, logs, logFile })
          const health = healthOutcome.ok ? healthOutcome.data : null
          const backendLogs = logs.slice(-20)
          const opsLog = flow.log.slice(-20)
          const rows = [
            // F10：诊断行用本次刚取到的 health，同样经 resolveVersion —— 不另立真相
            ['插件版本', `公众号文章工作台 v${resolveVersion(health)}`],
            ['接口地址', API],
            ['后端连通', healthOutcome.ok ? '正常' : `未响应（${healthOutcome.error.message}）`],
            ['宿主路由', (health && health.route) || (backendInfo && backendInfo.route) || '（未知）'],
            ['后端进程', health && health.pid ? String(health.pid) : '（未知）'],
            ['CLI 路径', (health && health.cliPath) || '（未知）'],
            ['挂载时间', (health && health.mountedAt) || '（未知）'],
            ['当前选中', selected || '（没选文章）'],
            ['文章总数', `${(articles || []).length} 篇`],
            ['草稿箱', draftCount == null ? '（没读到）' : `${draftCount} 条`],
            ['最近错误', (detailErr && detailErr.message) || (listErr && listErr.message) || (reviewErr && reviewErr.message) || '无'],
            ['浏览器', String((typeof navigator !== 'undefined' && navigator.userAgent) || '').slice(0, 140)],
          ]
          const payload = [
            `公众号文章工作台 · 诊断信息 · ${new Date().toLocaleString()}`,
            '',
            '[运行环境与状态]',
            ...rows.map((pair) => `${pair[0]}：${pair[1]}`),
            '',
            `[后端日志] 最近 ${backendLogs.length} 行${logFile ? ` · ${logFile}` : ''}`,
            ...(backendLogs.length ? backendLogs : ['（没有拿到日志）']),
            '',
            `[本次操作流水] 最近 ${opsLog.length} 条`,
            ...(opsLog.length ? opsLog : ['（本次会话还没有操作记录）']),
          ].join('\n')
          setDiag({ at: Date.now(), ok: healthOutcome.ok, rows, payload, backendLogs, opsLog, health })
        } catch (error) {
          if (!aliveRef.current) return
          const message = String((error && error.message) || error)
          setBackendOk(false)
          setDiag({
            at: Date.now(),
            ok: false,
            rows: [['采集失败', message]],
            payload: `公众号文章工作台 · 诊断采集失败\n${message}`,
            backendLogs: logs,
            opsLog: flow.log.slice(-20),
            health: null,
          })
        } finally {
          if (aliveRef.current) setDiagBusy(false)
        }
      }

      /** 把诊断全文写进剪贴板（显式动作，写完给反馈）。 */
      async function copyDiagnostics() {
        const text = (diag && diag.payload) || ''
        if (!text) {
          notify('还没有诊断内容，先点一次「诊断」', 'warn')
          return
        }
        try {
          await navigator.clipboard.writeText(text)
          setDiagCopied(true)
          notify('诊断信息已复制到剪贴板', 'ok')
        } catch {
          notify('剪贴板不可用，可以在浮窗里手动选中复制', 'warn')
        }
      }

      const wide = props.wide !== false

      // 三布局：先按宿主给的 wide，再叠加容器宽度观察（<720px 强制单列）
      const [narrow, setNarrow] = useState(false)
      const shellRef = useRef(null)
      useEffect(() => {
        const node = shellRef.current
        if (!node || typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const width = entry.contentRect ? entry.contentRect.width : 0
            setNarrow(width > 0 && width < 720)
          }
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])
      const stacked = narrow || !wide
      // P15：根容器类名统一在这里算 —— 主渲染与骨架屏两条返回路径都要挂上，
      // 否则「加载时那一屏」仍然会闪动效（用户已经明确关掉了）。
      const shellClass = reduceMotion ? 'wxmp-shell wxmp-reduce-motion' : 'wxmp-shell'

      /* 骨架屏：列表还没回来时（给重试出口，不让用户卡在空白） */
      if (articles === null) {
        return h(
          'div',
          { ref: shellRef, className: shellClass, style: pageStyle },
          h('style', null, CSS),
          h('div', { style: { maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 32 } },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' } },
              h(Skeleton, { height: 54, radius: 12 }),
              h(Skeleton, { height: 54, radius: 12 }),
              h(Skeleton, { height: 54, radius: 12 }),
            ),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('primary'),
              onClick: () => {
                setArticles(null)
                refreshList(new AbortController().signal)
              },
            }, '重新读取文章'),
          ),
        )
      }

      const current = (articles || []).find((item) => item.path === selected) || null
      const report = detail && detail.report
      const issues = (report && report.issues) || []
      const warnings = (report && report.warnings) || []
      const article = detail && detail.article && detail.article.article

      return h(
        'div',
        { ref: shellRef, className: shellClass, style: pageStyle },
        h('style', null, CSS),

        // ── 顶栏：主操作固定在这里，不随滚动跑丢 ──────────────
        h(
          'div',
          { style: topBarStyle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, '公众号文章工作台'),
            h(Badge, { tone: 'idle' }, `v${displayVersion}`),
            h(
              Badge,
              { tone: backendOk ? 'ok' : 'err' },
              backendOk ? '后台已连通' : '后台未响应（重启 DSH 或新开会话）',
            ),
            h(Badge, { tone: draftErr ? 'err' : draftCount == null ? 'idle' : 'ok' },
              draftErr
                ? `草稿箱读不到：${(draftErr.code || '').replace(/^wechat_/, '微信错误 ')}`
                : draftCount == null ? '草稿读取中' : `草稿箱 ${draftCount} 条`),
            /* 右上角次要操作。
             * 之前是三个纯文字 ghost 按钮（设置 / 全屏 / 诊断），在深色主题里和背景几乎融为一体，
             * 用户反馈"看不出是什么、也不好点"。现在：
             *   - 全屏入口整块删除（用户明确说不再需要，双入口模型收敛成单入口）；
             *   - 每个按钮配 emoji 图标 + normal 变体（有底色、有边框），扫一眼就知道是什么；
             *   - 高度 34px，比正文按钮更高，鼠标和触屏都好瞄准。 */
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '打开设置：凭据、主题、数据清理',
              title: '设置（凭据 / AI 配图 / 数据）',
              style: { ...btn('normal'), marginLeft: 'auto', minHeight: 34, padding: '7px 14px' },
              onClick: () => setShowSettings(true),
            }, '⚙️ 设置'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '打开诊断信息浮窗',
              title: '诊断：版本、后端连通、最近日志',
              style: { ...btn('normal'), minHeight: 34, padding: '7px 14px' },
              onClick: () => void collectDiagnostics(),
            }, '🩺 诊断'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } },
            /* 主次分明：从左到右 = 常用程度递减。
             * 以前 4 个按钮平铺，视觉重量一样，用户每次都要读一遍才知道该点哪个。
             */
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '把当前文章发表到公众号（主操作）',
              // accent：实色高对比。整个面板只有这一个用 accent，确保视线第一落点在这里
              style: { ...btn('accent'), padding: '8px 20px', fontSize: 13 },
              disabled: Boolean(busy) || publishing || !selected,
              onClick: publishNow,
            }, busy === 'publish' || publishing ? '正在提交…' : '📤 发表到公众号'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '把当前文章送进公众号草稿箱',
              style: { ...btn('primary'), padding: '8px 14px' },
              disabled: Boolean(busy) || !selected,
              onClick: createDraft,
            }, busy === 'draft' ? '正在建草稿…' : '📝 建草稿'),
            h('div', { style: { width: 1, height: 22, background: C.border1, flex: 'none' }, 'aria-hidden': 'true' }),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '生成封面（当前方式：渐变底或已选底图）',
              style: btn('normal'),
              disabled: Boolean(busy) || !selected,
              onClick: () => void regenerateCover({}),
            }, busy === 'cover' ? '正在生成…' : '🖼️ 换封面'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '选择本地图片作为封面背景',
              style: btn('normal'),
              disabled: Boolean(busy) || !selected,
              onClick: () => bgInputRef.current && bgInputRef.current.click(),
            }, '📁 选底图'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '打开画面提示词弹窗',
              'aria-expanded': promptOpen,
              style: { ...btn('normal'), padding: '7px 14px' },
              onClick: () => { setPromptOpen((v) => { const next = !v; savePrefs({ promptOpen: next }); return next }) },
            }, promptOpen ? '🎨 收起画面提示词' : '🎨 自定义画面提示词'),
            // 打分预设的常驻入口。
            // 右栏里那个入口是"主入口"（旁边显示当前预设名），但它有个致命弱点：
            // 右栏一收起（railCollapsed）整栏就只剩一条竖条，用户再也找不到它 ——
            // 实际反馈就是「打分预设栏目怎么不见了」。所以顶栏这份是保底的：
            // 不管右栏收起、窗口很窄、还是滚到了页面别处，它都在这儿。
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '打开打分预设浮窗（可拖动、可调整大小）',
              'aria-expanded': presetOpen,
              title: `打开打分预设浮窗（可拖动、可调整大小）· 当前：${currentPreset || '未选择'}`,
              style: { ...btn(presetOpen ? 'primary' : 'normal'), padding: '7px 14px' },
              onClick: () => {
                const next = !presetOpen
                setPresetOpen(next)
                savePrefs({ presetOpen: next })
              },
            }, presetOpen ? '🎯 打分预设 ▾' : '🎯 打分预设'),
            // 底图文件选择：面板读文件内容转成 data URL 不现实（图可能很大），
            // 走「把图放进文章目录」的路径最稳：复制到 articles/ 后用文件名传给 CLI。
            h('input', {
              ref: bgInputRef,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp',
              'aria-label': '选择封面背景图',
              style: { display: 'none' },
              onChange: (event) => void applyLocalBackground(event.target.files && event.target.files[0]),
            }),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '重新读取文章列表',
              style: btn('normal'),
              disabled: Boolean(busy),
              onClick: async () => { await refreshList() },
            }, '🔄 刷新'),
          ),
          manualPublish
            ? h(
                'div',
                {
                  role: 'status',
                  'aria-live': 'polite',
                  style: {
                    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    marginTop: 10, padding: '8px 12px', borderRadius: 'var(--dsw-radius-md, 8px)',
                    border: `1px solid ${C.border1}`, background: C.l1, color: C.label2, fontSize: 12,
                  },
                },
                h('span', null, '这个号没有发布接口权限（48001），所以「发表到公众号」走不通 —— 草稿已经在草稿箱里，去后台手动群发即可。'),
                h('a', {
                  href: 'https://mp.weixin.qq.com/',
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  className: 'wxmp-focus',
                  'aria-label': '在新窗口打开公众号后台，去草稿箱手动群发',
                  style: { color: C.brand, textDecoration: 'none', fontWeight: 600 },
                }, '打开公众号后台 →'),
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '隐藏这条发布权限提示',
                  style: { ...btn('ghost'), marginLeft: 'auto', minHeight: 32, minWidth: 32 },
                  onClick: () => setManualPublish(false),
                }, '知道了'),
              )
            : null,
        ),

        // ── 三栏主体 ──────────────────────────────────────────
        // 列宽可拖拽：第一列与右栏都用 state 控制，中间列吃掉剩余空间。
        // 右栏收起时（railCollapsed）不再占宽度，靠 auto 自动处理。
        h(
          'div',
          { className: stacked ? 'wxmp-scroll' : undefined, style: { display: 'grid', gridTemplateColumns: stacked ? '1fr' : `${leftWidth}px 6px minmax(0,1fr) 6px auto`, gap: 0, flex: 1, minHeight: 0, overflowY: stacked ? 'auto' : 'visible' } },

          // 左：文章列表
          h(
            'div',
            { className: 'wxmp-scroll', style: colStyle },
            h(SectionTitle, { extra: `${(articles || []).length} 篇` }, '我的文章'),
            listErr ? h(ErrorBox, { error: listErr, onRetry: () => void refreshList(), onDiagnose: () => void collectDiagnostics() }) : null,
            (articles || []).length === 0 && !listErr
              ? h('div', { style: { color: C.label3, fontSize: 12, lineHeight: 1.7 } },
                  '还没有文章。点下面按钮新建一篇，标题 32 字以内。')
              : null,
            h('div',
              { role: 'listbox', 'aria-label': '文章列表' },
              ...(articles || []).slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((item) => {
                const isSelected = item.path === selected
                const pick = () => {
                  setSelected(item.path)
                  savePrefs({ lastFile: item.path })
                }
                /* T9-1 article-delete-entry：卡片从 <button> 改成 div[role=option]。
                   原因：删除按钮只能放在卡片**里面**，而 button 套 button 是非法结构 ——
                   读屏会把内层当成外层的一部分，键盘焦点顺序也会乱。
                   div 自己不许直接可点就算完：tabIndex + Enter/Space 必须等价于点击（键盘可达）。 */
                return h(
                  'div',
                  {
                    key: item.path,
                    role: 'option',
                    'aria-selected': isSelected ? 'true' : 'false',
                    tabIndex: 0,
                    className: 'wxmp-card wxmp-focus',
                    style: {
                      position: 'relative', display: 'block', width: '100%', textAlign: 'left',
                      border: `1px solid ${isSelected ? `color-mix(in srgb, ${C.brand} 55%, ${C.border1})` : C.border1}`,
                      background: isSelected ? `color-mix(in srgb, ${C.brand} 7%, ${C.l1})` : C.l1,
                      borderRadius: 10, padding: '9px 11px', marginBottom: 8, cursor: 'pointer',
                      color: 'inherit', font: 'inherit', fontFamily: FONT,
                    },
                    onClick: pick,
                    onKeyDown: (event) => {
                      // 空格也要拦 preventDefault，否则页面会跟着滚一段
                      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                        event.preventDefault()
                        pick()
                      }
                    },
                  },
                  // 标题右侧留出删除按钮的位置：留白不够时文字会跑到按钮底下
                  h('div', {
                    style: { fontWeight: 600, fontSize: 12.5, lineHeight: 1.45, marginBottom: 5, paddingRight: canDeleteArticle ? 34 : 0 },
                  }, item.title),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: C.label3, paddingRight: canDeleteArticle ? 34 : 0 } },
                    item.mediaId ? h(Badge, { tone: 'draft' }, '草稿中') : h(Badge, { tone: 'idle' }, '未建草稿'),
                    h('span', null, item.updated || ''),
                  ),
                  canDeleteArticle
                    ? h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        // 32×32 命中区、四周留 5px；键盘也能到（在卡片之后 Tab）
                        'aria-label': `删除文章：${item.title || item.path}`,
                        title: '删除本机的 .md 文件（微信后台的草稿不会被删）',
                        disabled: Boolean(busy),
                        style: {
                          ...btn('ghost'),
                          position: 'absolute', top: 5, right: 5,
                          width: 32, height: 32, minWidth: 32, minHeight: 32, padding: 0,
                          fontSize: 15, lineHeight: 1,
                        },
                        onClick: (event) => {
                          // 别把「点删除」变成「顺手选中这篇」——中/右栏会跟着跳一篇，用户很容易点错
                          event.stopPropagation()
                          deleteArticle(item)
                        },
                        // 键盘在删除按钮上按 Enter 也不能冒到卡片的选中逻辑
                        onKeyDown: (event) => { event.stopPropagation() },
                      }, '🗑')
                    : null,
                )
              },
              ),
            ),
            (articles || []).length > PAGE_SIZE
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px', fontSize: 11, color: C.label3 } },
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: { ...btn('ghost'), padding: '5px 12px', fontSize: 11, minHeight: 32, minWidth: 32 },
                    disabled: page === 0,
                    'aria-label': '上一页文章',
                    onClick: () => { const next = Math.max(0, page - 1); setPage(next); savePrefs({ page: next }) },
                  }, '上一页'),
                  h('span', null, `${page + 1} / ${Math.max(1, Math.ceil(articles.length / PAGE_SIZE))}`),
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: { ...btn('ghost'), padding: '5px 12px', fontSize: 11, minHeight: 32, minWidth: 32 },
                    disabled: (page + 1) * PAGE_SIZE >= (articles || []).length,
                    'aria-label': '下一页文章',
                    onClick: () => { const next = page + 1; setPage(next); savePrefs({ page: next }) },
                  }, '下一页'))
              : null,
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              disabled: Boolean(busy),
              'aria-disabled': Boolean(busy),
              'aria-label': busy
                ? `＋ 写一篇新文章（不可用：上一个操作「${busy}」还在进行，请稍后再试）`
                : '＋ 写一篇新文章',
              style: {
                ...btn('ghost'),
                width: '100%',
                marginTop: 6,
                // disabled 态必须可见：ghost 透明底不加遮罩，用户分不清能不能点
                opacity: busy ? 0.5 : 1,
                cursor: busy ? 'not-allowed' : 'pointer',
              },
              onClick: async () => {
                if (busy) {
                  notify(`上一个操作「${busy}」还在进行，稍等一下再点`, 'warn', 2600)
                  return
                }
                const title = window.prompt('新文章标题（32 字以内）')
                if (!title) return
                const outcome = await runAction('new', 'new-article', { title }, 'article new')
                if (outcome && outcome.ok) {
                  await refreshList()
                  const created = outcome.data && outcome.data.path
                  if (created) {
                    setSelected(created)
                    savePrefs({ lastFile: created })
                  }
                }
              },
            }, busy ? '正在忙，请稍后' : '＋ 写一篇新文章'),
            h('div', {
              style: { fontSize: 11, color: C.label3, marginTop: 4, marginBottom: 8, lineHeight: 1.4 },
            }, '提示：本插件主打 AI 调用（`wxmp` 工具），人工点此仅作兜底新建空稿。'),
            // 从链接导入：给"看到好文章想收藏/改写"的场景一个入口。
            // 放在新建下面而不是藏进设置里 —— 它和"新建"是同一类动作（产出 .md）。
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '从公众号链接导入文章',
              style: { ...btn('ghost'), width: '100%', marginTop: 8 },
              onClick: () => setImportOpen((v) => !v),
              'aria-expanded': importOpen,
            }, importOpen ? '▾ 从链接导入' : '▸ 从链接导入'),
            importOpen
              ? h('div', { style: { marginTop: 8 } },
                  h('label', {
                    htmlFor: 'wxmp-import-url',
                    style: { display: 'block', fontSize: 11, color: C.label3, marginBottom: 5 },
                  }, '公众号文章链接（mp.weixin.qq.com/s/...）'),
                  h('textarea', {
                    id: 'wxmp-import-url',
                    value: importUrl,
                    rows: 2,
                    placeholder: '粘贴链接；批量时一行一个',
                    onChange: (event) => {
                      setImportUrl(event.target.value)
                      savePrefs({ importUrl: event.target.value })
                    },
                    className: 'wxmp-focus',
                    'aria-describedby': 'wxmp-import-help',
                    style: {
                      width: '100%',
                      boxSizing: 'border-box',
                      resize: 'vertical',
                      minHeight: 48,
                      padding: '7px 9px',
                      borderRadius: 8,
                      border: `1px solid ${C.border2}`,
                      background: C.base,
                      color: C.label1,
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      fontFamily: FONT,
                    },
                  }),
                  h('div', {
                    id: 'wxmp-import-help',
                    style: { fontSize: 10.5, color: C.label3, marginTop: 5, lineHeight: 1.6 },
                  }, '只接受 mp.weixin.qq.com 的链接。导入的正文会保留标题/作者/来源，可直接体检和发布。'),
                  h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
                    h('button', {
                      type: 'button',
                      className: 'wxmp-btn wxmp-focus',
                      style: { ...btn('primary'), flex: 1 },
                      disabled: Boolean(busy) || importBusy || !importUrl.trim(),
                      onClick: () => void runImport(),
                    }, importBusy ? '导入中…' : '导入'),
                    h('button', {
                      type: 'button',
                      className: 'wxmp-btn wxmp-focus',
                      style: btn('ghost'),
                      disabled: importBusy || !importUrl.trim(),
                      onClick: () => setImportUrl(''),
                    }, '清空'),
                  ),
                  importResult
                    ? h('div', {
                        role: 'status',
                        'aria-live': 'polite',
                        // T9-4：这个框限高 160 且会滚，之前没挂 wxmp-scroll —— 导入长结果时
                        // 滚动条跟它没关系，用户只能靠滚轮盲猜还有内容
                        className: 'wxmp-scroll',
                        style: {
                          marginTop: 8,
                          padding: '7px 9px',
                          borderRadius: 8,
                          background: C.l3,
                          border: `1px solid ${importResult.failed ? WARN : C.border1}`,
                          fontSize: 10.5,
                          color: C.label2,
                          lineHeight: 1.7,
                          maxHeight: 160,
                          overflowY: 'auto',
                        },
                      }, importResult.text)
                    : null,
                )
              : null,
          ),

          // 左/中之间的拖拽条
          stacked
            ? null
            : h(ColumnResizer, {
                width: leftWidth,
                min: 160,
                max: 520,
                label: '文章列表',
                onChange: (next) => {
                  setLeftWidth(next)
                  saveColumnWidths({ leftWidth: next })
                },
                onReset: () => {
                  setLeftWidth(248)
                  saveColumnWidths({ leftWidth: 248 })
                },
              }),

          // 中：预览
          h(
            'div',
            { className: 'wxmp-scroll', style: { ...colStyle, borderRight: 'none' } },
            h(SectionTitle, {
              extra: h('button', {
                type: 'button',
                className: 'wxmp-btn wxmp-focus',
                'aria-pressed': mobilePreview ? 'true' : 'false',
                'aria-label': mobilePreview ? '关闭手机宽屏模拟（切回桌面宽度）' : '开启手机宽屏模拟（按 375px 显示）',
                title: mobilePreview
                  ? '现在是手机宽屏模拟：点一下切回桌面宽度'
                  : '点一下按手机宽度（375px）预览，检查排版会不会挤',
                style: {
                  // 关闭态原来用 ghost（透明底），在深色背景上根本看不见 —— 改 normal，有底色才找得到
                  ...btn(mobilePreview ? 'primary' : 'normal'),
                  fontSize: 11,
                  padding: '4px 12px',
                  borderRadius: 14,
                  minHeight: 32,
                  textTransform: 'none',
                  letterSpacing: 0,
                  fontWeight: 500,
                },
                onClick: () => {
                  const next = !mobilePreview
                  setMobilePreview(next)
                  savePrefs({ mobilePreview: next })
                  // 操作必须有反馈：切换后 toast 说清现在是什么模式
                  notify(next ? '已切到手机宽屏模拟（375px）' : '已切回桌面宽度', 'ok')
                },
              }, mobilePreview ? '📱 手机模式' : '🖥️ 桌面模式'),
            }, '预览'),
            detailErr ? h(ErrorBox, { error: detailErr, onRetry: () => setSelected(selected), onDiagnose: () => void collectDiagnostics() }) : null,
            detailBusy
              ? h('div', null, h(Skeleton, { height: 200, radius: 12 }), h(Skeleton, { height: 16 }), h(Skeleton, { height: 16 }), h(Skeleton, { height: 16, width: '60%' }))
              : selected && article
                ? h(
                    'div',
                    {
                      style: {
                        border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden',
                        background: '#fff', color: '#1a1a1a',
                        // 手机宽屏模拟：限制宽度、居中显示，模拟在手机上看的效果
                        maxWidth: mobilePreview ? 375 : '100%',
                        margin: mobilePreview ? '0 auto' : 0,
                        boxShadow: mobilePreview ? '0 4px 20px rgba(0,0,0,.15)' : 'none',
                      },
                    },
                    // 封面：真图，不是一个绿色占位框。
                    // <img> 不能发 POST，所以走 GET /api/wxmp/cover?f=…（后端已收敛到文章目录内）。
                    // 用 mtime 做 query，重新生成封面后能立刻刷新，不吃浏览器缓存。
                    article.cover
                      ? h('img', {
                          src: `${API}/cover?f=${encodeURIComponent(article.cover)}&v=${coverV}`,
                          alt: `封面：${article.title}`,
                          'aria-label': `封面：${article.title}`,
                          style: { display: 'block', width: '100%', aspectRatio: '2.35 / 1', objectFit: 'cover', background: C.l2 },
                          onError: (event) => {
                            // 图取不到要说清是哪种失败，而不是留一个破图
                            event.currentTarget.style.display = 'none'
                            if (event.currentTarget.nextSibling) {
                              event.currentTarget.nextSibling.style.display = 'grid'
                            }
                          },
                        })
                      : null,
                    h(
                      'div',
                      {
                        style: {
                          aspectRatio: article.cover ? undefined : '2.35 / 1',
                          display: article.cover ? 'none' : 'grid',
                          placeItems: 'center',
                          background: `linear-gradient(135deg,${C.brand},#059b4c)`,
                          color: '#fff', fontSize: 12, textAlign: 'center', padding: 12, lineHeight: 1.6,
                        },
                        'aria-hidden': article.cover ? 'true' : 'false',
                      },
                      article.cover
                        ? `封面读取失败：${article.cover}\n点「重新生成封面」会重建并自动写回`
                        : '这篇还没有封面 — 点顶栏「重新生成封面」',
                    ),
                    h(
                      'div',
                      { style: { padding: '18px 18px 26px', fontSize: 13.5, lineHeight: 1.8 } },
                      h('div', { style: { fontSize: 19, fontWeight: 700, lineHeight: 1.45, marginBottom: 8 } }, article.title),
                      /* 作者行：可改。
                       * 以前这里是纯文本 `article.author`，用户看到封面上顶着个旧名字
                       * 却没有任何地方能改 —— 只能拿编辑器去翻 .md 的 front matter。
                       * 现在点「改」就地编辑，保存/清空都走同一个 CLI 子命令。 */
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: '#999', marginBottom: 12, minHeight: 32 } },
                        authorEditing
                          ? [
                              h('label', { key: 'lbl', htmlFor: 'wxmp-author-input', style: { color: '#888' } }, '作者'),
                              h('input', {
                                key: 'inp',
                                id: 'wxmp-author-input',
                                className: 'wxmp-focus',
                                type: 'text',
                                maxLength: 16,
                                value: authorInput,
                                placeholder: '留空 = 不显示作者',
                                'aria-label': '作者名，最多 16 字',
                                autoFocus: true,
                                onChange: (event) => setAuthorInput(event.target.value),
                                onKeyDown: (event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void applyAuthor(authorInput)
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setAuthorEditing(false)
                                    setAuthorInput('')
                                  }
                                },
                                style: {
                                  width: 160, minHeight: 32, padding: '5px 9px', fontSize: 12,
                                  borderRadius: 6, border: '1px solid #d4d4d4', background: '#fff', color: '#333',
                                  fontFamily: 'inherit',
                                },
                              }),
                              h('button', {
                                key: 'save',
                                type: 'button',
                                className: 'wxmp-btn wxmp-focus',
                                style: btn('accent'),
                                disabled: Boolean(labBusy), // N11：原来只挡 labBusy==='set-author'，别的 lab 任务在跑时仍能点，labBusy 会被后一次覆盖；改成任何 lab 任务在跑都挡住（文案仍按具体任务显示）
                                onClick: () => void applyAuthor(authorInput),
                              }, labBusy === 'set-author' ? '写回中…' : '保存'),
                              h('button', {
                                key: 'clear',
                                type: 'button',
                                className: 'wxmp-btn wxmp-focus',
                                style: btn('normal'),
                                disabled: Boolean(labBusy) || !article.author, // N11：同上一处（作者写回钮）
                                title: '清空作者名：封面副标题、预览页、这个面板三处都不再出现它',
                                onClick: () => void applyAuthor(''),
                              }, '清空'),
                              h('button', {
                                key: 'cancel',
                                type: 'button',
                                className: 'wxmp-btn wxmp-focus',
                                style: btn('normal'),
                                disabled: Boolean(labBusy), // N11：原来只挡 labBusy==='set-author'，别的 lab 任务在跑时仍能点，labBusy 会被后一次覆盖；改成任何 lab 任务在跑都挡住（文案仍按具体任务显示）
                                onClick: () => { setAuthorEditing(false); setAuthorInput('') },
                              }, '取消'),
                              h('span', { key: 'hint', style: { color: '#aaa' } }, '最多 16 字'),
                            ]
                          : [
                              h('span', { key: 'lbl', style: { color: '#888' } }, '作者'),
                              h('span', { key: 'val', style: { color: article.author ? '#666' : '#bbb' } }, article.author || '未设置'),
                              article.author
                                ? h('span', { key: 'note', style: { color: '#aaa' } }, '（封面副标题与预览页也读这一行）')
                                : null,
                              h('button', {
                                key: 'edit',
                                type: 'button',
                                className: 'wxmp-btn wxmp-focus',
                                style: { ...btn('normal'), fontSize: 11, minHeight: 32 },
                                title: article.author
                                  ? '改作者名 —— 封面副标题、预览页会跟着变'
                                  : '设置作者名（会显示在封面副标题和预览页）',
                                onClick: () => { setAuthorInput(article.author || ''); setAuthorEditing(true) },
                              }, article.author ? '✏️ 改' : '✏️ 设置'),
                            ],
                      ),
                      h('div', { style: { background: '#f7f7f7', borderRadius: 6, padding: '9px 11px', fontSize: 12, color: '#666', marginBottom: 14 } }, article.digest || '（无摘要）'),
                      /* 封面素材缓存状态。
                       * 每次 draft create/update 都会处理封面，而微信的 add_material 是
                       * 「每调一次就多一条永久素材」，且永久素材要在后台逐条删。
                       * 这里把「这条封面素材已经记下来了 / 还没记」直接摆出来，
                       * 用户不用自己去翻 .md 的 front matter，也不用凭素材列表的条数猜。 */
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: '#999', marginBottom: 12 } },
                        h('span', { style: { color: '#888' } }, '封面素材'),
                        article.thumbMediaId
                          ? h('span', { style: { color: '#666' } }, article.thumbMediaId)
                          : h('span', { style: { color: '#bbb' } }, '未缓存'),
                        h('span', { style: { color: '#aaa' } },
                          article.thumbMediaId
                            ? '（封面没变就复用它，不会重复上传）'
                            : '（下次建草稿/更新会新建一条永久素材）'),
                      ),
                      /* 1.8.1：本地文件路径常驻行。以前路径只在生成预览后的 toast 里
                       * 闪一次，想去改 .md 只能凭记忆猜目录；现在每篇都钉在卡片上，
                       * 点一下复制全路径（含文件名），直接粘进编辑器/命令行都行。
                       * 路径来自 article-show 的 articleSummary（data.article.article.path）。 */
                      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: '#999', marginBottom: 12 } },
                        h('span', { style: { color: '#888', flexShrink: 0 } }, '文件路径'),
                        h('span', {
                          style: {
                            color: '#666', fontFamily: 'Consolas, Menlo, monospace', fontSize: 11,
                            wordBreak: 'break-all', cursor: article.path ? 'pointer' : 'default', flex: 1, minWidth: 0,
                          },
                          title: article.path ? `点击复制完整路径：${article.path}` : '路径未知（文章可能还没保存过）',
                          onClick: async () => {
                            if (!article.path) return
                            try {
                              await navigator.clipboard.writeText(article.path)
                              notify('文件路径已复制', 'ok', 2200)
                            } catch {
                              // 复制失败（http 页面/权限拒绝）不静默：路径就钉在面板上，指个路
                              notify('浏览器拒绝了复制权限 —— 路径就在「文件路径」一行，手动选中复制即可', 'warn', 6000)
                            }
                          },
                        }, article.path || '（未知）'),
                      ),
                      // 正文：显示真实字数 + 开头一段，不再显示「正文 0 字符」这种骗人数据
                      h('div', { style: { color: '#666', fontSize: 12, marginBottom: 8 } },
                        `正文 ${article.bodyChars != null ? article.bodyChars : String(article.body || '').length} 字符 · 主题 ${article.theme || 'default'}`),
                      article.body
                        ? h('div', { style: { fontSize: 12.5, color: '#444', lineHeight: 1.85, whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto' }, className: 'wxmp-scroll' },
                            article.body.slice(0, 600) + (article.body.length > 600 ? '\n…' : ''))
                        : null,
                      h('div', { style: { marginTop: 12, color: '#999', fontSize: 11.5 } }, '完整排版点下方「🌐 打开本地预览」，生成后自动在默认浏览器打开；要改稿子用「📄 打开文件」。'),
                    ),
                  )
                : h('div', { style: { color: C.label3, fontSize: 12, padding: '20px 0' } }, '左边选一篇文章就能看到预览。'),
            selected && article
              ? h(
                  'div',
                  { style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  // 1.8.1：open:true → 后端给 CLI 追加 --open，HTML 生成后直接默认浏览器打开，
                  // 不再「只生成、路径一闪而过」。
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    // W5-R2：预览钮原来没有 disabled，进行中重复点会被静默丢弃（只有 notify 兜底）。
                    // 补上 disabled；minWidth 让「正在生成…」比「打开本地预览」短时不跳宽度。
                    style: { ...btn('primary'), minWidth: 150 },
                    disabled: Boolean(busy),
                    onClick: async () => {
                      const outcome = await runAction('preview', 'preview-article', { file: selected, open: true }, 'article preview --open')
                      if (outcome && outcome.ok && outcome.data && outcome.data.path) {
                        notify(`预览已生成并在浏览器打开：${outcome.data.path}`, 'ok', 5000)
                      }
                    },
                  }, busy === 'preview' ? '正在生成…' : '🌐 打开本地预览'),
                  // 快捷打开三兄弟的后两个：文件夹用资源管理器定位（explorer /select），
                  // 文件交给系统默认 .md 程序。判定与打开都在后端（open-article 本地 op）。
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn',
                    style: btn('normal'),
                    disabled: Boolean(busy),
                    onClick: () => runAction('open-folder', 'open-article', { file: selected, what: 'folder' }, 'open-article（所在文件夹）'),
                  }, busy === 'open-folder' ? '正在打开…' : '📂 所在文件夹'),
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn',
                    style: btn('normal'),
                    disabled: Boolean(busy),
                    onClick: () => runAction('open-file', 'open-article', { file: selected, what: 'file' }, 'open-article（打开文件）'),
                  }, busy === 'open-file' ? '正在打开…' : '📄 打开文件'),
                )
              : null,
          ),

          // 中/右之间的拖拽条（右栏收起时不渲染，因为那时候没有可拖的东西）
          stacked || railCollapsed
            ? null
            : h(ColumnResizer, {
                width: railWidth,
                min: 220,
                max: 560,
                label: '右侧面板',
                onChange: (next) => {
                  setRailWidth(next)
                  saveColumnWidths({ railWidth: next })
                },
                onReset: () => {
                  setRailWidth(286)
                  saveColumnWidths({ railWidth: 286 })
                },
              }),

          // 右：状态 + 流水线（可折叠）
          // 收起态：整栏只剩这一条。
          // 以前它是 44px、透明底的竖排 ghost 按钮，跟背景一个颜色 ——
          // 用户收起右栏之后根本认不出这是"还能点开的开关"，只觉得"栏目不见了"。
          // 现在给它底色 + 边框 + normal 变体，一眼能看出是个控件。
          railCollapsed
            ? h('div', { style: { width: 52, flex: 'none', borderLeft: `1px solid ${C.border1}`, background: C.l1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 14 } },
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '展开右侧栏（字数统计、打分预设、写作辅助）',
                  'aria-expanded': false,
                  title: '展开右侧栏 —— 里面有字数统计、打分预设、写作辅助',
                  style: { ...btn('normal'), writingMode: 'vertical-rl', padding: '14px 10px', minWidth: 40, minHeight: 32, fontSize: 11.5 },
                  onClick: () => { setRailCollapsed(false); savePrefs({ railCollapsed: false }) },
                }, '◂ 展开右栏'))
            : h(
                'div',
                { className: 'wxmp-scroll', style: { width: railWidth, minWidth: 220, maxWidth: 560, borderLeft: `1px solid ${C.border1}`, padding: 14, overflowY: 'auto', minHeight: 0 } },
                // ── 状态：默认折叠 ──────────────────────────────
                // 以前 4 个数字卡片常驻在顶部，占掉右栏近三分之一高度，
                // 把「体检」和「打分预设」这些高频功能挤到要滚动才看得见。
                // 现在默认收起，只在标题行显示一行摘要（标题/正文接近上限时才标色提醒）。
                h(SectionTitle, {
                  extra: h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                    h('button', {
                      type: 'button',
                      className: 'wxmp-btn wxmp-focus',
                      'aria-label': statsOpen ? '收起字数统计' : '展开字数统计',
                      'aria-expanded': statsOpen,
                      style: { ...btn('ghost'), padding: '6px 10px', fontSize: 11, minHeight: 32 },
                      onClick: () => setStatsOpen((v) => { const next = !v; savePrefs({ statsOpen: next }); return next }),
                    }, statsOpen ? '收起' : '展开'),
                    // 整栏收起入口：删掉它用户就再也收不起来了（这栏只有 286px，收起能多给预览区空间）
                    h('button', {
                      type: 'button',
                      className: 'wxmp-btn wxmp-focus',
                      'aria-label': '收起整个右侧栏，给预览更多宽度',
                      'aria-expanded': true,
                      style: { ...btn('ghost'), padding: '6px 10px', fontSize: 11, minWidth: 32, minHeight: 32 },
                      onClick: () => { setRailCollapsed(true); savePrefs({ railCollapsed: true }) },
                    }, '✕'),
                  ),
                }, '字数与体积'),
                // 收起态也保有一行摘要：完全看不到关键数字会让人心里没底
                report
                  ? h('div', { style: { fontSize: 11.5, color: C.label3, marginBottom: statsOpen ? 10 : 14, lineHeight: 1.6 } },
                      h('span', null, `标题 ${report.limits.title[0]}/${report.limits.title[1]}`),
                      h('span', { style: { margin: '0 6px', opacity: 0.5 } }, '·'),
                      h('span', null, `正文 ${report.limits.contentChars[0]}`),
                      h('span', { style: { margin: '0 6px', opacity: 0.5 } }, '·'),
                      h('span', {
                        style: {
                          color: report.limits.contentBytes[0] / 1024 > 800 ? WARN : C.label3,
                        },
                      }, `${Math.round(report.limits.contentBytes[0] / 1024)} KB`),
                    )
                  : null,

                statsOpen && report
                  ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 } },
                      ...[
                        ['标题', report.limits.title],
                        ['摘要', report.limits.digest],
                        ['正文', report.limits.contentChars],
                        ['体积', [Math.round(report.limits.contentBytes[0] / 1024), 1024]],
                      ].map(([label, pair]) => {
                        const used = pair ? pair[0] : 0
                        const max = pair ? pair[1] : 1
                        const ratio = used / max
                        const tone = ratio >= 1 ? DANGER : ratio > 0.8 ? WARN : C.brand
                        return h('div', { key: label, style: { border: `1px solid ${C.border1}`, borderRadius: 9, background: C.l3, padding: '8px 9px' } },
                          h('div', { style: { fontSize: 10.5, color: C.label3, marginBottom: 2 } }, label),
                          h('div', { style: { fontSize: 12, fontWeight: 600, color: tone } }, `${used} / ${max}`),
                        )
                      }))
                  : null,

                // ── 预设管理：面板上的一等公民 ──────────────────
                // 之前放在「体检」区块下面，被分数和问题列表挤到看不见 ——
                // 用户找不到导入导出，就等于这个功能不存在。所以提到最前面，
                // 并给它自己的标题、当前预设名、和一行说明。
                // 「打分预设」改成可拖动/可缩放的悬浮窗（用户要求）。
                // 右栏只留一个入口 + 当前预设名 —— 关掉浮窗也知道现在用的是哪个标准。
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 } },
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-expanded': presetOpen,
                    'aria-label': '打开打分预设悬浮窗（可拖动、可调整大小）',
                    title: '打开后可拖动标题栏移动、拖右下角调整大小（顶栏的「🎯 打分预设」是同一个入口）',
                    style: { ...btn('normal'), padding: '5px 10px', fontSize: 11.5, minHeight: 30 },
                    onClick: () => {
                      const next = !presetOpen
                      setPresetOpen(next)
                      savePrefs({ presetOpen: next })
                    },
                  }, presetOpen ? '打分预设 ▾' : '打分预设 ▸'),
                  h('span', { style: { fontSize: 11, color: C.label3, flex: 1, minWidth: 0 } },
                    h('strong', { style: { color: C.label2 } }, currentPreset || '未选择')),
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-label': '重新读取预设列表',
                    disabled: presetsBusy,
                    style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
                    onClick: () => void refreshPresets(),
                  }, presetsBusy ? '…' : '刷新'),
                ),
                h('div', { style: { height: 1, background: C.border1, margin: '14px 0' } }),
                /* ── 写作辅助（标题 / 骨架 / 任务书）──────────────
                 * 放在体检之前：体检是"写完之后检查"，这三样是"写之前/写之中帮忙"。
                 * 三个面板互斥展开，避免右栏同时铺开太多内容。
                 */
                h(SectionTitle, { extra: selected ? null : h('span', { style: { fontSize: 10.5, color: C.label3 } }, '需先选文章') }, '写作辅助'),
                h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
                  ...[
                    ['titles', '起标题'],
                    ['outline', '结构骨架'],
                    ['brief', '写作任务书'],
                    ['images', '素材配图'],
                  ].map(([key, label]) =>
                    h('button', {
                      key,
                      type: 'button',
                      className: 'wxmp-btn wxmp-focus',
                      'aria-expanded': labOpen === key,
                      style: { ...btn(labOpen === key ? 'primary' : 'normal'), padding: '5px 11px', fontSize: 11, minHeight: 32 },
                      onClick: () => setLabOpen((prev) => (prev === key ? '' : key)),
                    }, label),
                  ),
                ),

                // 标题面板
                labOpen === 'titles'
                  ? h('div', { style: makeLabPanelStyle() },
                      h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.7, marginBottom: 8 } },
                        '机械候选是半成品起点，真正好的标题在任务书里生成。选中一个可直接写回。'),
                      h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        style: { ...btn('primary'), width: '100%', marginBottom: 8 },
                        // N11 lab-concurrency-guard-narrow：原来只挡 labBusy==='title-lab'，
                        // 骨架/任务书/配图在跑时仍能并发点标题 → labBusy 会被后一次覆盖。
                        // 改成任何一个 lab 任务在跑都挡住（文案仍按具体任务显示）。
                        disabled: Boolean(busy) || Boolean(labBusy) || !selected,
                        onClick: () => void runLab('title-lab', { file: selected }),
                      }, labBusy === 'title-lab' ? '生成中…' : '生成标题候选'),
                      labResult.titles
                        ? h('div', { className: 'wxmp-scroll', style: { whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', fontFamily: MONO, fontSize: 10.5, background: C.base, padding: 8, borderRadius: 8, border: `1px solid ${C.border1}`, color: C.label2, lineHeight: 1.7 } },
                            labResult.titles.text || '')
                        : null,
                      h('label', {
                        htmlFor: 'wxmp-title-input',
                        style: { display: 'block', fontSize: 10.5, color: C.label3, margin: '10px 0 4px' },
                      }, '或直接写一个标题'),
                      h('input', {
                        id: 'wxmp-title-input',
                        type: 'text',
                        value: titleInput,
                        placeholder: '≤ 26 字，前 10 字要有钩子',
                        onChange: (event) => {
                          setTitleInput(event.target.value)
                          savePrefs({ titleInput: event.target.value })
                        },
                        className: 'wxmp-focus',
                        style: { ...inputStyle, fontSize: 11.5, padding: '6px 9px' },
                      }),
                      h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        style: { ...btn('normal'), width: '100%', marginTop: 6 },
                        // N11：同上一处，任何 lab 任务进行中都挡住，避免并发覆盖 labBusy
                        disabled: Boolean(busy) || !selected || !titleInput.trim() || Boolean(labBusy),
                        onClick: () => void applyTitle(titleInput.trim()),
                      }, labBusy === 'set-title' ? '写回中…' : '写回这个标题'),
                    )
                  : null,

                // 骨架面板
                labOpen === 'outline'
                  ? h('div', { style: makeLabPanelStyle() },
                      h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.7, marginBottom: 8 } },
                        '按文体列出该有哪些小节，并标出你已经写了哪些。提示是注释，不会进正文。'),
                      h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
                        ...['', 'tutorial', 'comparison', 'case', 'explainer'].map((form) =>
                          h('button', {
                            key: form || 'auto',
                            type: 'button',
                            className: 'wxmp-btn wxmp-focus',
                            style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
                            disabled: Boolean(busy) || !selected || Boolean(labBusy),
                            onClick: () => void runLab('outline-lab', { file: selected, ...(form ? { form } : {}) }),
                          }, form === '' ? '自动识别' : ({
                            tutorial: '教程', comparison: '对比', case: '案例', explainer: '解释',
                          })[form]),
                        ),
                      ),
                      labBusy === 'outline-lab' ? h('div', { style: { fontSize: 11, color: C.label3 } }, '分析中…') : null,
                      labResult.outline
                        ? h('div', { className: 'wxmp-scroll', style: { whiteSpace: 'pre-wrap', maxHeight: 280, overflowY: 'auto', fontFamily: MONO, fontSize: 10.5, background: C.base, padding: 8, borderRadius: 8, border: `1px solid ${C.border1}`, color: C.label2, lineHeight: 1.7 } },
                            labResult.outline.text || '')
                        : null,
                    )
                  : null,

                // 任务书面板
                labOpen === 'brief'
                  ? h('div', { style: makeLabPanelStyle() },
                      h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.7, marginBottom: 8 } },
                        '把写作流程变成一张作业单：先搜什么、按什么结构写、标题往哪个方向起、写完自查什么。'),
                      h('input', {
                        type: 'text',
                        value: briefTopic,
                        placeholder: '主题（留空则用当前文章标题）',
                        onChange: (event) => {
                          setBriefTopic(event.target.value)
                          savePrefs({ briefTopic: event.target.value })
                        },
                        className: 'wxmp-focus',
                        style: { ...inputStyle, fontSize: 11.5, padding: '6px 9px', marginBottom: 6 },
                        'aria-label': '写作主题',
                      }),
                      h('select', {
                        value: briefForm,
                        onChange: (event) => {
                          setBriefForm(event.target.value)
                          savePrefs({ briefForm: event.target.value })
                        },
                        className: 'wxmp-focus',
                        style: { ...inputStyle, fontSize: 11.5, padding: '6px 9px', marginBottom: 8, cursor: 'pointer' },
                        'aria-label': '文体',
                      },
                        h('option', { value: '' }, '自动选文体'),
                        h('option', { value: 'tutorial' }, '教程'),
                        h('option', { value: 'comparison' }, '对比'),
                        h('option', { value: 'case' }, '案例'),
                        h('option', { value: 'explainer' }, '百科式解释'),
                      ),
                      h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        style: { ...btn('primary'), width: '100%' },
                        disabled: Boolean(busy) || Boolean(labBusy), // N11：保留原有 Boolean(busy) 前缀，另把窄守卫 labBusy==='writing-brief' 放宽
                        onClick: () => void runLab('writing-brief', {
                          topic: briefTopic.trim() || (detail && detail.article && detail.article.title) || '未命名主题',
                          ...(briefForm ? { form: briefForm } : {}),
                        }),
                      }, labBusy === 'writing-brief' ? '生成中…' : '生成任务书'),
                      labResult.brief
                        ? h('div', { className: 'wxmp-scroll', style: { whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto', fontFamily: MONO, fontSize: 10.5, background: C.base, padding: 8, borderRadius: 8, border: `1px solid ${C.border1}`, color: C.label2, lineHeight: 1.7, marginTop: 8 } },
                            labResult.brief.text || '')
                        : null,
                    )
                  : null,

                // 素材配图面板：从公众号后台素材库选图，按内容语义给位置
                labOpen === 'images'
                  ? h('div', { style: makeLabPanelStyle() },
                      h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.7, marginBottom: 8 } },
                        '直接读公众号后台的图片素材库，按正文内容匹配位置。图片用 mmbiz 直链，发布时不会被过滤。'),
                      h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          style: { ...btn('normal'), flex: 1, padding: '6px 8px', fontSize: 11, minHeight: 32 },
                          disabled: Boolean(labBusy),
                          onClick: () => void runLab('material-library', { usable: true }),
                        }, labBusy === 'material-library' ? '读取中…' : '看素材库'),
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          style: { ...btn('primary'), flex: 1, padding: '6px 8px', fontSize: 11, minHeight: 32 },
                          disabled: Boolean(busy) || !selected || Boolean(labBusy),
                          onClick: () => void runLab('illustrate', { file: selected }),
                        }, labBusy === 'illustrate' ? '分析中…' : '分析插图位置'),
                      ),
                      labResult.images
                        ? h('div', { className: 'wxmp-scroll', style: { whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto', fontFamily: MONO, fontSize: 10.5, background: C.base, padding: 8, borderRadius: 8, border: '1px solid ' + C.border1, color: C.label2, lineHeight: 1.7 } },
                            labResult.images.text || '')
                        : null,
                      // 只有分析出建议时才显示"写进文章"：避免用户在没有建议时点出一个空操作
                      labResult.images && labResult.images.data && (labResult.images.data.suggestions || []).length
                        ? h('button', {
                            type: 'button',
                            className: 'wxmp-btn wxmp-focus',
                            style: { ...btn('normal'), width: '100%', marginTop: 8 },
                            disabled: Boolean(busy) || Boolean(labBusy),
                            onClick: () => void runLab('illustrate', { file: selected, apply: true }),
                          }, '把这些图写进文章')
                        : null,
                      h('div', { style: { fontSize: 10, color: C.label3, marginTop: 8, lineHeight: 1.6 } },
                        '匹配靠文件名。后台里叫「粘贴图片_2024…」的图读不出内容，建议改成「架构图-插件加载」这类名字。'),
                    )
                  : null,

                h('div', { style: { height: 1, background: C.border1, margin: '16px 0 14px' } }),

                h(SectionTitle, {
                  extra: h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-label': '重新计算当前文章的体检分数',
                    disabled: Boolean(busy) || !selected,
                    style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
                    onClick: () => void runReview(),
                  }, reviewBusy ? '计算中…' : '重新体检'),
                }, '体检 · 写得好不好'),
                reviewErr
                  ? h(ErrorBox, { error: reviewErr, onRetry: () => void runReview(), onDiagnose: () => void collectDiagnostics() })
                  : reviewBusy
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 } },
                        h(Skeleton, { height: 40, radius: 10 }),
                        h(Skeleton, { height: 14, width: '70%' }),
                      )
                    : reviewReport
                      ? h('div', { style: { marginBottom: 16 } },
                          // 分数条：一眼看到「离及格还差多少」
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
                            h('div', {
                              style: {
                                fontSize: 26, fontWeight: 700, lineHeight: 1,
                                color: reviewReport.pass ? C.brand : reviewReport.score >= 70 ? WARN : DANGER,
                              },
                            }, String(reviewReport.score)),
                            h('div', { style: { fontSize: 11.5, color: C.label3, lineHeight: 1.5 } },
                              h('div', null, `等级 ${reviewReport.grade} · 及格线 ${reviewReport.thresholds.passScore} · ${reviewReport.pass ? '达标' : '未达标'}`),
                              h('div', null, `预设 ${reviewReport.preset ? reviewReport.preset.name : '—'}`)),
                            presets.length > 1
                              ? h('select', {
                                  'aria-label': '切换体检预设（打分标准）',
                                  className: 'wxmp-focus',
                                  value: currentPreset,
                                  disabled: Boolean(busy) || presetsBusy,
                                  onChange: (event) => void usePreset(event.target.value),
                                  style: {
                                    marginLeft: 'auto', minHeight: 32, padding: '4px 8px',
                                    background: C.l3, color: C.label1, border: `1px solid ${C.border1}`,
                                    borderRadius: 8, font: 'inherit', fontSize: 11.5,
                                  },
                                }, ...presets.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
                              : null,
                          ),
                          // 分项条：哪个维度在扣分一目了然
                          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                            ...CATEGORY_LABELS.map(([key, label]) => {
                              const got = reviewReport.breakdown[key]
                              const full = reviewReport.weights[key]
                              const pct = full ? Math.round((got / full) * 100) : 0
                              return h('div', { key, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 } },
                                h('span', { style: { width: 34, color: C.label3, flex: 'none' } }, label),
                                h('div', { style: { flex: 1, height: 6, background: C.l2, borderRadius: 99, overflow: 'hidden' }, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${label}得分 ${got}/${full}` },
                                  h('div', { style: { width: `${pct}%`, height: '100%', background: pct >= 80 ? C.brand : pct >= 50 ? WARN : DANGER, borderRadius: 99 } })),
                                h('span', { style: { width: 44, textAlign: 'right', color: C.label3, flex: 'none' } }, `${got}/${full}`))
                            }),
                          ),
                          reviewReport.findings.length
                            ? h('div', { className: 'wxmp-scroll', style: { marginTop: 10, maxHeight: 210, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 } },
                                ...reviewReport.findings.slice(0, 12).map((item, index) =>
                                  h('div', {
                                    key: item.code + index,
                                    style: {
                                      padding: '6px 9px', borderRadius: 8, border: `1px solid ${C.border1}`,
                                      background: C.l1, fontSize: 11.5, lineHeight: 1.6,
                                    },
                                  },
                                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                                    h('span', { style: { color: item.level === 'error' ? DANGER : item.level === 'warn' ? WARN : C.label3, fontWeight: 600, flex: 'none' } },
                                      item.level === 'error' ? '✘' : item.level === 'warn' ? '!' : 'i'),
                                    h('span', { style: { flex: 'none', fontFamily: MONO, color: C.label3 } }, item.line ? `L${item.line}` : '—'),
                                    h('span', { style: { flex: 1, minWidth: 0, color: C.label2 } }, item.message)),
                                  h('div', { style: { marginTop: 3, paddingLeft: 20, color: C.label3 } }, `改法：${item.suggest}`)),
                                ),
                                reviewReport.findings.length > 12
                                  ? h('div', { style: { fontSize: 11, color: C.label3, padding: '2px 4px' } }, `还有 ${reviewReport.findings.length - 12} 条未显示，用 wxmp article review 看全部`)
                                  : null,
                              )
                            : h('div', { style: { marginTop: 10, fontSize: 11.5, color: C.brand } }, '没有发现问题：结构、密度、素材都过线。'),
                        )
                      : h('div', { style: { fontSize: 11.5, color: C.label3, marginBottom: 14, lineHeight: 1.7 } },
                          '选一篇文章，再点「重新体检」——这里会显示 0~100 分、分项得分，以及每条问题在原文的哪一行、怎么改。'),


                h(SectionTitle, null, '发布前检查'),
                report
                  ? h('ul', { style: { listStyle: 'none', margin: '0 0 14px', padding: 0 } },
                      ...issues.map((item, index) => h('li', { key: 'e' + index, style: checkRowStyle }, h('span', { style: { color: DANGER } }, '✘'), h('span', { style: { flex: 1, minWidth: 0 } }, `${item.field}：${item.message}`))),
                      ...warnings.map((item, index) => h('li', { key: 'w' + index, style: checkRowStyle }, h('span', { style: { color: WARN } }, '!'), h('span', { style: { flex: 1, minWidth: 0 } }, `${item.field}：${item.message}`))),
                      issues.length === 0 && warnings.length === 0
                        ? h('li', { style: checkRowStyle }, h('span', { style: { color: C.brand } }, '✔'), h('span', { style: { flex: 1 } }, '全部通过'))
                        : null,
                    )
                  : h(Skeleton, { height: 14, width: '80%' }),

                h(SectionTitle, {
                  extra: h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-expanded': stageOpen,
                    'aria-label': stageOpen ? '收起流水线' : '展开流水线',
                    style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
                    onClick: () => { setStageOpen((v) => { const next = !v; savePrefs({ stageOpen: next }); return next }) },
                  }, stageOpen ? '收起' : '展开'),
                }, '流水线'),
                stageOpen
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      ...STAGES.map((stage, index) => {
                        const state = index < flow.step ? 'done' : index === flow.step ? 'active' : 'locked'
                        const tone = state === 'done' ? C.brand : state === 'active' ? C.brand : C.label3
                        return h('div', {
                          key: stage.key,
                          style: {
                            border: `1px solid ${state === 'active' ? `color-mix(in srgb, ${C.brand} 62%, ${C.border1})` : C.border1}`,
                            background: state === 'active' ? `color-mix(in srgb, ${C.brand} 6%, ${C.l1})` : C.l1,
                            borderRadius: 9, padding: '8px 10px', opacity: state === 'locked' ? 0.6 : 1,
                          },
                        },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
                          h('span', {
                            style: {
                              width: 17, height: 17, borderRadius: '50%', display: 'grid', placeItems: 'center',
                              fontSize: 10.5, fontWeight: 700,
                              background: state === 'done' ? C.brand : state === 'active' ? `color-mix(in srgb, ${C.brand} 40%, transparent)` : C.l2,
                              color: state === 'done' ? '#07130c' : tone,
                            },
                          }, state === 'done' ? '✔' : String(index + 1)),
                          h('span', { style: { fontSize: 12, fontWeight: state === 'active' ? 600 : 500, color: state === 'locked' ? C.label3 : C.label1 } }, stage.name),
                        ),
                        h('div', { style: { marginLeft: 24, fontSize: 11, color: C.label3, marginTop: 2 } }, stage.desc),
                        )
                      }))
                  : null,

                flow.log.length
                  ? h('div', { className: 'wxmp-scroll', style: { marginTop: 12, border: `1px solid ${C.border1}`, borderRadius: 9, background: '#0d0d10', padding: '8px 10px', fontFamily: MONO, fontSize: 10.5, lineHeight: 1.7, color: '#b9b9bf', maxHeight: 150, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
                      flow.log.join('\n'))
                  : null,
              ),
        ),

        showSettings
          ? h(SettingsModal, {
              onClose: () => setShowSettings(false),
              notify,
              // T9-2：设置页里的三条破坏性操作（清凭据 / 清插件数据 / 清图片 key）
              // 都通过这个入口挂到那个唯一的确认浮层上，不在设置页里另造一个。
              requestConfirm,
              // N3③/W3②：清数据按钮的落点。quiet=true 表示调用方随后自己给结果提示，
              // 这里就不再额外弹一条（一次点击只留一个 toast）。
              onClearData: (quiet) => {
                try { window.localStorage.removeItem(STORE_KEY) } catch { /* 忽略 */ }
                // 浮窗位置/大小也存在 localStorage，但键名是 `${STORE_KEY}:float:*`，
                // 原来只 removeItem(STORE_KEY) 会留下它们 —— 清完界面数据浮窗还停在旧位置。
                try {
                  const doomed = []
                  for (let i = 0; i < window.localStorage.length; i += 1) {
                    const key = window.localStorage.key(i)
                    if (key && key.indexOf(`${STORE_KEY}:`) === 0) doomed.push(key)
                  }
                  doomed.forEach((key) => window.localStorage.removeItem(key))
                } catch { /* 忽略 */ }
                setRailCollapsed(false); setStageOpen(true); setFlow({ step: 0, log: [] })
                if (!quiet) notify('已清除本插件的界面数据', 'ok')
              },
              // 诊断内容搬进独立浮窗后，设置页只需要一个"打开它"的入口
              onOpenDiagnostics: () => void collectDiagnostics(),
              // F10：设置页头部的版本徽章与浮窗标题走同一个 displayVersion，不再各显各的
              version: displayVersion,
              endpoint: API,
              draftCount,
              onRefreshCount: () => void api('state').then((p) => { const o = toOutcome(p); if (o.ok) setDraftCount(o.data.total ?? null) }).catch(() => {}),
              busy,
              runAction,
              runtime,
              runtimeBusy,
              runtimeNote,
              probeRuntime,
              // AI 配图设置：设置页需要当前状态与保存/清空能力
              imageGen,
              saveImageKey,
              clearImageKeys,
              // P15：减少动态效果的开关要能在设置页里改，并且立刻生效（不用刷新）
              reduceMotion,
              onToggleReduceMotion: toggleReduceMotion,
            })
          : null,

        /* ── 打分预设浮窗（可拖动 / 可缩放）─────────────────────
         * 用户要求把它从右栏挪出来做成悬浮窗：预设列表 + 导入导出在
         * 220~560px 的右栏里太挤。浮窗可以拖到任意位置、拉大到任意尺寸，
         * 位置与大小都记进 localStorage。
         *
         * 放在渲染树最外层（不在右栏里）：position:fixed 已经脱离布局，
         * 嵌在右栏里反而会被右栏的 overflow 裁掉。
         */
        presetOpen
          ? h(FloatingPanel, {
              id: 'presets',
              title: '打分预设',
              subtitle: `${presets.length} 个 · 换标准会改变分数`,
              defaultRect: { x: 120, y: 100, w: 420, h: 480 },
              onClose: () => {
                setPresetOpen(false)
                savePrefs({ presetOpen: false })
              },
              footer: h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.6 } },
                '拖动标题栏移动 · 拖右下角调整大小 · Esc 关闭 · 位置会自动记住'),
            },
              // 当前预设
              h('div', { style: { fontSize: 11.5, color: C.label3, lineHeight: 1.65, marginBottom: 10 } },
                h('div', null, '当前：',
                  h('strong', { style: { color: C.label1 } },
                    (presets.find((item) => item.id === currentPreset) || {}).name || currentPreset || '（未选择）')),
                h('div', null, presets.length
                  ? `共 ${presets.length} 个预设，换标准会改变分数`
                  : '预设还没读到；点下面「重新读取」重试'),
                // 1.8.0：预设先是写作提示词，才是打分尺——把完整提示词交给 AI
                h('div', { style: { marginTop: 6 } },
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-label': '复制当前预设的写作提示词',
                    disabled: Boolean(busy) || presetsBusy || !currentPreset,
                    style: { ...btn('normal'), padding: '5px 11px', fontSize: 12 },
                    onClick: () => void copyPresetPrompt(),
                  }, '📋 复制写作提示词'),
                  h('span', { style: { marginLeft: 8, fontSize: 10.5 } },
                    '交给 AI 当写作指令；稿子按它写，体检自然过')),

                // 剪贴板兜底：全文显示，手动复制
                promptPreview
                  ? h('div', {
                      style: { marginTop: 8, border: `1px solid ${C.border1}`, borderRadius: 8, padding: 8, background: C.bg2 || 'rgba(127,127,127,0.08)' },
                    },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                        h('strong', { style: { fontSize: 11, color: C.label1 } }, `写作提示词 · ${promptPreview.name}`),
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          'aria-label': '收起写作提示词全文',
                          style: { ...btn('ghost'), marginLeft: 'auto', padding: '2px 8px', fontSize: 10.5 },
                          onClick: () => setPromptPreview(null),
                        }, '收起')),
                      h('pre', {
                        // select-all 是内置浏览器类：点一下全选，手动 Ctrl+C 即可
                        className: 'wxmp-select-all',
                        style: { margin: 0, fontSize: 10.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', userSelect: 'all' },
                      }, promptPreview.text))
                  : null),

              // 预设列表
              presets.length
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 } },
                    ...presets.map((item) => {
                      /* T9-3 preset-remove-entry：这一行原来只能「切换」，面板里没有任何删除入口 ——
                         op `preset-remove` 一直在（ui-backend.js 里就有），但用户永远调不到，
                         表现就是「这个预设删不掉」。现在给自建预设补上删除按钮，同样走统一确认浮层。
                         谁不给删：source==='builtin' 是内存里的兜底版本（磁盘上没有它的目录，
                         删了必然 not_found）；standard 是宿主硬保护的兜底预设（removePresetDir 直接拒）。
                         其余（含被写盘的内置副本）都给删，删错了还能用「恢复内置」写回来。 */
                      const isBuiltinRow = item.source === 'builtin' || item.id === 'standard'
                      return h('div', {
                        key: item.id,
                        style: { display: 'flex', alignItems: 'stretch', gap: 4 },
                      },
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          'aria-pressed': item.id === currentPreset ? 'true' : 'false',
                          'aria-label': `切换到预设 ${item.name}`,
                          disabled: Boolean(busy) || presetsBusy || item.id === currentPreset,
                          style: {
                            ...btn(item.id === currentPreset ? 'primary' : 'ghost'),
                            // justifyContent 覆盖：预设名要左对齐，居中会让「名字」和「id」并成一行看不清
                            display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8,
                            padding: '7px 10px', fontSize: 12, textAlign: 'left',
                            borderColor: item.id === currentPreset ? C.brand : undefined,
                            // 删除按钮占位后，名字要能被压缩，否则长名字会把这一行挤爆
                            flex: 1, minWidth: 0,
                          },
                          onClick: () => void usePreset(item.id),
                        },
                          h('span', { style: { fontWeight: item.id === currentPreset ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
                          // 1.8.0：有风格提示词的预设标个记号——它不只能打分，还能当写作指令。
                          // 点一下直接复制这个预设的提示词，不用先切换。
                          item.style
                            ? h('button', {
                                key: 'style',
                                type: 'button',
                                className: 'wxmp-btn wxmp-focus',
                                'aria-label': `复制预设 ${item.name} 的写作提示词`,
                                title: '复制这个预设的写作提示词（风格 + 节奏），不用先切换',
                                disabled: Boolean(busy) || presetsBusy,
                                style: { border: 'none', background: 'none', padding: '0 2px', fontSize: 10, lineHeight: 1, cursor: 'pointer', flexShrink: 0 },
                                onClick: () => void copyPresetPrompt(item.id),
                              }, '📝')
                            : null,
                          item.id === currentPreset
                            ? h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: C.brand, flexShrink: 0 } }, '使用中')
                            : null,
                          h('span', { style: { marginLeft: item.id === currentPreset ? 6 : 'auto', fontSize: 10, color: C.label3, flexShrink: 0 } }, item.id),
                        ),
                        isBuiltinRow
                          ? h('span', {
                              key: 'builtin',
                              title: '内置预设不给删（standard 是评分兜底，删了就没有标尺了）',
                              style: { display: 'grid', placeItems: 'center', width: 34, fontSize: 9.5, color: C.label3, border: `1px dashed ${C.border1}`, borderRadius: 8 },
                            }, '内置')
                          : h('button', {
                              key: 'remove',
                              type: 'button',
                              className: 'wxmp-btn wxmp-focus',
                              'aria-label': `删除预设：${item.name}`,
                              title: '删掉本机上的这个预设（内置那几个可以用「恢复内置」写回来）',
                              disabled: Boolean(busy) || presetsBusy,
                              style: { ...btn('ghost'), width: 32, minWidth: 32, minHeight: 32, padding: 0, fontSize: 14, lineHeight: 1 },
                              onClick: () => removePreset(item),
                            }, '🗑'),
                      )
                    },
                    ))
                : h('div', { style: { fontSize: 11.5, color: C.label3, marginBottom: 10 } }, '（没有读到预设）'),

              // 导入 / 导出
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '把当前预设导出成 JSON 文件（下载）',
                  disabled: Boolean(busy) || presetsBusy || !currentPreset,
                  style: { ...btn('normal'), padding: '6px 11px', fontSize: 12, flex: 1, minWidth: 120 },
                  onClick: () => void exportCurrentPreset(),
                }, '↓ 导出预设'),
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '选择 JSON 预设文件导入',
                  disabled: Boolean(busy) || presetsBusy,
                  style: { ...btn('normal'), padding: '6px 11px', fontSize: 12, flex: 1, minWidth: 120 },
                  onClick: () => importInputRef.current && importInputRef.current.click(),
                }, '↑ 导入预设'),
                h('input', {
                  ref: importInputRef,
                  type: 'file',
                  accept: '.json,application/json',
                  'aria-label': '预设 JSON 文件',
                  style: { display: 'none' },
                  onChange: (event) => void importPresetFile(event.target.files && event.target.files[0]),
                }),
              ),

              // 恢复内置
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '把内置预设重新写回磁盘（不覆盖已改过的）',
                  disabled: Boolean(presetsBusy),
                  style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
                  onClick: () => void resetPresets(),
                }, '恢复内置'),
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '重新读取预设列表',
                  disabled: Boolean(presetsBusy),
                  style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
                  onClick: () => void refreshPresets(),
                }, presetsBusy ? '读取中…' : '重新读取'),
                h('span', { style: { fontSize: 10.5, color: C.label3 } }, '导出=下载 JSON；导入=选文件；同名不覆盖'),
              ),
            )
          : null,

        /* ── 诊断浮窗（可拖动 / 可缩放）──────────────────────────
         * 点顶栏「🩺 诊断」立刻弹出来。三段内容：
         *   1. 结论条 —— 用户最想知道的是"到底坏没坏"，所以先说结论；
         *   2. 键值表 —— 版本 / 路由 / 进程 / 当前状态，报问题时照着念就行；
         *   3. 日志尾巴 —— 后端日志 + 本次操作流水，各自限高滚动。
         * 旧的展示点在设置页底部，用户根本找不到，等于没有。
         */
        diagOpen
          ? h(FloatingPanel, {
              id: 'diag',
              title: '诊断信息',
              subtitle: diag
                ? `采集于 ${new Date(diag.at).toLocaleTimeString()}${diagBusy ? ' · 正在刷新…' : ''}`
                : '正在采集…',
              defaultRect: { x: 140, y: 80, w: 580, h: 580 },
              onClose: () => setDiagOpen(false),
              footer: h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.6 } },
                '拖动标题栏移动 · 拖右下角调整大小 · Esc 关闭 · 位置会自动记住'),
            },
              !diag
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
                    h(Skeleton, { height: 34 }),
                    h(Skeleton, { height: 14, width: '72%' }),
                    h(Skeleton, { height: 14, width: '88%' }),
                    h(Skeleton, { height: 96 }))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
                    // 结论条
                    h('div', {
                      role: 'status',
                      'aria-live': 'polite',
                      style: {
                        padding: '9px 11px', borderRadius: 8, fontSize: 12, lineHeight: 1.6,
                        border: `1px solid color-mix(in srgb, ${diag.ok ? C.brand : DANGER} 42%, transparent)`,
                        background: `color-mix(in srgb, ${diag.ok ? C.brand : DANGER} 10%, transparent)`,
                        color: diag.ok ? C.label1 : DANGER,
                      },
                    }, diag.ok
                      ? '后端连通正常。下面的信息可以直接发给维护者定位问题。'
                      : '后端没有响应，插件的所有操作都会失败。先修后端，再看下面的日志。'),

                    // 键值表
                    h('div', null,
                      h(SectionTitle, null, '运行环境与状态'),
                      h('div', {
                        style: {
                          display: 'grid', gridTemplateColumns: 'auto 1fr',
                          gap: '5px 12px', fontSize: 11.5, lineHeight: 1.7,
                        },
                      },
                        ...diag.rows.reduce((acc, pair, index) => {
                          acc.push(h('div', { key: `k${index}`, style: { color: C.label3, whiteSpace: 'nowrap' } }, pair[0]))
                          acc.push(h('div', { key: `v${index}`, style: { color: C.label1, fontFamily: MONO, wordBreak: 'break-all' } }, String(pair[1])))
                          return acc
                        }, []))),

                    // 后端日志
                    h('div', null,
                      h(SectionTitle, { extra: `${diag.backendLogs.length} 行` }, '后端日志'),
                      diag.backendLogs.length
                        ? h('pre', { className: 'wxmp-scroll', style: { ...monoStyle, display: 'block', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 150, overflowY: 'auto', padding: 10, border: `1px solid ${C.border1}`, borderRadius: 8 } }, diag.backendLogs.join('\n'))
                        : h('div', { style: { fontSize: 11.5, color: C.label3 } }, '（没拿到日志：后端可能挂了，或者日志文件还没生成）')),

                    // 本次操作流水
                    h('div', null,
                      h(SectionTitle, { extra: `${diag.opsLog.length} 条` }, '本次操作流水'),
                      diag.opsLog.length
                        ? h('pre', { className: 'wxmp-scroll', style: { ...monoStyle, display: 'block', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 130, overflowY: 'auto', padding: 10, border: `1px solid ${C.border1}`, borderRadius: 8 } }, diag.opsLog.join('\n'))
                        : h('div', { style: { fontSize: 11.5, color: C.label3 } }, '（本次会话还没有操作记录）')),

                    // 动作区
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        'aria-label': '把诊断全文复制到剪贴板',
                        style: btn('accent'),
                        onClick: () => void copyDiagnostics(),
                      }, diagCopied ? '✓ 已复制' : '📋 复制全部')),
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        'aria-label': '重新探测后端并刷新诊断内容',
                        disabled: diagBusy,
                        style: { ...btn('normal'), flex: 1, minWidth: 130 },
                        onClick: async () => {
                          await collectDiagnostics()
                          notify('诊断信息已刷新', 'ok')
                        },
                      }, diagBusy ? '采集中…' : '🔄 重新探测'),
                      h('button', {
                        type: 'button',
                        className: 'wxmp-btn wxmp-focus',
                        'aria-label': '让后端跑一次自检',
                        disabled: Boolean(busy),
                        style: { ...btn('normal'), flex: 1, minWidth: 130 },
                        onClick: async () => {
                          const outcome = await runAction('doctor', 'doctor', {}, 'doctor')
                          // 自检会往后端日志里追加东西，采完自检立刻重采一次，
                          // 否则浮窗里显示的还是自检之前的旧日志（"看下面的日志"就成了骗人）
                          if (aliveRef.current) await collectDiagnostics({ silent: true })
                          if (!aliveRef.current) return
                          notify(outcome && outcome.ok ? '自检通过' : '自检有问题，看下面的日志', outcome && outcome.ok ? 'ok' : 'warn')
                        },
                      }, busy === 'doctor' ? '自检中…' : '🩺 跑一次自检')),
                  ),
            )
          : null,

        /* ── 画面提示词弹窗（可拖动 / 可缩放）─────────────────────
         * 从顶栏按钮打开，弹出对话框里设置画面描述、看最终提交词、生成封面。
         * 位置与大小会自动记住，Esc 关闭。
         */
        promptOpen
          ? h(FloatingPanel, {
              id: 'prompt',
              title: '画面提示词',
              subtitle: '写画面描述，点下面的「🎨 AI 配图」生成背景；标题由本插件排版叠加',
              defaultRect: { x: 180, y: 120, w: 460, h: 520 },
              onClose: () => {
                setPromptOpen(false)
                savePrefs({ promptOpen: false })
              },
              footer: h('div', { style: { fontSize: 10.5, color: C.label3, lineHeight: 1.6 } },
                '拖动标题栏移动 · 拖右下角调整大小 · Esc 关闭 · 位置会自动记住'),
            },
              // 输出规格：默认推荐 900×383，但可以强改 —— 改之前停在内联二次确认条上
              h('div', {
                style: {
                  fontSize: 11,
                  color: C.label3,
                  lineHeight: 1.7,
                  marginBottom: 10,
                  paddingBottom: 10,
                  borderBottom: `1px dashed ${C.border1}`,
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
                  h('div', { style: { color: C.label2, fontWeight: 600 } }, '输出规格（默认推荐，可改）'),
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-expanded': coverEditing ? 'true' : 'false',
                    title: coverEditing ? '收起尺寸编辑' : '修改输出尺寸（会先让你确认一次）',
                    style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32, marginLeft: 'auto' },
                    onClick: () => {
                      if (coverEditing) {
                        setCoverEditing(false)
                        setCoverConfirm(false)
                        return
                      }
                      setCoverDraftW(String(coverActive.width))
                      setCoverDraftH(String(coverActive.height))
                      setCoverConfirm(false)
                      setCoverEditing(true)
                    },
                  }, coverEditing ? '收起' : '✏️ 修改'),
                ),
                h('div', null,
                  `· 输出尺寸 ${formatCoverSize(coverActive.width, coverActive.height)}`,
                  coverSize
                    ? h('span', { style: { color: WARN, marginLeft: 6 } }, '（已强改）')
                    : h('span', { style: { marginLeft: 6, opacity: 0.75 } }, '（推荐值）'),
                ),
                h('div', null, '· AI 出的图会等比裁剪铺满，不会拉伸变形'),
                h('div', { style: { marginTop: 4, opacity: 0.8 } },
                  coverSize
                    ? '· 提示词写什么就提交什么，不追加任何约束'
                    : '· 提示词写什么就提交什么；留空则用内置的抽象光影模板'),

                // ── 尺寸编辑器（内联，不做弹层套弹层）─────────────
                coverEditing
                  ? h('div', {
                      style: {
                        marginTop: 8,
                        padding: 10,
                        borderRadius: 8,
                        background: C.base,
                        border: `1px solid ${C.border1}`,
                      },
                    },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                        h('label', {
                          htmlFor: 'wxmp-cover-w',
                          style: { fontSize: 11, color: C.label3 },
                        }, '宽'),
                        h('input', {
                          id: 'wxmp-cover-w',
                          type: 'number',
                          inputMode: 'numeric',
                          min: COVER_SPEC.limits.minWidth,
                          max: COVER_SPEC.limits.maxWidth,
                          step: 1,
                          value: coverDraftW,
                          className: 'wxmp-focus',
                          'aria-describedby': 'wxmp-cover-hint',
                          onChange: (event) => {
                            setCoverDraftW(event.target.value)
                            setCoverConfirm(false)
                          },
                          style: {
                            width: 72,
                            padding: '5px 8px',
                            borderRadius: 6,
                            border: `1px solid ${C.border2}`,
                            background: C.l1,
                            color: C.label1,
                            fontSize: 12,
                            fontFamily: MONO,
                          },
                        }),
                        h('span', { style: { color: C.label3 } }, '×'),
                        h('label', {
                          htmlFor: 'wxmp-cover-h',
                          style: { fontSize: 11, color: C.label3 },
                        }, '高'),
                        h('input', {
                          id: 'wxmp-cover-h',
                          type: 'number',
                          inputMode: 'numeric',
                          min: COVER_SPEC.limits.minHeight,
                          max: COVER_SPEC.limits.maxHeight,
                          step: 1,
                          value: coverDraftH,
                          className: 'wxmp-focus',
                          'aria-describedby': 'wxmp-cover-hint',
                          onChange: (event) => {
                            setCoverDraftH(event.target.value)
                            setCoverConfirm(false)
                          },
                          style: {
                            width: 72,
                            padding: '5px 8px',
                            borderRadius: 6,
                            border: `1px solid ${C.border2}`,
                            background: C.l1,
                            color: C.label1,
                            fontSize: 12,
                            fontFamily: MONO,
                          },
                        }),
                        h('span', { style: { color: C.label3 } }, '像素'),
                      ),
                      h('div', {
                        id: 'wxmp-cover-hint',
                        style: { marginTop: 6, fontSize: 10.5, lineHeight: 1.6, color: C.label3 },
                      },
                        coverDraftInfo.ready
                          ? `将设为 ${formatCoverSize(coverDraftInfo.width, coverDraftInfo.height)}`
                          : '宽高都要填正整数',
                        coverDraftInfo.outOfRange
                          ? h('div', { style: { color: WARN } },
                              `超出可用范围（宽 ${COVER_SPEC.limits.minWidth}~${COVER_SPEC.limits.maxWidth}、高 ${COVER_SPEC.limits.minHeight}~${COVER_SPEC.limits.maxHeight}），提交后会被夹到边界`)
                          : null,
                        coverDraftInfo.ratioWarn
                          ? h('div', { style: { color: WARN, marginTop: 2 } }, coverDraftInfo.ratioWarn)
                          : null,
                      ),
                      h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          style: btn('primary'),
                          disabled: !coverDraftInfo.ready,
                          onClick: () => setCoverConfirm(true),
                        }, '应用'),
                        coverSize
                          ? h('button', {
                              type: 'button',
                              className: 'wxmp-btn wxmp-focus',
                              style: btn('ghost'),
                              onClick: () => {
                                setCoverSize(null)
                                savePrefs({ coverSize: null })
                                setCoverDraftW(String(COVER_SPEC.width))
                                setCoverDraftH(String(COVER_SPEC.height))
                                setCoverConfirm(false)
                                notify(`已恢复推荐尺寸 ${formatCoverSize(COVER_SPEC.width, COVER_SPEC.height)}`, 'ok')
                              },
                            }, '恢复推荐')
                          : null,
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          style: btn('ghost'),
                          onClick: () => {
                            setCoverEditing(false)
                            setCoverConfirm(false)
                          },
                        }, '取消'),
                      ),
                    )
                  : null,

                // ── 二次确认（内联，不用弹层套弹层）───────────────
                coverConfirm && coverDraftInfo.ready
                  ? h('div', {
                      role: 'status',
                      'aria-live': 'polite',
                      style: {
                        marginTop: 8,
                        padding: 10,
                        borderRadius: 8,
                        background: `color-mix(in srgb, ${WARN} 12%, transparent)`,
                        border: `1px solid ${WARN}`,
                      },
                    },
                      h('div', { style: { color: C.label1, fontWeight: 600, marginBottom: 4 } },
                        `确认把封面输出尺寸改成 ${formatCoverSize(coverDraftInfo.width, coverDraftInfo.height)}？`),
                      h('div', null, `· 微信大图封面推荐 ${formatCoverSize(COVER_SPEC.width, COVER_SPEC.height)}；不是这个比例，公众号后台会按推荐比例再裁一次`),
                      h('div', null, '· AI 出图仍按横档请求，成图由合成阶段等比裁剪铺满，不会拉伸变形'),
                      h('div', null, '· 已经生成的封面不会自动重做 —— 要重做请点顶栏的「🖼️ 换封面」或这里的「🎨 AI 配图」'),
                      h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          style: btn('accent'),
                          onClick: () => {
                            const next = { width: coverDraftInfo.width, height: coverDraftInfo.height }
                            setCoverSize(next)
                            savePrefs({ coverSize: next })
                            setCoverConfirm(false)
                            setCoverEditing(false)
                            pushLog(`> 封面输出尺寸设为 ${formatCoverSize(next.width, next.height)}`)
                            notify(`封面输出尺寸已设为 ${formatCoverSize(next.width, next.height)}`, 'ok', 4000)
                          },
                        }, '确认，就改这个尺寸'),
                        h('button', {
                          type: 'button',
                          className: 'wxmp-btn wxmp-focus',
                          style: btn('normal'),
                          onClick: () => setCoverConfirm(false),
                        }, '再想想'),
                      ),
                    )
                  : null,
              ),
              // 输入框
              h('label', {
                style: { display: 'block', fontSize: 11.5, color: C.label3, marginBottom: 5 },
                htmlFor: 'wxmp-prompt-input',
              }, '画面描述（写你想要的风格；留空则用内置的抽象渐变）'),
              h('textarea', {
                id: 'wxmp-prompt-input',
                value: customPrompt,
                rows: 4,
                placeholder: '例如：深绿与青色的流动渐变，右上角有柔和光晕，电影质感，安静克制',
                onChange: (event) => setCustomPrompt(event.target.value),
                className: 'wxmp-focus',
                'aria-describedby': 'wxmp-prompt-help',
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  minHeight: 80,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  background: C.base,
                  color: C.label1,
                  fontSize: 12,
                  lineHeight: 1.6,
                  fontFamily: FONT,
                },
              }),
              h('div', {
                id: 'wxmp-prompt-help',
                style: { fontSize: 10.5, color: C.label3, marginTop: 5, lineHeight: 1.6 },
              }, '中文可以直接写。写什么就提交什么 —— 不会在背后替你追加任何约束。'),
              // 最终提示词预览
              h('details', { style: { marginTop: 8 } },
                h('summary', {
                  className: 'wxmp-focus',
                  style: { fontSize: 10.5, color: C.label3, cursor: 'pointer' },
                }, '查看最终提交给 AI 的完整提示词'),
                h('div', {
                  style: {
                    marginTop: 6,
                    padding: 8,
                    borderRadius: 8,
                    background: C.base,
                    border: `1px solid ${C.border1}`,
                    fontSize: 10.5,
                    color: C.label2,
                    lineHeight: 1.7,
                    fontFamily: MONO,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                }, previewPrompt(customPrompt, prefs.theme)),
              ),
              // 操作按钮
              h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '按当前画面提示词生成封面',
                  style: imageGen.available ? btn('primary') : { ...btn('ghost'), opacity: 0.72 },
                  disabled: Boolean(busy) || !selected || imageGen.busy || !imageGen.available,
                  onClick: () => {
                    if (!imageGen.available) {
                      notify(
                        'AI 配图未配置：先设 WXMP_IMG_OPENAI / WXMP_IMG_GEMINI 等环境变量，或在 config.json 写 imageKeys。没有 key 也能用「选底图」。',
                        'warn',
                        7000,
                      )
                      return
                    }
                    savePrefs({ customPrompt })
                    void regenerateCover({ imageGen: true, prompt: customPrompt })
                  },
                }, imageGen.busy ? 'AI 绘制中…' : imageGen.available ? '🎨 AI 配图' : '🎨 AI 配图（未配置）'),
                customPrompt.trim()
                  ? h('button', {
                      type: 'button',
                      className: 'wxmp-btn wxmp-focus',
                      style: btn('ghost'),
                      disabled: Boolean(busy) || imageGen.busy,
                      onClick: () => { setCustomPrompt(''); savePrefs({ customPrompt: '' }) },
                    }, '清空')
                  : null,
              ),
            )
          : null,

        /* ── T9-2 确认浮层（全插件唯一）─────────────────────────
         * 渲染在渲染树最外层：它要能盖住设置浮层（zIndex 9998）与打分预设/诊断浮窗。
         * 放在 h(Toast) 之前：两者 zIndex 同级时按 DOM 顺序，toast 在上 ——
         * 确认成功后浮层立刻收起，但那条成功 toast 必须看得见。
         */
        confirmState
          ? h(ConfirmModal, {
              title: confirmState.title,
              body: confirmState.body,
              confirmLabel: confirmState.confirmLabel || '确认',
              busyLabel: confirmState.busyLabel,
              danger: confirmState.danger === true,
              running: confirmState.running === true,
              error: confirmState.error || null,
              onCancel: cancelConfirm,
              onConfirm: runConfirm,
            })
          : null,

        h(Toast, { toast }),
      )
    }

    const STAGES = [
      { key: 'write', name: '写稿', desc: 'Markdown 正文与 front matter' },
      { key: 'check', name: '校验', desc: '标题 / 摘要 / 正文长度在限内' },
      // 尺寸是用户可改的，这里就不写死数字了 —— 写死了改完尺寸反而显示错的
      { key: 'cover', name: '封面', desc: '按当前输出规格生成，并上传为永久素材' },
      { key: 'draft', name: '草稿箱', desc: '建草稿，拿到 media_id' },
      { key: 'publish', name: '发表', desc: '提交发布任务并轮询结果' },
    ]

    /** 分项条的四行，顺序与 review.js 的 category 一致。 */
    const CATEGORY_LABELS = [
      ['limits', '限制'],
      ['structure', '结构'],
      ['readability', '可读'],
      ['assets', '素材'],
    ]

    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      background: C.base,
      color: C.label1,
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.55,
      overflow: 'hidden',
    }
    const topBarStyle = {
      flex: 'none',
      padding: '14px 18px 12px',
      borderBottom: `1px solid ${C.border1}`,
      background: C.l3,
    }
    /**
     * 可拖拽的列宽分隔条。
     *
     * 用户要"像 Excel 一样能随意调列宽"：读长文章时想拉宽中间，
     * 整理标题时想拉宽左栏。固定 248px 是拍脑袋定的，不该是硬限制。
     * 用 pointer 事件（不是 mouse）让触控板与触屏都能用。
     */
    function ColumnResizer({ width, min, max, onChange, onReset, label }) {
      const [dragging, setDragging] = useState(false)
      const startRef = useRef({ x: 0, width: 0 })

      useEffect(() => {
        if (!dragging) return undefined
        const onMove = (event) => {
          const delta = event.clientX - startRef.current.x
          onChange(Math.min(max, Math.max(min, startRef.current.width + delta)))
        }
        const onUp = () => setDragging(false)
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        // 拖动期间禁选文字、锁光标：否则会误选中正文
        const previousCursor = document.body.style.cursor
        const previousSelect = document.body.style.userSelect
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.cursor = previousCursor
          document.body.style.userSelect = previousSelect
        }
      }, [dragging, min, max, onChange])

      return h('div', {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': `${label}宽度调整（双击复位，方向键微调）`,
        'aria-valuenow': Math.round(width),
        'aria-valuemin': min,
        'aria-valuemax': max,
        tabIndex: 0,
        title: '拖动调整宽度，双击复位',
        style: {
          width: 6,
          flex: 'none',
          cursor: 'col-resize',
          background: dragging ? `color-mix(in srgb, ${C.brand} 40%, transparent)` : 'transparent',
          borderLeft: `1px solid ${C.border1}`,
          marginLeft: -1,
          transition: dragging ? 'none' : 'background-color 120ms ease',
          position: 'relative',
          zIndex: 1,
        },
        onPointerDown: (event) => {
          event.preventDefault()
          startRef.current = { x: event.clientX, width }
          setDragging(true)
        },
        onDoubleClick: onReset,
        // 键盘也能调，符合可访问性要求
        onKeyDown: (event) => {
          const step = event.shiftKey ? 48 : 16
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onChange(Math.max(min, width - step))
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            onChange(Math.min(max, width + step))
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onReset()
          }
        },
      })
    }

    /**
     * 可折叠区块：给"重要性不大"的区域加收起按钮。
     *
     * 收起后标题行仍可见（不然用户找不到它在哪）；
     * 状态记进 localStorage，下次打开保持。
     */
    function CollapsibleSection({ id, title, extra, defaultOpen = true, children }) {
      const [open, setOpen] = useState(() => {
        try {
          const raw = window.localStorage.getItem(`${STORE_KEY}:section:${id}`)
          return raw === null ? defaultOpen : raw === '1'
        } catch {
          return defaultOpen
        }
      })
      const toggle = () => {
        const next = !open
        setOpen(next)
        try {
          window.localStorage.setItem(`${STORE_KEY}:section:${id}`, next ? '1' : '0')
        } catch {
          /* 存储不可用只影响记忆，不影响功能 */
        }
      }
      return h('div', null,
        h(SectionTitle, {
          extra: h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
            extra || null,
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-expanded': open,
              'aria-label': open ? `收起${title}` : `展开${title}`,
              style: { ...btn('normal'), padding: '4px 8px', fontSize: 12, minWidth: 32, minHeight: 32 },
              onClick: toggle,
            }, open ? '−' : '+'),
          ),
        }, title),
        open ? children : null,
      )
    }

    /**
     * N9 multi-overlay-esc-closes-all：浮层打开顺序栈。
     *
     * 每个浮层（打分预设 / 诊断 / 设置）各自在 document 上挂 capture keydown，
     * 于是两个浮层同开时按一次 Esc 会**同时**关掉两个 —— 用户只按了一次键，
     * 底下那层却跟着消失，看起来像"我什么都没点，界面就没了"。
     *
     * 这里用一个模块级数组记录打开顺序（后打开的在栈顶），只有栈顶那层响应 Esc；
     * 下层保持原地，用户再按一次才轮到它。卸载时把自己从栈里摘掉。
     */
    const overlayStack = []
    function useOverlayToken() {
      const tokenRef = useRef(null)
      if (tokenRef.current === null) tokenRef.current = {}
      const token = tokenRef.current
      useEffect(() => {
        overlayStack.push(token)
        return () => {
          const at = overlayStack.indexOf(token)
          if (at >= 0) overlayStack.splice(at, 1)
        }
      }, [token])
      return token
    }
    /**
     * 当前 token 是不是最上层浮层。栈空（防御性）时按"是"处理，绝不把 Esc 关死。
     *
     * F20：判定依据是**打开顺序**（useOverlayToken 的挂载先后），不是 z-index。
     * 当前成立的前提有两条：每个浮层都是全屏覆盖；打开时下层已经挂载 ——
     * 所以后打开的必然同时是视觉最上层。若将来出现「确认浮层已开着、又打开另一个浮层」
     * 这类路径（快捷键、自动弹出），顺序会与实际视觉层级分叉，Esc 就会关错层；
     * 到那时请把这里改成按 zIndex 判最上层。
     */
    function isTopOverlay(token) {
      return overlayStack.length === 0 || overlayStack[overlayStack.length - 1] === token
    }

    /**
     * 可拖动、可缩放的悬浮窗。
     *
     * ## 为什么需要
     * 「打分预设」放在右栏里只能跟着右栏宽度走（220~560px），
     * 而预设列表 + 导入导出按钮并排时确实挤。做成悬浮窗后：
     *   - 想放大看细节就拖右下角
     *   - 想挪开不挡文章就拖标题栏
     *   - 位置和大小记进 localStorage，下次打开还在原处
     *
     * ## 实现要点（都是踩过的坑）
     * 1. **用 pointer 事件**（不是 mouse）：触控板、触屏、手写笔都能拖
     * 2. **拖动/缩放期间禁选文字**：否则会误选中文章正文，还会出现 I 字光标
     * 3. **用 transform 定位**而不是 left/top：拖动时不会触发重排，跟手
     * 4. **边界收敛**：不能拖出屏幕（否则再也点不到，只能清 localStorage）
     * 5. **层级**：浮层用 1000000 —— 高于右栏、高于设置浮层，但低于宿主的模态层。
     *    （原来还有一层 2147483000 的全屏工作台，那个功能已经删掉了。）
     */
    function FloatingPanel({ id, title, subtitle, onClose, defaultRect, children, footer }) {
      const STORE = `${STORE_KEY}:float:${id}`

      /** 把浮窗收敛回可视区：任何一次拖动/缩放后都跑一遍，避免拖丢。
       *  必须在 useState 初始化之前定义，否则 TDZ 会导致 ReferenceError，
       *  整个 FloatingPanel 组件树渲染失败（表现为“点了没反应/白屏”）。 */
      const clamp = (next) => {
        const vw = window.innerWidth || 1200
        const vh = window.innerHeight || 800
        const minW = 320
        const minH = 240
        const w = Math.min(Math.max(minW, next.w), Math.max(minW, vw - 40))
        const h = Math.min(Math.max(minH, next.h), Math.max(minH, vh - 40))
        // 至少留 80px 在屏幕内，否则拖出去就再也抓不回来
        const x = Math.min(Math.max(-w + 80, next.x), vw - 80)
        const y = Math.min(Math.max(0, next.y), vh - 60)
        return { x, y, w, h }
      }

      const [rect, setRect] = useState(() => {
        try {
          const raw = window.localStorage.getItem(STORE)
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
              // 初始位置也要 clamp：屏幕分辨率变小后，旧位置可能渲染在屏幕外 → "点了没反应/永久消失"
              return clamp(parsed)
            }
          }
        } catch {
          /* 解析失败就用默认位置 */
        }
        return defaultRect || { x: 80, y: 80, w: 420, h: 460 }
      })
      const [drag, setDrag] = useState(null) // { mode: 'move'|'resize', startX, startY, rect }
      const panelRef = useRef(null)
      const lastFocusedRef = useRef(null)

      // 浮窗挂载（打开）时记录当前焦点元素，卸载（关闭）时归还焦点
      useEffect(() => {
        lastFocusedRef.current = document.activeElement || null
      }, [])

      useEffect(() => {
        return () => {
          const el = lastFocusedRef.current
          if (el && typeof el.focus === 'function') {
            el.focus()
          }
        }
      }, [])

      const commit = (next) => {
        const safe = clamp(next)
        setRect(safe)
        try {
          window.localStorage.setItem(STORE, JSON.stringify(safe))
        } catch {
          /* 存不了只影响记忆 */
        }
      }

      useEffect(() => {
        if (!drag) return undefined
        const onMove = (event) => {
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (drag.mode === 'move') {
            commit({ ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy })
          } else {
            commit({ ...drag.rect, w: drag.rect.w + dx, h: drag.rect.h + dy })
          }
        }
        const onUp = () => setDrag(null)
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        const prevCursor = document.body.style.cursor
        const prevSelect = document.body.style.userSelect
        document.body.style.cursor = drag.mode === 'move' ? 'grabbing' : 'nwse-resize'
        document.body.style.userSelect = 'none'
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.cursor = prevCursor
          document.body.style.userSelect = prevSelect
        }
      }, [drag])

      // Esc 关闭：浮窗盖在内容上，键盘用户必须能退出。
      // N9：只有最上层浮层响应 —— 否则两个浮层同开时一次 Esc 全关。
      // 变量名与设置浮层刻意区分：test/mount.test.js 的 TDZ 静态守卫按「名字 → 定义行」建表，
      // 两处同名时它会取到靠后的那一行，把这里的合法引用误判成「提前引用后面的 const」。
      const panelOverlayToken = useOverlayToken()
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            if (!isTopOverlay(panelOverlayToken)) return
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [onClose, panelOverlayToken])

      /**
       * 运行时自检：检测祖先里有没有「定位容器」。
       *
       * ## 为什么要这个
       * 本插件曾经因为 `.wxmp-shell { container-type: inline-size }` 导致浮窗被裁，
       * 表现是"点了没反应"，查了很久。那是 CSS 的隐式行为：
       * 只要祖先有下列任一属性，`position: fixed` 就不再相对视口定位，
       * 而是相对那个祖先 —— 于是浮窗被圈在面板里，用户看不见。
       *
       *   container-type / transform / filter / perspective / will-change / contain
       *
       * 根因已删除，但宿主可能在未来版本给容器加上 transform（做动画很常见），
       * 那样问题会**静默重现**。所以这里做运行时探测：
       * 一旦发现祖先不对劲，就把浮窗降级成"铺满视口的遮罩模式"，
       * 至少保证用户能看见、能用，而不是点了没反应。
       */
      const [trapped, setTrapped] = useState(false)
      useEffect(() => {
        const node = panelRef.current
        if (!node) return
        let el = node.parentElement
        let found = null
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el)
          const reasons = []
          if (style.containerType && style.containerType !== 'normal') reasons.push(`container-type:${style.containerType}`)
          if (style.transform && style.transform !== 'none') reasons.push('transform')
          if (style.filter && style.filter !== 'none') reasons.push('filter')
          if (style.perspective && style.perspective !== 'none') reasons.push('perspective')
          if (style.willChange && style.willChange !== 'auto') reasons.push('will-change')
          if (reasons.length) {
            found = { tag: el.tagName, className: el.className, reasons }
            break
          }
          el = el.parentElement
        }
        setTrapped(Boolean(found))
        if (found) {
          // 用 console 而不是 logger：这是浏览器侧诊断信息，便于用户复制给我们看
          console.warn('[wxmp] 浮窗的祖先元素成了定位容器，已降级为遮罩模式：', found)
        }
      }, [])

      const startDrag = (mode) => (event) => {
        // 只响应主键，避免右键菜单触发拖动
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        setDrag({ mode, startX: event.clientX, startY: event.clientY, rect })
      }

      /**
       * N10 drag-handle-keyboard：拖动把手以前只能鼠标（pointerdown），键盘用户
       * 既 Tab 不到、也无法挪浮窗 —— 浮窗挡住正文时只能关掉重开。
       * 这里给两个把手补上方向键：Title 栏 = 移动，右下角 = 缩放；
       * 按住 Shift 步长放大到 40px（和 ColumnResizer 的 Shift 加速保持一致）。
       * 样式对齐 ColumnResizer：tabIndex=0 + aria-label + 方向键。
       */
      const handleArrowKeys = (mode) => (event) => {
        const step = event.shiftKey ? 40 : 8
        let dx = 0
        let dy = 0
        if (event.key === 'ArrowLeft') dx = -step
        else if (event.key === 'ArrowRight') dx = step
        else if (event.key === 'ArrowUp') dy = -step
        else if (event.key === 'ArrowDown') dy = step
        else return
        event.preventDefault()
        event.stopPropagation()
        commit(mode === 'move'
          ? { ...rect, x: rect.x + dx, y: rect.y + dy }
          : { ...rect, w: rect.w + dx, h: rect.h + dy })
      }

      return h(
        'div',
        {
          ref: panelRef,
          role: 'dialog',
          'aria-label': title,
          'aria-modal': 'false',
          style: {
            position: 'fixed',
            left: 0,
            top: 0,
            /**
             * 两种定位模式：
             * - 正常：translate3d 跟随拖动位置（用户能自由摆放）
             * - trapped：祖先成了定位容器，fixed 会被裁。此时放弃自由摆放，
             *   改成铺满整个"可见区域"，保证内容一定看得见。
             *   牺牲了拖动，但比"点了没反应"好得多。
             */
            transform: trapped ? 'none' : `translate3d(${rect.x}px, ${rect.y}px, 0)`,
            ...(trapped
              ? { inset: 0, width: 'auto', height: 'auto', margin: 16, borderRadius: 12 }
              : { width: rect.w, height: rect.h }),
            display: 'flex',
            flexDirection: 'column',
            background: C.base,
            border: `1px solid ${C.border2}`,
            borderRadius: 12,
            boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
            // 高于右栏与设置浮层（设置是 9998）
            zIndex: 1000000,
            overflow: 'hidden',
          },
        },
        // 标题栏：整条可拖（trapped 模式下拖动无意义，禁用避免误导）
        // N10：同时是键盘入口 —— Tab 可达，方向键移动浮窗（Shift 加速）
        h('div', {
          onPointerDown: trapped ? undefined : startDrag('move'),
          onKeyDown: trapped ? undefined : handleArrowKeys('move'),
          className: 'wxmp-focus',
          role: 'button',
          'aria-label': `移动${title}，方向键调整位置，按住 Shift 加速`,
          title: trapped ? undefined : '拖动或方向键移动窗口',
          tabIndex: trapped ? -1 : 0,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            borderBottom: `1px solid ${C.border1}`,
            background: C.l1,
            cursor: trapped ? 'default' : 'grab',
            flex: 'none',
            userSelect: 'none',
          },
        },
          h('span', { style: { fontSize: 12.5, fontWeight: 600, color: C.label1 } }, title),
          subtitle ? h('span', { style: { fontSize: 10.5, color: C.label3 } }, subtitle) : null,
          trapped
            ? h('span', {
                title: '检测到宿主容器会裁切浮窗，已自动铺满显示',
                style: { fontSize: 10, color: WARN, marginLeft: 4 },
              }, '（已铺满显示）')
            : null,
          h('button', {
            type: 'button',
            className: 'wxmp-btn wxmp-focus',
            'aria-label': `关闭${title}`,
            style: { ...btn('ghost'), marginLeft: 'auto', padding: '8px 12px', minWidth: 36, minHeight: 32, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' },
            onClick: onClose,
          }, '✕'),
        ),
        // 内容区
        h('div', { className: 'wxmp-scroll', style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 } }, children),
        footer ? h('div', { style: { flex: 'none', borderTop: `1px solid ${C.border1}`, padding: '8px 14px', background: C.l3 } }, footer) : null,
        // 右下角缩放把手（≥32×32 才好抓，四周留 ≥4px）
        // N10：原来只有 onPointerDown + 一个没有 role 的 aria-label（对读屏等于没有）。
        // 现在补 role/tabIndex/方向键，键盘也能缩放。
        h('div', {
          onPointerDown: trapped ? undefined : startDrag('resize'),
          onKeyDown: trapped ? undefined : handleArrowKeys('resize'),
          className: 'wxmp-focus',
          role: 'button',
          'aria-label': `调整${title}的大小，方向键改宽高，按住 Shift 加速`,
          title: trapped ? '当前为铺满模式，无法调整大小' : '拖动或方向键调整大小',
          tabIndex: trapped ? -1 : 0,
          style: {
            position: 'absolute',
            right: 4,
            bottom: 4,
            width: 32,
            height: 32,
            cursor: trapped ? 'default' : 'nwse-resize',
            // 用两条斜线画个把手，比纯色块更明确"这里能拖"
            background: `linear-gradient(135deg, transparent 45%, ${C.border2} 45%, ${C.border2} 55%, transparent 55%, transparent 70%, ${C.border2} 70%, ${C.border2} 80%, transparent 80%)`,
          },
        }),
      )
    }

    const colStyle = {
      minHeight: 0,
      overflowY: 'auto',
      padding: 14,
      borderRight: `1px solid ${C.border1}`,
    }
    const checkRowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 7,
      padding: '5px 0',
      fontSize: 11.5,
      color: C.label2,
      borderBottom: `1px solid color-mix(in srgb, ${C.border1} 55%, transparent)`,
    }

    /* ── T9-2 统一防误删确认浮层 ─────────────────────────────
     * 「举一反三」的核心：全插件所有破坏性操作共用这一个浮层 + 一个 confirmState。
     * 为什么共用而不是每个操作各写一个：文案当然要逐个写清（删什么 / 留什么 / 能不能恢复），
     * 但三件套、焦点归还、Esc 只关最上层、进行中禁用且宽度不变、失败就地显示原因这些行为
     * 只该写一遍 —— 抄成五份，迟早出现「有的能 Esc 关，有的按 Esc 把设置页一起关了」。
     */
    function ConfirmModal({ title, body, confirmLabel, busyLabel, danger, running, error, onCancel, onConfirm }) {
      const panelRef = useRef(null)
      const cancelRef = useRef(null)
      // 变量名与其它浮层刻意区分：test/mount.test.js 的 TDZ 静态守卫按「名字 → 定义行」建表，
      // 两个组件用同名 const 时它会取到靠后的那一行，把合法引用误判成「提前引用后面的 const」。
      const confirmOverlayToken = useOverlayToken()

      // Esc 关 + 焦点陷阱 + 关闭后焦点回到触发按钮（与 FloatingPanel / SettingsModal 同款）
      useEffect(() => {
        const previous = document.activeElement
        const node = panelRef.current
        const focusables = () => Array.from(node ? node.querySelectorAll('button,[tabindex]:not([tabindex="-1"])') : [])
        // 默认焦点落在「取消」：这是不可逆操作，回车键不该等于「确认删除」。
        // （lead 的两句要求冲突时按这条取舍 —— 破坏性操作的安全默认值优先）
        const first = cancelRef.current || focusables()[0]
        if (first && first.focus) first.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            // N9/T9-2：不是最上层就不响应，避免「关掉确认框」顺手把下面的设置页也关了
            if (!isTopOverlay(confirmOverlayToken)) return
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const list = focusables()
          if (!list.length) return
          const head = list[0]
          const tail = list[list.length - 1]
          if (event.shiftKey && document.activeElement === head) {
            event.preventDefault()
            tail.focus()
          } else if (!event.shiftKey && document.activeElement === tail) {
            event.preventDefault()
            head.focus()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          if (previous && previous.focus) previous.focus()
        }
      }, [onCancel, confirmOverlayToken])

      const bodyLines = body || []
      return h(
        'div',
        {
          // zIndex 与 toast 同级、高于设置浮层（9998）：确认框必须盖住设置页，
          // 但别盖住 toast —— 成功提示是用户第一眼要找的东西。
          style: { position: 'fixed', inset: 0, zIndex: 9999, background: C.overlay, display: 'grid', placeItems: 'center', padding: 20 },
          onMouseDown: (event) => {
            // 三件套之「点遮罩关」（内层点击不会冒到自己身上）
            if (event.target === event.currentTarget && !running) onCancel()
          },
        },
        h(
          'div',
          {
            ref: panelRef,
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-labelledby': 'wxmp-confirm-title',
            'aria-describedby': 'wxmp-confirm-body',
            // T9-4：正文很长时这里也要滚，同样挂统一滚动条样式
            className: 'wxmp-scroll',
            style: {
              width: 'min(460px, 100%)', maxHeight: 'min(80vh, 620px)', overflowY: 'auto',
              background: C.l1, border: `1px solid ${C.border2}`, borderRadius: 14, padding: 18,
              boxShadow: '0 24px 64px rgba(0,0,0,.42)',
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 } },
            h('div', {
              id: 'wxmp-confirm-title',
              style: { fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, color: danger ? DANGER : C.label1 },
            }, title),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '关闭确认框（不执行任何操作）',
              disabled: running,
              style: { ...btn('ghost'), minWidth: 32, minHeight: 32, padding: '5px 10px', flexShrink: 0 },
              onClick: onCancel,
            }, '关闭'),
          ),
          h('div', {
            id: 'wxmp-confirm-body',
            style: { fontSize: 12, color: C.label2, lineHeight: 1.75 },
          },
            ...bodyLines.map((line, index) => h('div', { key: index, style: { marginBottom: 6 } }, line)),
          ),
          // 失败就地显示原因：破坏性操作失败后用户要当场决定「重试」还是「先去修后端」，
          // 关掉浮层只留一条 4 秒 toast，等用户回过头来已经没有上下文了。
          error
            ? h('div', {
                role: 'alert',
                'aria-live': 'assertive',
                style: {
                  marginTop: 10, padding: '9px 11px', borderRadius: 9,
                  border: `1px solid color-mix(in srgb, ${DANGER} 48%, transparent)`,
                  background: `color-mix(in srgb, ${DANGER} 10%, transparent)`,
                  fontSize: 11.5, lineHeight: 1.7,
                },
              },
                h('div', { style: { fontWeight: 600, color: DANGER } }, error.message || '操作失败'),
                h('div', { style: { color: C.label3, marginTop: 3 } }, `错误码：${error.code || 'unknown'}`),
                error.hint ? h('div', { style: { color: C.label2, marginTop: 3 } }, error.hint) : null,
                h('div', { style: { color: C.label3, marginTop: 5 } }, '可以再点一次「' + confirmLabel + '」重试，或点「取消」先去诊断浮窗看后端状态。'),
              )
            : null,
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              ref: cancelRef,
              className: 'wxmp-btn wxmp-focus',
              style: { ...btn('normal'), minWidth: 84 },
              disabled: false,
              onClick: onCancel,
            }, '取消'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': `${confirmLabel}（不可恢复，点之前请确认上面写了什么）`,
              disabled: Boolean(running),
              // 进行中保持原宽度：按钮一缩一放会把「取消」挤得乱跳，用户容易点错
              style: { ...(danger ? btn('danger') : btn('primary')), minWidth: 96 },
              onClick: () => void onConfirm(),
            }, running ? (busyLabel || '处理中…') : confirmLabel),
          ),
        ),
      )
    }

    /* ── 设置（内联浮层，符合 E 的关闭三件套） ─────────────── */
    function SettingsModal(props) {
      const { onClose, notify, requestConfirm, onClearData, onOpenDiagnostics, version, draftCount, onRefreshCount, runAction, busy, runtime: runtimeProp, runtimeBusy = false, runtimeNote = '', probeRuntime, endpoint, imageGen, saveImageKey, clearImageKeys, reduceMotion = false, onToggleReduceMotion } = props
      const runtime = runtimeProp || { health: null, logs: [], logFile: '' }
      const panelRef = useRef(null)
      const closeRef = useRef(null)
      const [appid, setAppid] = useState('')
      const [secret, setSecret] = useState('')
      const [advanced, setAdvanced] = useState(false)
      /**
       * N3③/W3②：把「清除本插件数据」真正接到宿主。
       * 宿主 op = 'clear-plugin-data'（ui-backend.js 里 UI_OPERATIONS 的那个 case → index.js 的 clearPluginData）：
       * 删 plugin.log 及其轮转文件 + 崩溃残留的 call-*.log；
       * 保留 mount-state.json 与 config.json（后者由 CLI 管理，不在这里删）。
       * 浏览器侧的 localStorage 偏好走 onClearData。
       */
      const clearPluginData = async () => {
        const hostOps = runtime && runtime.health && Array.isArray(runtime.health.ops) ? runtime.health.ops : null
        const supported = !hostOps || hostOps.indexOf('clear-plugin-data') !== -1
        if (!supported) {
          // 降级：旧宿主没这个 op，只说清"这次只清了界面偏好"，不给一个必然失败的按钮
          onClearData()
          notify('当前宿主还没有「清除插件日志」接口，这次只清了界面偏好', 'warn', 6000)
          // T9-2：降级也算走完了，回 ok 让确认浮层收起来 —— 原因由上面那条 warn 说清
          return { ok: true }
        }
        const outcome = await runAction('clear', 'clear-plugin-data', {}, 'clear plugin data')
        if (outcome && outcome.ok) {
          // 宿主侧删了什么由 runAction 弹一条结果；界面偏好紧接着清掉，quiet 避免第二条 toast
          onClearData(true)
        } else {
          // 失败也要给下一步：runAction 已弹过原因，这里只说明"偏好没动"
          notify('日志没清干净，界面偏好这次先保留，稍后可重试', 'warn', 5000)
        }
        // T9-2：把宿主结果回传给确认浮层 —— 失败时浮层不关，就地显示原因
        return outcome
      }
      /**
       * T9-2：清数据也走统一确认浮层。
       * 这条原来是一键直删：误点就把日志和界面偏好一起清掉，而清的正是「排障要用」的东西 ——
       * 事前说清删什么 / 留什么 / 能不能恢复，比事后道歉便宜。
       */
      const askClearPluginData = () => requestConfirm({
        title: '清除本插件的数据？',
        body: [
          '会删掉：本机运行日志（plugin.log 及轮转文件、崩溃残留的 call-*.log），以及面板界面偏好（分栏宽度、浮窗位置、上次打开的文章）。',
          '不会动：你自己的文章 .md 文件、公众号 AppID/AppSecret 配置、微信后台的草稿与已发表内容。',
          '日志删掉之后就没法回看历史记录了 —— 这一条不可恢复。',
        ],
        confirmLabel: '清除',
        busyLabel: '清除中…',
        danger: true,
        onConfirm: async () => {
          const outcome = await clearPluginData()
          return outcome || { ok: true }
        },
      })
      const [imageProvider, setImageProvider] = useState('gemini')
      const [imageKey, setImageKey] = useState('')
      const [imageBaseUrl, setImageBaseUrl] = useState('')

      // N9：设置浮层也进浮层栈 —— 与打分预设/诊断浮窗同开时，Esc 只关最上层那个
      // 变量名与浮窗组件的 token 刻意区分：test/mount.test.js 的 TDZ 静态守卫按「名字 → 定义行」建表，
      // 两个组件用同名 const 时它会取到靠后的那一行，把合法引用误判成「提前引用后面的 const」。
      const settingsOverlayToken = useOverlayToken()

      // Esc 关闭 + 焦点陷阱 + 关闭后焦点回到触发按钮
      useEffect(() => {
        const previous = document.activeElement
        const node = panelRef.current
        const focusables = () => Array.from(node ? node.querySelectorAll('button,input,[tabindex]:not([tabindex="-1"])') : [])
        const first = focusables()[0]
        if (first && first.focus) first.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            // N9：不是最上层就不响应该键（焦点陷阱照旧生效，只有 Esc 分叉）
            if (!isTopOverlay(settingsOverlayToken)) return
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const list = focusables()
          if (!list.length) return
          const head = list[0]
          const tail = list[list.length - 1]
          if (event.shiftKey && document.activeElement === head) {
            event.preventDefault()
            tail.focus()
          } else if (!event.shiftKey && document.activeElement === tail) {
            event.preventDefault()
            head.focus()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          if (previous && previous.focus) previous.focus()
        }
      }, [onClose, settingsOverlayToken])

      async function saveCredentials() {
        const outcome = await runAction('config', 'config-set', { appid: appid.trim(), secret: secret.trim() }, 'config set')
        if (outcome && outcome.ok) {
          setAppid('')
          setSecret('')
          notify('凭据已保存（保存在本机配置文件里，只显示打码）', 'ok')
          onRefreshCount()
        }
      }

      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, zIndex: 9998, background: C.overlay, display: 'grid', placeItems: 'center', padding: 20 },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            ref: panelRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '公众号文章工作台设置',
            className: 'wxmp-scroll',
            style: {
              width: 'min(560px, 100%)', maxHeight: 'min(78vh, 720px)', overflowY: 'auto',
              background: C.l1, border: `1px solid ${C.border2}`, borderRadius: 14, padding: 18,
              boxShadow: '0 24px 64px rgba(0,0,0,.42)',
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, '设置'),
            h(Badge, { tone: 'idle' }, `v${version}`),
            h('button', {
              type: 'button',
              ref: closeRef,
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '关闭设置',
              style: { ...btn('ghost'), marginLeft: 'auto', minWidth: 32, minHeight: 32, padding: '5px 12px' },
              onClick: onClose,
            }, '关闭'),
          ),

          h(SectionTitle, null, '常用'),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.7, marginBottom: 8 } },
            '填公众号的 AppID 和 AppSecret。只存在本机配置文件，界面和错误信息里都会打码。'),
          // W3② config-plaintext-credentials：原来只说「只存在本机」，没说存的是**明文**。
          // 审计确认 config.json 里 AppSecret 与图片 key 都是明文落盘 —— 用户有权知道这件事，
          // 才能自己判断要不要在这台机器上放（共享机 / 云主机上尤其要紧）。
          h('div', { style: { fontSize: 11, color: C.label3, lineHeight: 1.7, marginBottom: 10 } },
            '注意：密钥在磁盘上是明文保存的（config.json），运行日志里也可能留下片段。',
            '公用机器或云主机上，用完请点本页的「清除本机凭据」抹掉配置、点「清除本插件数据」抹掉日志，并去公众号后台重置密钥。'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('label', { style: { fontSize: 11.5, color: C.label3 } }, 'AppID',
              h('input', {
                type: 'text', value: appid, placeholder: 'wx 开头，例如 wx1234567890abcdef',
                onChange: (event) => setAppid(event.target.value),
                className: 'wxmp-focus',
                style: inputStyle,
              })),
            h('label', { style: { fontSize: 11.5, color: C.label3 } }, 'AppSecret',
              h('input', {
                type: 'password', value: secret, placeholder: '后台「基本配置」里的那一串',
                onChange: (event) => setSecret(event.target.value),
                className: 'wxmp-focus',
                style: inputStyle,
              })),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                className: 'wxmp-btn wxmp-focus',
                style: btn('primary'),
                disabled: Boolean(busy) || !appid.trim() || !secret.trim(),
                onClick: saveCredentials,
              }, busy === 'config' ? '正在保存…' : '保存'),
              h('span', { style: { fontSize: 11, color: C.label3 } }, '保存后立刻生效，不用重启')),
          ),

          // ── AI 配图（封面背景）────────────────────────────
          // 之前只有 CLI 能配，面板上完全没入口 —— 用户看到「AI 配图（未配置）」
          // 却找不到去哪儿配。这里补上，并把「没配也能用底图」说清楚。
          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, null, 'AI 配图（封面背景）'),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.7, marginBottom: 8 } },
            '配一家的 key 就能让 AI 生成封面底图，中文标题仍由本插件排版。不配也能用「选底图」或默认渐变。'),
          // 当前状态：已配哪几家
          h('div', { style: { fontSize: 11.5, color: C.label3, marginBottom: 10 } },
            imageGen.available
              ? `已配置：${imageGen.providers.map((p) => p.providerId).join(' / ')}`
              : '当前未配置任何图片供应商'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('label', { style: { fontSize: 11.5, color: C.label3 } }, '供应商',
              h('select', {
                value: imageProvider,
                onChange: (event) => setImageProvider(event.target.value),
                className: 'wxmp-focus',
                style: { ...inputStyle, cursor: 'pointer' },
                'aria-label': '选择图片供应商',
              }, ...IMAGE_PROVIDER_CHOICES.map((item) =>
                h('option', { key: item.id, value: item.id }, item.label)))),
            h('label', { style: { fontSize: 11.5, color: C.label3 } }, 'API Key',
              h('input', {
                type: 'password', value: imageKey, placeholder: '只存本机，展示时会打码',
                onChange: (event) => setImageKey(event.target.value),
                className: 'wxmp-focus',
                style: inputStyle,
                'aria-label': '图片供应商的 API Key',
              })),
            // 自定义中转站需要 baseUrl
            imageProvider === '__custom'
              ? h('label', { style: { fontSize: 11.5, color: C.label3 } }, 'Base URL',
                  h('input', {
                    type: 'text', value: imageBaseUrl, placeholder: '例如 https://api.example.com/v1',
                    onChange: (event) => setImageBaseUrl(event.target.value),
                    className: 'wxmp-focus',
                    style: inputStyle,
                    'aria-label': '自定义供应商的接入地址',
                  }))
              : null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                className: 'wxmp-btn wxmp-focus',
                style: btn('primary'),
                disabled: Boolean(busy) || !imageKey.trim() || (imageProvider === '__custom' && !imageBaseUrl.trim()),
                onClick: () => void saveImageKey(imageProvider, imageKey.trim(), imageBaseUrl.trim()),
              }, busy === 'config' ? '正在保存…' : '保存 key'),
              imageGen.available
                ? h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: btn('ghost'),
                    disabled: Boolean(busy),
                    // T9-2：清 key 也是破坏性操作，同样走确认浮层；clearImageKeys 现在把结果回传，
                    // 失败时浮层留着并当场显示原因（不再只是 4 秒就消失的 toast）
                    onClick: () => requestConfirm({
                      title: '清空已配的图片 key？',
                      body: [
                        '会删掉：本机 config.json 里所有图片供应商的 key（OpenAI / Gemini / 豆包等）。',
                        '不会动：公众号 AppID/AppSecret、本地文章、微信后台草稿、已上传的封面素材。',
                        '删除后无法找回，「AI 配图」会变回未配置状态，只能用新 key 重新填。',
                      ],
                      confirmLabel: '清空',
                      busyLabel: '清空中…',
                      danger: true,
                      onConfirm: async () => {
                        const outcome = await clearImageKeys()
                        return outcome || { ok: true }
                      },
                    }),
                  }, '清空已配的 key')
                : null,
              h('span', { style: { fontSize: 11, color: C.label3 } }, '保存后立刻生效')),
          ),
          h('div', { style: { fontSize: 11, color: C.label3, marginTop: 8, lineHeight: 1.7 } },
            '也可以不在这里配：设环境变量 WXMP_IMG_OPENAI / WXMP_IMG_GEMINI / WXMP_IMG_DOUBAO 等，优先级低于这里。'),
          // W3②：图片 key 与凭据同等待遇，单独说一句落盘形态，并指向已有的收回动作
          h('div', { style: { fontSize: 11, color: C.label3, marginTop: 4, lineHeight: 1.7 } },
            '保存后这个 key 会以明文写进本机 config.json；想收回就点上面的「清空已配的 key」。'),

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, {
            extra: h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-expanded': advanced,
              style: { ...btn('normal'), padding: '4px 10px', fontSize: 11, minHeight: 32 },
              onClick: () => setAdvanced((v) => !v),
            }, advanced ? '收起' : '展开'),
          }, '高级'),
          advanced
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.75 } },
                  h('div', null, '· 接口地址：固定走微信官方域名，一般不需要改。'),
                  h('div', null, '· 数据位置：文章在 ', h('code', { style: monoStyle }, '%LOCALAPPDATA%\\wxmp\\articles'), '，配置在 ', h('code', { style: monoStyle }, 'config.json'), '。'),
                  h('div', null, '· 发布是异步任务：提交成功不代表发布成功，面板会自动轮询。')),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: btn('ghost'),
                    disabled: Boolean(busy),
                    onClick: async () => {
                      const outcome = await runAction('doctor', 'doctor', {}, 'doctor')
                      if (outcome && outcome.ok) notify('自检通过', 'ok')
                      else notify('自检有问题，看诊断信息', 'warn')
                    },
                  }, busy === 'doctor' ? '自检中…' : '跑一次自检'),
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    'aria-label': '打开诊断信息浮窗（版本、后端连通、最近日志）',
                    title: '诊断内容已搬到独立浮窗，点了立刻弹出来',
                    style: btn('normal'),
                    onClick: onOpenDiagnostics,
                  }, '🩺 打开诊断浮窗'),
                ),
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  style: { ...btn('normal'), alignSelf: 'flex-start' },
                  disabled: Boolean(busy),
                  // T9-2：破坏性操作不再一键直删 —— 先进统一确认浮层（明确删什么/留什么/能不能恢复）
                  onClick: () => requestConfirm({
                    title: '清除本机凭据？',
                    body: [
                      '会删掉：本机 config.json 里的公众号 AppID / AppSecret，以及已配的图片供应商 key。',
                      '不会动：已经写好的本地文章、微信后台的草稿与已发表内容、运行日志。',
                      '删除后无法找回 —— 要恢复只能去公众号后台重置密钥后重新填。',
                    ],
                    confirmLabel: '清除',
                    busyLabel: '清除中…',
                    danger: true,
                    onConfirm: async () => {
                      const outcome = await runAction('clearCred', 'config-clear', {}, 'config clear')
                      if (outcome && outcome.ok) notify('已清除本机凭据', 'ok')
                      return outcome
                    },
                  }),
                }, busy === 'clearCred' ? '清除中…' : '清除本机凭据'),
              )
            : null,

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, null, '接管与冲突'),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.75, marginBottom: 10 } },
            h('div', null, '· 本插件当前接管了', h('b', { style: { color: C.label1 } }, '主工作区'), '：点左侧栏「公众号文章」时，主区域会切换成本工作台。'),
            h('div', null, '· 左侧栏只新增一个入口按钮，不改动其他条目。'),
            h('div', null, '· 如果发现这个图标被别的插件顶掉、或点开是别的界面，说明有插件抢同一个位置：可以在插件列表里调顺序，或先禁用其中一个。'),
          ),
          h('button', {
            type: 'button',
            className: 'wxmp-btn wxmp-focus',
            style: { ...btn('normal'), alignSelf: 'flex-start' },
            onClick: () => {
              // restore-default-ui-false-toast：只清本插件的 UI 偏好，不能强制宿主重新挂载槽位。
              // 真正生效需要重启 DSH 或新开会话；toast 如实说，不承诺立刻恢复。
              try { window.localStorage.removeItem(STORE_KEY) } catch { /* 忽略 */ }
              setShowSettings(false)
              notify('已清本插件 UI 偏好。重启 DSH 或新开会话后生效；左侧栏入口仍在。', 'warn', 5000)
            },
          }, '恢复宿主默认界面'),

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(
            SectionTitle,
            {
              extra: h('button', {
                type: 'button',
                className: 'wxmp-btn wxmp-focus',
                style: btn('ghost'),
                'aria-label': '重新检查后端与日志状态',
                onClick: probeRuntime,
              }, runtimeBusy ? '检查中…' : '重新检查'),
            },
            '后端与运行状态',
          ),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.75, marginBottom: 8 } },
            runtimeNote
              ? h('div', { style: { color: WARN } }, runtimeNote)
              : null,
            h('div', null, '· 后端接口：', h('code', { style: monoStyle }, endpoint || API)),
            h('div', null, '· 挂载记录：', h('code', { style: monoStyle }, runtime.health ? (runtime.health.route || '') : '（没取到）'),
              runtime.health && runtime.health.mountedAt ? ` · 于 ${runtime.health.mountedAt} · 进程 ${runtime.health.pid}` : ''),
            runtime.health && !runtime.health.cliPath
              ? h('div', { style: { color: WARN } }, '· 后端找不到 CLI 入口（bin/wxmp.js）。配置 cliPath 或设置环境变量 WXMP_CLI_JS。')
              : null,
            h('div', null, '· 落盘日志：', h('code', { style: monoStyle }, runtime.logFile || '（没取到）'))),
          runtime.logs.length
            ? h('pre', {
                className: 'wxmp-scroll',
                'aria-label': '最近插件日志',
                role: 'log',
                style: { ...monoStyle, display: 'block', whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto', padding: 10, border: `1px solid ${C.border1}`, borderRadius: 8, marginTop: 8 },
              }, runtime.logs.join('\n'))
            : h('div', { style: { fontSize: 11.5, color: C.label3, marginTop: 8 } }, '还没有日志记录。跑一次操作或点上面的「重新检查」就有了。'),

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, null, '界面'),
          // P15 reduceMotion-dead-config：这个开关以前不存在 —— 偏好项写了却没入口。
          // 勾上立刻生效（根容器换类名，不用刷新），对应 CSS 里的 .wxmp-reduce-motion 一组规则；
          // 系统级 prefers-reduced-motion 由 @media 单独兜底，两者互不依赖。
          h('label', {
            style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: C.label2, lineHeight: 1.7, cursor: 'pointer' },
          },
            h('input', {
              type: 'checkbox',
              checked: Boolean(reduceMotion),
              onChange: () => { if (typeof onToggleReduceMotion === 'function') onToggleReduceMotion() },
              className: 'wxmp-focus',
              style: { marginTop: 2, width: 16, height: 16, cursor: 'pointer', flex: 'none' },
            }),
            h('span', null,
              '减少动态效果（关掉过渡与骨架屏闪动）',
              h('span', { style: { display: 'block', fontSize: 11, color: C.label3 } },
                '跟随系统设置也可：系统里开了「减少动态效果」时本插件同样不再动。'))),

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, null, '本插件存了什么'),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.75, marginBottom: 10 } },
            h('div', null, '· 界面偏好（折叠状态、上次选中的文章）存在浏览器 localStorage，键名 ', h('code', { style: monoStyle }, 'wxmp.ui.v1'), '。'),
            h('div', null, '· 文章和凭据存在本机文件目录，不随卸载自动删除。'),
            // W3②：把「日志也在本机、明文密钥可能留在里面」写清楚，
            // 下方那个清除按钮才有可解释的落点（原来只说了偏好/文章/草稿三处）。
            h('div', null, '· 运行日志存在本机状态目录的 ', h('code', { style: monoStyle }, runtime.logFile || 'logs/plugin.log'), '，里面可能留有密钥片段。'),
            h('div', null, `· 当前草稿箱 ${draftCount == null ? '（读取中）' : draftCount + ' 条'}，存在微信服务器。`)),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('normal'),
              onClick: onRefreshCount,
            }, '刷新草稿数量'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('ghost'),
              disabled: Boolean(busy),
              // P16 dead-branch-resetting：原来是
              //     onClick: () => { setResetting(true); onClearData(); setResetting(false) }
              // 三步在同一个 tick，React 批处理后 resetting 从没变成过 true，
              // 所以 `resetting ? '已清除' : ...` 是一条永远走不到的死分支（变量写了 12 行从没被读）。
              // 删掉这个 state，改由真实的请求进度驱动按钮文案。
              // N3③/W3②：同时把宿主侧清日志链路接上（clearPluginData，见上方定义）。
              // T9-2：再往前挂一层确认浮层 —— 这条清的是排障要用的日志，误点代价高。
              onClick: () => askClearPluginData(),
            }, busy === 'clear' ? '正在清除…' : '清除本插件数据（日志+界面偏好，不动文章）'),
          ),

          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('danger'),
              onClick: () => {
                // 恢复默认：清偏好但不碰文章与凭据
                try { window.localStorage.removeItem(STORE_KEY) } catch { /* 忽略 */ }
                notify('已恢复默认界面设置（文章和凭据没动）', 'ok')
                onClose()
              },
            }, '恢复默认设置'),
          ),
        ),
      )
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', marginTop: 4,
      background: C.l3, border: `1px solid ${C.border1}`, borderRadius: 8,
      padding: '7px 10px', color: C.label1, font: `inherit`, fontFamily: MONO, fontSize: 12,
    }
    const monoStyle = { fontFamily: MONO, fontSize: 11, color: C.label3 }

    /* ── 侧栏入口图标 ──────────────────────────────────────── */
        function PanelIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M3 9h18', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M8 13h9M8 16.5h6', stroke: 'currentColor', strokeWidth: 1.6 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const PANEL_ID = 'wxmp'

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', '@local/wxmp')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })

        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '公众号文章' },
              PanelIcon,
            ),
          ),
        )

        // 主面板：单入口（侧栏 panellist 点进来就是这里，不再有"全屏浮层"第二入口）。
        // 渲染错误兜底留着 —— 客户端代码一旦抛异常，至少给用户一条"刷新重试"的出路。
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            function PanelWorkbench() {
              try {
                return h(Workbench, {})
              } catch (error) {
                return h('div', {
                  style: {
                    // W12-R4 hardcoded-error-color：这里原来写死 '#e05c5c'，
                    // 换浅色皮肤时这块红在浅底上对比度不够、也和别处的错误色不统一。
                    // 改成和全插件同一个 token（DANGER 本身就带同色 fallback）。
                    padding: 20, color: DANGER, fontSize: 13, lineHeight: 1.6,
                    background: C.base, border: `1px solid ${C.border1}`, borderRadius: 8,
                  },
                },
                  h('div', null, '工作台渲染错误：' + String(error.message || error)),
                  h('div', { style: { marginTop: 10, fontSize: 11, color: C.label3 } },
                    '可能原因：客户端代码在浏览器半运行时抛出异常，或旧版 client.js 未刷新。'),
                  h('button', {
                    type: 'button',
                    style: { marginTop: 10, padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer' },
                    onClick: () => window.location.reload(),
                  }, '刷新页面重试'),
                )
              }
            },
          ),
        ),
        )

        /* shell.overlay 槽位与 sidebar.footer.action 都不再注册。
         * 用户明确说"全屏功能已经不需要了" —— 双入口模型整块拆掉：
         * 面板就是唯一的入口，占用的槽位更少，也不会在别人的布局里多插一层浮层。
         */

        return () => {
          document.querySelectorAll('style[data-plugin="@local/wxmp"]').forEach((node) => node.remove())
        }
      },
    }
  },
})
