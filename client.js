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
    const VERSION = '0.1.0'

    /* ── 持久化 ──────────────────────────────────────────────── */
    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
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
      page: 0, // 文章列表分页
    }
    const PAGE_SIZE = 8

    /* ── 请求 ────────────────────────────────────────────────── */
    async function api(op, params, signal) {
      let response
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, params: params || {} }),
          signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        // 网络层就没通：插件 UI 已经渲染出来了，但宿主后端没接上
        const err = new Error('连不上本机后端')
        err.code = 'backend_unreachable'
        err.hint = '界面已经加载，但后台服务没响应。常见原因是宿主刚启动、或插件需要重载。先点「重试」；仍然不行就点「诊断」把信息给开发者。'
        throw err
      }
      if (!response.ok) {
        const err = new Error(`后台返回 HTTP ${response.status}`)
        err.code = 'http_' + response.status
        err.hint = '界面已生效，但后台拒绝了这次请求。稍后重试；持续失败点「诊断」。'
        throw err
      }
      const payload = await response.json()
      return payload
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
        wechat_40164: '本机出口 IP 不在白名单。去公众号后台「开发 → 基本配置 → IP 白名单」加上。',
        wechat_48001: '这个公众号没有发布接口权限（个人未认证订阅号就是这种情况）。草稿已经建好了，去后台手动点发表。',
        wechat_53503: '草稿没通过发布检查：大概率是缺封面、标题超 32 字或正文超 2 万字。点「重新校验」看具体哪项。',
        wechat_45166: '正文里有外链图片。用「建草稿」让工具自动上传替换，别直接贴网图地址。',
        content_image_too_large: '正文图片超过 1 MB。压缩到 1 MB 以内再试。',
        article_not_found: '文章文件找不到了，可能被移动或重命名。点「刷新列表」。',
        article_invalid: '文章不满足微信的限制，先看「发布前检查」里标红的那几项。',
        ref_expired: '页面状态过期了，重试一次即可。',
        timeout: '操作超时。可能是网络慢或公众号接口繁忙，稍等再点一次。',
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
      overlay: 'var(--dsw-alias-overlay-scrim, rgba(0,0,0,.55))',
    }
    const WARN = '#e8a33d'
    const DANGER = '#e05c5c'
    const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    const MONO = 'ui-monospace, Consolas, "Liberation Mono", monospace'

    const CSS = `
.wxmp-focus:focus-visible { outline: 2px solid color-mix(in srgb, ${C.brand} 78%, transparent); outline-offset: 2px; }
.wxmp-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, ${C.label3} 34%, transparent) transparent; }
.wxmp-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.wxmp-scroll::-webkit-scrollbar-track { background: transparent; }
.wxmp-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, ${C.label3} 34%, transparent);
  border-radius: 99px; border: 2.5px solid transparent; background-clip: padding-box;
}
.wxmp-scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, ${C.label3} 58%, transparent); }
.wxmp-card { transition: background-color 140ms ease, border-color 140ms ease; }
.wxmp-card:hover { background: ${C.l2} !important; border-color: ${C.border2} !important; }
.wxmp-btn { transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease; }
.wxmp-btn:hover:not(:disabled) { border-color: ${C.border2} !important; color: ${C.label1} !important; }
.wxmp-anim { transition: opacity 160ms ease, transform 160ms ease; }
@media (prefers-reduced-motion: reduce) {
.wxmp-anim { transition: none !important; }
}
.wxmp-skel {
  background: linear-gradient(90deg, ${C.l2} 25%, ${C.l3} 37%, ${C.l2} 63%);
  background-size: 400% 100%;
  animation: wxmp-shimmer 1.4s ease infinite;
}
@keyframes wxmp-shimmer { 0% { background-position: 100% 50% } 100% { background-position: 0 50% } }
@media (prefers-reduced-motion: reduce) { .wxmp-skel { animation: none !important; } }

/* 三布局：宽 / 窄 / 小窗口。用容器查询而不是视口查询，
   因为面板可能只占宿主的右侧一小块，媒体查询会判断错误。 */
.wxmp-shell { container-type: inline-size; }
`

    /* ── 小工具 ──────────────────────────────────────────────── */
    const btn = (variant = 'normal') => {
      const map = {
        normal: { background: C.l2, color: C.label2, border: `1px solid ${C.border1}` },
        primary: { background: C.brand, color: '#07130c', border: '1px solid transparent', fontWeight: 600 },
        danger: { background: 'transparent', color: DANGER, border: `1px solid color-mix(in srgb, ${DANGER} 34%, transparent)` },
        ghost: { background: 'transparent', color: C.label3, border: `1px solid ${C.border1}` },
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
        ...map[variant],
      }
    }

    function Badge({ tone, children }) {
      const tones = {
        ok: { color: C.brand, bg: `color-mix(in srgb, ${C.brand} 12%, transparent)`, bd: `color-mix(in srgb, ${C.brand} 32%, transparent)` },
        draft: { color: '#6fb0ff', bg: 'color-mix(in srgb, #6fb0ff 12%, transparent)', bd: 'color-mix(in srgb, #6fb0ff 34%, transparent)' },
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
          onDiagnose ? h('button', { type: 'button', className: 'wxmp-btn wxmp-focus', style: btn('ghost'), onClick: onDiagnose }, '查看诊断信息') : null,
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
      const prefs = useMemo(() => ({ ...DEFAULT_PREFS, ...loadPrefs() }), [])
      const [articles, setArticles] = useState(null) // null = 加载中
      const [listErr, setListErr] = useState(null)
      const [selected, setSelected] = useState(prefs.lastFile || '')
      const [detail, setDetail] = useState(null) // { data, text }
      const [detailBusy, setDetailBusy] = useState(false)
      const [detailErr, setDetailErr] = useState(null)
      const [draftCount, setDraftCount] = useState(null)
      const [busy, setBusy] = useState('') // 当前进行中的动作名
      const [toast, setToast] = useState(null)
      const [railCollapsed, setRailCollapsed] = useState(prefs.railCollapsed)
      const [stageOpen, setStageOpen] = useState(prefs.stageOpen)
      const [showSettings, setShowSettings] = useState(false)
      const [page, setPage] = useState(prefs.page || 0)
      const [backendOk, setBackendOk] = useState(true)
      const [diagText, setDiagText] = useState('')
      const [flow, setFlow] = useState({ step: 0, log: [] })
      const toastTimer = useRef(0)
      const aliveRef = useRef(true)
      const styleRef = useRef(null)

      useEffect(() => () => { aliveRef.current = false }, [])

      const notify = useCallback((text, tone = 'ok', holdMs = 3200) => {
        setToast({ text, tone })
        clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(() => setToast(null), holdMs)
      }, [])

      const pushLog = useCallback((line) => {
        setFlow((prev) => ({ ...prev, log: [...prev.log.slice(-60), line] }))
      }, [])

      const refreshList = useCallback(async (signal) => {
        setListErr(null)
        let outcome
        try {
          outcome = toOutcome(await api('list-articles', {}, signal))
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          setBackendOk(false)
          setListErr({ code: error.code || 'backend', message: error.message, hint: error.hint || hintFor('') })
          setArticles([])
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
        if (!selected && items.length) setSelected(items[0].path)
      }, [selected])

      useEffect(() => {
        const controller = new AbortController()
        // 初始化异步化：先画骨架，网络请求放微任务，不阻塞宿主输入框
        const kickoff = window.setTimeout(() => {
          void refreshList(controller.signal).catch((error) => {
            if (aliveRef.current) setListErr({ code: 'list_failed', message: error.message, hint: hintFor('') })
          })
          void api('state').then((payload) => {
            const outcome = toOutcome(payload)
            if (aliveRef.current && outcome.ok) setDraftCount(outcome.data.total ?? null)
          }).catch(() => {})
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
      }, [selected])

      const runAction = useCallback(
        async (name, op, params, label) => {
          if (busy) return
          setBusy(name)
          pushLog(`$ wxmp ${label}`)
          try {
            const outcome = toOutcome(await api(op, params))
            if (!aliveRef.current) return outcome
            if (outcome.ok) {
              pushLog(`✔ ${outcome.text.split('\n')[0] || '完成'}`)
              notify(outcome.text.split('\n')[0] || '完成', 'ok')
            } else {
              pushLog(`✘ ${outcome.error.message}`)
              notify(outcome.error.message, 'err', 6000)
            }
            return outcome
          } catch (error) {
            const err = { code: 'network', message: error.message, hint: hintFor('') }
            pushLog(`✘ ${error.message}`)
            notify(error.message, 'err', 6000)
            return { ok: false, error: err }
          } finally {
            if (aliveRef.current) setBusy('')
          }
        },
        [busy, notify, pushLog],
      )

      async function createDraft() {
        const outcome = await runAction('draft', 'draft-create', { file: selected }, 'draft create')
        if (outcome && outcome.ok) {
          setFlow((prev) => ({ ...prev, step: 4 }))
          await refreshList()
          void api('state').then((p) => { const o = toOutcome(p); if (o.ok) setDraftCount(o.data.total ?? null) })
        }
      }

      async function publishNow() {
        const mediaId = detail && detail.article && detail.article.article && detail.article.article.mediaId
        if (!mediaId) {
          notify('还没有草稿 id，先点「建草稿」', 'warn')
          return
        }
        const outcome = await runAction('publish', 'publish-submit', { mediaId }, 'publish submit')
        if (!outcome || !outcome.ok) return
        setFlow((prev) => ({ ...prev, step: 5 }))
        const publishId = outcome.data && outcome.data.publishId
        if (!publishId) return
        pushLog(`$ wxmp publish status ${publishId}`)
        // 轮询：异步任务，submit 成功不等于发布成功
        for (let attempt = 0; attempt < 20 && aliveRef.current; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
          const status = toOutcome(await api('publish-status', { publishId }))
          if (status.ok) {
            const code = status.data && status.data.publish_status
            if (code === 1) {
              pushLog('  · 发布中…')
              continue
            }
            pushLog(code === 0 ? '✔ 发布成功' : `! 发布未通过（状态 ${code}）`)
            notify(code === 0 ? '发布成功，链接已拿到' : `发布未通过（状态 ${code}）`, code === 0 ? 'ok' : 'err', 6000)
            return
          }
          break
        }
      }

      function collectDiagnostics() {
        const info = {
          plugin: '公众号文章工作台',
          version: VERSION,
          userAgent: navigator.userAgent,
          endpoint: API,
          selected,
          draftCount,
          articles: (articles || []).length,
          lastError: (detailErr && detailErr.message) || (listErr && listErr.message) || '',
          log: flow.log.slice(-20),
        }
        const text = JSON.stringify(info, null, 2)
        setDiagText(text)
        try {
          void navigator.clipboard?.writeText(text)
        } catch {
          /* 剪贴板不可用，文本已显示 */
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

      /* 骨架屏：列表还没回来时 */
      if (articles === null) {
        return h(
          'div',
          { ref: shellRef, className: 'wxmp-shell', style: pageStyle },
          h('style', null, CSS),
          h('div', { style: { maxWidth: 1080, margin: '0 auto' } },
            h(SectionTitle, null, '正在读取文章…'),
            h(Skeleton, { height: 54, radius: 12 }),
            h(Skeleton, { height: 54, radius: 12 }),
            h(Skeleton, { height: 54, radius: 12 }),
            h(Skeleton, { height: 160, radius: 12 }),
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
        { ref: shellRef, className: 'wxmp-shell', style: pageStyle },
        h('style', null, CSS),

        // ── 顶栏：主操作固定在这里，不随滚动跑丢 ──────────────
        h(
          'div',
          { style: topBarStyle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, '公众号文章工作台'),
            h(Badge, { tone: 'idle' }, `v${VERSION}`),
            h(Badge, { tone: backendOk ? 'ok' : 'err' }, backendOk ? '后台已连通' : '后台未响应'),
            h(Badge, { tone: draftCount == null ? 'idle' : 'ok' }, draftCount == null ? '草稿读取中' : `草稿箱 ${draftCount} 条`),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '打开设置：凭据、主题、数据清理',
              style: { ...btn('ghost'), marginLeft: 'auto' },
              onClick: () => setShowSettings(true),
            }, '设置'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-label': '复制诊断信息',
              style: btn('ghost'),
              onClick: collectDiagnostics,
            }, '诊断'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: { ...btn('primary'), padding: '8px 18px' },
              disabled: Boolean(busy) || !selected,
              onClick: publishNow,
            }, busy === 'publish' ? '正在提交…' : '发表到公众号'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('normal'),
              disabled: Boolean(busy) || !selected,
              onClick: createDraft,
            }, busy === 'draft' ? '正在建草稿…' : '建草稿'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('ghost'),
              disabled: Boolean(busy) || !selected,
              onClick: async () => {
                await runAction('cover', 'cover', { file: selected, badge: 'WXMP' }, 'cover')
                await refreshList()
              },
            }, busy === 'cover' ? '正在生成…' : '重新生成封面'),
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: btn('ghost'),
              disabled: Boolean(busy),
              onClick: async () => { await refreshList() },
            }, '刷新'),
          ),
        ),

        // ── 三栏主体 ──────────────────────────────────────────
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: stacked ? '1fr' : '248px minmax(0,1fr) auto', gap: 0, flex: 1, minHeight: 0, overflowY: stacked ? 'auto' : 'visible' } },

          // 左：文章列表
          h(
            'div',
            { className: 'wxmp-scroll', style: colStyle },
            h(SectionTitle, { extra: `${(articles || []).length} 篇` }, '我的文章'),
            listErr ? h(ErrorBox, { error: listErr, onRetry: () => void refreshList() }) : null,
            (articles || []).length === 0 && !listErr
              ? h('div', { style: { color: C.label3, fontSize: 12, lineHeight: 1.7 } },
                  '还没有文章。点下面按钮新建一篇，标题 32 字以内。')
              : null,
            h('div',
              { role: 'listbox', 'aria-label': '文章列表' },
              ...(articles || []).slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((item) =>
                h(
                  'button',
                  {
                    key: item.path,
                    type: 'button',
                    className: 'wxmp-card wxmp-focus',
                    'aria-selected': item.path === selected ? 'true' : 'false',
                    role: 'option',
                    style: {
                      display: 'block', width: '100%', textAlign: 'left',
                      border: `1px solid ${item.path === selected ? `color-mix(in srgb, ${C.brand} 55%, ${C.border1})` : C.border1}`,
                      background: item.path === selected ? `color-mix(in srgb, ${C.brand} 7%, ${C.l1})` : C.l1,
                      borderRadius: 10, padding: '9px 11px', marginBottom: 8, cursor: 'pointer',
                      color: 'inherit', font: 'inherit', fontFamily: FONT,
                    },
                    onClick: () => {
                      setSelected(item.path)
                      savePrefs({ lastFile: item.path })
                    },
                  },
                  h('div', { style: { fontWeight: 600, fontSize: 12.5, lineHeight: 1.45, marginBottom: 5 } }, item.title),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: C.label3 } },
                    item.mediaId ? h(Badge, { tone: 'draft' }, '草稿中') : h(Badge, { tone: 'idle' }, '未建草稿'),
                    h('span', null, item.updated || ''),
                  ),
                ),
              ),
            ),
            (articles || []).length > PAGE_SIZE
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px', fontSize: 11, color: C.label3 } },
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: { ...btn('ghost'), padding: '3px 9px', fontSize: 11 },
                    disabled: page === 0,
                    'aria-label': '上一页文章',
                    onClick: () => { const next = Math.max(0, page - 1); setPage(next); savePrefs({ page: next }) },
                  }, '上一页'),
                  h('span', null, `${page + 1} / ${Math.max(1, Math.ceil(articles.length / PAGE_SIZE))}`),
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: { ...btn('ghost'), padding: '3px 9px', fontSize: 11 },
                    disabled: (page + 1) * PAGE_SIZE >= (articles || []).length,
                    'aria-label': '下一页文章',
                    onClick: () => { const next = page + 1; setPage(next); savePrefs({ page: next }) },
                  }, '下一页'))
              : null,
            h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              style: { ...btn('normal'), width: '100%', marginTop: 6 },
              onClick: async () => {
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
            }, busy === 'new' ? '正在创建…' : '＋ 写一篇新文章'),
          ),

          // 中：预览
          h(
            'div',
            { className: 'wxmp-scroll', style: { ...colStyle, borderRight: 'none' } },
            h(SectionTitle, { extra: '手机宽度模拟' }, '预览'),
            detailErr ? h(ErrorBox, { error: detailErr, onRetry: () => setSelected(selected) }) : null,
            detailBusy
              ? h('div', null, h(Skeleton, { height: 200, radius: 12 }), h(Skeleton, { height: 16 }), h(Skeleton, { height: 16 }), h(Skeleton, { height: 16, width: '60%' }))
              : selected && article
                ? h(
                    'div',
                    { style: { border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', background: '#fff', color: '#1a1a1a' } },
                    h('div', { style: { aspectRatio: '2.35 / 1', background: `linear-gradient(135deg,${C.brand},#059b4c)`, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 12, opacity: .9 } }, '封面'),
                    h(
                      'div',
                      { style: { padding: '18px 18px 26px', fontSize: 13.5, lineHeight: 1.8 } },
                      h('div', { style: { fontSize: 19, fontWeight: 700, lineHeight: 1.45, marginBottom: 8 } }, article.title),
                      h('div', { style: { fontSize: 11.5, color: '#999', marginBottom: 12 } }, article.author || ''),
                      h('div', { style: { background: '#f7f7f7', borderRadius: 6, padding: '9px 11px', fontSize: 12, color: '#666', marginBottom: 14 } }, article.digest || '（无摘要）'),
                      h('div', { style: { color: '#666', fontSize: 12 } }, `正文 ${article.body ? article.body.length : 0} 字符 · 主题 ${article.theme || 'default'}`),
                      h('div', { style: { marginTop: 12, color: '#999', fontSize: 11.5 } }, '完整排版点下方「打开本地预览」在新标签查看。'),
                    ),
                  )
                : h('div', { style: { color: C.label3, fontSize: 12, padding: '20px 0' } }, '左边选一篇文章就能看到预览。'),
            selected && article
              ? h('div', { style: { marginTop: 12 } },
                  h('button', {
                    type: 'button',
                    className: 'wxmp-btn wxmp-focus',
                    style: btn('normal'),
                    onClick: async () => {
                      const outcome = await runAction('preview', 'preview-article', { file: selected }, 'article preview')
                      if (outcome && outcome.ok && outcome.data && outcome.data.path) {
                        notify(`预览已生成：${outcome.data.path}`, 'ok', 5000)
                      }
                    },
                  }, busy === 'preview' ? '正在生成…' : '打开本地预览'))
              : null,
          ),

          // 右：状态 + 流水线（可折叠）
          railCollapsed
            ? h('div', { style: { width: 44, borderLeft: `1px solid ${C.border1}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 14 } },
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '展开状态栏',
                  'aria-expanded': false,
                  style: { ...btn('ghost'), writingMode: 'vertical-rl', padding: '10px 4px' },
                  onClick: () => { setRailCollapsed(false); savePrefs({ railCollapsed: false }) },
                }, '展开状态 ▸'))
            : h(
                'div',
                { className: 'wxmp-scroll', style: { width: 286, minWidth: 240, borderLeft: `1px solid ${C.border1}`, padding: 14, overflowY: 'auto', minHeight: 0 } },
                h(SectionTitle, { extra: h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  'aria-label': '收起状态栏',
                  'aria-expanded': true,
                  style: { ...btn('ghost'), padding: '2px 7px', fontSize: 11 },
                  onClick: () => { setRailCollapsed(true); savePrefs({ railCollapsed: true }) },
                }, '收起') }, '状态'),

                report
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
                    style: { ...btn('ghost'), padding: '2px 7px', fontSize: 11 },
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
              onClearData: () => {
                try { window.localStorage.removeItem(STORE_KEY) } catch { /* 忽略 */ }
                setRailCollapsed(false); setStageOpen(true); setFlow({ step: 0, log: [] })
                notify('已清除本插件的界面数据', 'ok')
              },
              diagText,
              onDiagnose: collectDiagnostics,
              version: VERSION,
              endpoint: API,
              draftCount,
              onRefreshCount: () => void api('state').then((p) => { const o = toOutcome(p); if (o.ok) setDraftCount(o.data.total ?? null) }),
              busy,
              runAction,
            })
          : null,

        h(Toast, { toast }),
      )
    }

    const STAGES = [
      { key: 'write', name: '写稿', desc: 'Markdown 正文与 front matter' },
      { key: 'check', name: '校验', desc: '标题 / 摘要 / 正文长度在限内' },
      { key: 'cover', name: '封面', desc: '生成 900×383 并上传为永久素材' },
      { key: 'draft', name: '草稿箱', desc: '建草稿，拿到 media_id' },
      { key: 'publish', name: '发表', desc: '提交发布任务并轮询结果' },
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

    /* ── 设置（内联浮层，符合 E 的关闭三件套） ─────────────── */
    function SettingsModal(props) {
      const { onClose, notify, onClearData, diagText, onDiagnose, version, draftCount, onRefreshCount, runAction, busy } = props
      const panelRef = useRef(null)
      const closeRef = useRef(null)
      const [appid, setAppid] = useState('')
      const [secret, setSecret] = useState('')
      const [advanced, setAdvanced] = useState(false)
      const [resetting, setResetting] = useState(false)

      // Esc 关闭 + 焦点陷阱 + 关闭后焦点回到触发按钮
      useEffect(() => {
        const previous = document.activeElement
        const node = panelRef.current
        const focusables = () => Array.from(node ? node.querySelectorAll('button,input,[tabindex]:not([tabindex="-1"])') : [])
        const first = focusables()[0]
        if (first && first.focus) first.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
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
      }, [onClose])

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
              style: { ...btn('ghost'), marginLeft: 'auto' },
              onClick: onClose,
            }, '关闭'),
          ),

          h(SectionTitle, null, '常用'),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.7, marginBottom: 8 } },
            '填公众号的 AppID 和 AppSecret。只存在本机配置文件，界面和错误信息里都会打码。'),
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

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, {
            extra: h('button', {
              type: 'button',
              className: 'wxmp-btn wxmp-focus',
              'aria-expanded': advanced,
              style: { ...btn('ghost'), padding: '2px 7px', fontSize: 11 },
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
                    style: btn('ghost'),
                    onClick: onDiagnose,
                  }, '复制诊断信息'),
                ),
                h('button', {
                  type: 'button',
                  className: 'wxmp-btn wxmp-focus',
                  style: { ...btn('normal'), alignSelf: 'flex-start' },
                  disabled: Boolean(busy),
                  onClick: async () => {
                    const outcome = await runAction('clearCred', 'config-clear', {}, 'config clear')
                    if (outcome && outcome.ok) notify('已清除本机凭据', 'ok')
                  },
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
              // 恢复宿主默认界面：清掉选中态、收起浮层，回到对话主区域
              try { window.localStorage.removeItem(STORE_KEY) } catch { /* 忽略 */ }
              setShowSettings(false)
              notify('已把主区域还给宿主默认界面，入口仍在左侧栏', 'ok')
            },
          }, '恢复宿主默认界面'),

          h('div', { style: { height: 1, background: C.border1, margin: '18px 0 14px' } }),
          h(SectionTitle, null, '本插件存了什么'),
          h('div', { style: { fontSize: 12, color: C.label2, lineHeight: 1.75, marginBottom: 10 } },
            h('div', null, '· 界面偏好（折叠状态、上次选中的文章）存在浏览器 localStorage，键名 ', h('code', { style: monoStyle }, 'wxmp.ui.v1'), '。'),
            h('div', null, '· 文章和凭据存在本机文件目录，不随卸载自动删除。'),
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
              onClick: () => { setResetting(true); onClearData(); setResetting(false) },
            }, resetting ? '已清除' : '清除界面数据（不改文章）'),
          ),

          diagText
            ? h('div', { style: { marginTop: 14 } },
                h(SectionTitle, null, '诊断信息（已尽量复制到剪贴板）'),
                h('pre', { className: 'wxmp-scroll', style: { ...monoStyle, display: 'block', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', padding: 10, border: `1px solid ${C.border1}`, borderRadius: 8 } }, diagText),
              )
            : null,

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
              { name: 'sidebar.panellist', id: PANEL_ID, order: 31, label: () => '公众号文章' },
              PanelIcon,
            ),
          ),
        )

        ctx.effect(() =>
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Workbench)),
        )

        return () => {
          document.querySelectorAll('style[data-plugin="@local/wxmp"]').forEach((node) => node.remove())
        }
      },
    }
  },
})
