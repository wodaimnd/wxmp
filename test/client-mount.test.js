/**
 * 客户端半的「桩挂载」验证 —— 真正 apply 一遍，看槽位有没有注册出来。
 *
 * 为什么需要它：
 *   `guard_check_bundle` 的槽位清单是硬编码的，宿主新增的合法槽位它不认识，
 *   会把 `shell.overlay` 报成「未知槽位」。那种告警不能证明渲染坏了，也不能证明没坏。
 *   所以这里用一份最小桩（只提供 client.js 真正用到的宿主能力）把 apply 跑一遍，
 *   直接断言「注册了哪几个槽位、id/key 对不对」。
 *
 * 这个测试能抓住的真实故障：
 *   - 槽位拼错（比如把 sidebar.panellist 写成 sidebar.panelList）→ 永远不渲染，且宿主不报错
 *   - main.key ≠ panellist.id → 侧栏有条目、点进去空白
 *   - 注册没包在 ctx.effect 里 → 禁用插件后残留
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 造一份最小宿主桩，返回注册结果。 */
function mountClient() {
  const registered = []
  const effects = []
  const injected = []

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
  }

  const ctx = {
    effect: (fn) => {
      effects.push(fn)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject: (name, fn) => {
        // 记录 inject 的槽位名：这是真正决定"内容塞到哪个槽"的参数。
        // 只记录 register 的 meta.name 抓不到 inject 拼错的故障。
        injected.push(name)
        fn()
        return () => {}
      },
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    locale: { t: (key) => key },
  }

  let factoryFn = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        factoryFn = factory
      },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
  const fakeDocument = {
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {} },
  }

  const source = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  // client.js 是自执行 IIFE，会调用 window.__ModuleLoader__.load
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(fakeWindow, fakeDocument)

  assert.ok(factoryFn, '没捕获到 __ModuleLoader__.load 的 factory，说明入口形态变了')
  const mod = factoryFn((name) => {
    if (name === 'react') return React
    throw new Error(`出现了未预期的 require 依赖：${name}（面板半只能 require react）`)
  })

  mod.apply(ctx)
  return { registered, effects, injected, mod }
}

test('桩挂载：两个槽位全部注册成功', () => {
  const { registered } = mountClient()
  const names = registered.map((item) => item.meta.name).sort()
  // footer.action 与 shell.overlay 都已移除：
  //   前者是侧栏底部那个 ⤢ 占位置，后者是"全屏工作台"——用户明确说不需要了。
  // 现在只剩「侧栏条目 + 主区」这一对，正好是 panellist ↔ main 的最小闭环。
  assert.deepEqual(names, ['main', 'sidebar.panellist'])
})

test('桩挂载：槽位名必须逐字正确（拼错的槽位宿主不报错，只是永远不渲染）', () => {
  const { registered } = mountClient()
  const names = registered.map((item) => item.meta.name)
  for (const expected of ['main', 'sidebar.panellist']) {
    assert.ok(
      names.includes(expected),
      `槽位 ${expected} 没注册；实际注册了 ${names.join(', ')}`,
    )
  }
  assert.equal(names.length, 2, `注册了 ${names.length} 个槽位，预期 2 个：${names.join(', ')}`)
})

test('桩挂载：全屏工作台已删除（不再占用 shell.overlay）', () => {
  const { registered, injected } = mountClient()
  const names = registered.map((item) => item.meta.name)
  assert.ok(!names.includes('shell.overlay'), 'shell.overlay 不该再注册：全屏功能已按用户要求删除')
  assert.ok(!injected.includes('shell.overlay'), 'shell.overlay 不该再 inject')
  // 源码里也不该还有残留组件：删了注册却留着组件，下次有人会以为它还在用
  const source = fs.readFileSync(path.join(root, 'dsh-plugin', 'client.js'), 'utf8')
  assert.ok(!source.includes('WorkbenchOverlay'), 'client.js 里还残留 WorkbenchOverlay 组件')
  assert.ok(!source.includes('onExpand'), 'client.js 里还残留 onExpand 死 prop')
  assert.ok(!source.includes('openListeners'), 'client.js 里还残留 openListeners 订阅机制')
})

test('桩挂载：slot 名与宿主真实清单逐一核对（桩本身无法证伪拼错的槽位名）', () => {
  // 必须说实话：单看 register 的 meta.name 抓不到 inject 拼错的情况
  // —— `inject('shell.overlays')` 里传的字符串才是决定内容塞到哪个槽的参数。
  // 所以 inject 与 register 两处都要核对，且必须一致。
  //
  // 合法清单来自宿主实测（cordis_inspect_query → listSubTree）：
  //   shell.overlay        kind=list  scope=root  replaceRisk=none
  //   sidebar.footer.action kind=list scope=root  replaceRisk=none
  //   sidebar.panellist    kind=list  scope=root
  //   main                 kind=keyed scope=root
  // 后两个本插件主动不用了（footer.action 占位置、shell.overlay 是全屏浮层的家），
  // 但保留在合法清单里 —— 这张表描述的是"宿主允许什么"，不是"我们用不用"。
  const HOST_SLOTS = new Set(['main', 'sidebar.panellist', 'shell.overlay'])
  const { registered, injected } = mountClient()

  for (const name of injected) {
    assert.ok(
      HOST_SLOTS.has(name),
      `inject 用了不存在的槽位 "${name}"（宿主的合法槽位：${[...HOST_SLOTS].join(', ')}）。拼错时宿主不报错，只是永远不渲染。`,
    )
  }
  for (const item of registered) {
    assert.ok(HOST_SLOTS.has(item.meta.name), `register 用了不存在的槽位 "${item.meta.name}"`)
  }
  // inject 与 register 必须指向同一个槽：一个注册到 A 却注入到 B，内容会消失
  for (const item of registered) {
    assert.ok(
      injected.includes(item.meta.name),
      `注册了 ${item.meta.name} 但没 inject 同名槽位（注册了却没注入，内容不会出现）`,
    )
  }
})

test('桩挂载：panellist.id 与 main.key 字面相同（否则侧栏有条目、点进去空白）', () => {
  const { registered } = mountClient()
  const panellist = registered.find((item) => item.meta.name === 'sidebar.panellist')
  const main = registered.find((item) => item.meta.name === 'main')
  assert.ok(panellist && main)
  assert.equal(main.meta.key, panellist.meta.id, 'main.key 必须等于 panellist.id')
  assert.equal(typeof panellist.meta.order, 'number', 'panellist 需要 order 排位')
})

test('桩挂载：所有注册都在 ctx.effect 里（禁用后能回收）', () => {
  const { effects } = mountClient()
  // 样式注入 + 2 个槽位；至少要有 3 个 effect
  assert.ok(effects.length >= 3, `effect 数量 ${effects.length} 少于预期（样式 + 2 槽位）`)
})

test('桩挂载：inject 只声明 slots（不做全有闸门）', () => {
  const { mod } = mountClient()
  assert.deepEqual(mod.inject, ['slots'], '模块级 inject 只该声明 slots，其余按块 inject')
})
