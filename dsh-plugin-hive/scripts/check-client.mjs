#!/usr/bin/env node
/**
 * scripts/check-client.mjs —— client.js 的最小桩自检（零依赖，node 直跑）
 * ============================================================================
 * 为什么要这个：client.js 是**浏览器自注册脚本**，Node 里不能直接 import。
 * 这里用 node:vm 造一个最小浏览器环境（window.__ModuleLoader__ / document /
 * fetch / 定时器），把 client.js 当普通脚本执行，然后：
 *
 *   A. 加载层    —— load 只被调一次、id 对、factory 返回 { inject:['slots'], apply }
 *   B. 槽位      —— sidebar.panellist（id/order/label）+ main（key）各注册一次
 *   C. 图标      —— 内联 SVG 蜂巢、amber 渐变、active 多一圈高亮描边
 *   D. 清理      —— 卸载后注入的 <style> 被移除，effect 都登记了
 *   E. 样式      —— 只写 [data-hive-*]，不碰宿主全局选择器；iframe 高度 = calc(100% - 48px)
 *   F. 契约      —— 六个按钮要打的接口字符串全在；有降级兜底链
 *   G. 归一化    —— /setup/doctor、/plugin/doctor、旧 /doctor 三种返回体都能读成同一张表
 *   H. 请求封装  —— 500 / 非 JSON / 网络异常都给得出人话原因（不吞错）
 *   I. 不白屏    —— 真的把面板渲染一遍（桩 React + hook 运行时）：
 *                   · 正常后端 → 控制条六按钮 + iframe(src=/hive/)
 *                   · 后端全挂 → 引导卡片出现，且不抛异常
 *
 * 用法：node scripts/check-client.mjs   （退出码 0 = 全 PASS，1 = 有 FAIL）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'client.js')

/* ══════════════════════════ 断言框架 ══════════════════════════ */

const checks = []
let failed = 0

/** 登记一条断言。fn 返回 true 通过；返回 string 视为失败原因；抛异常也算失败。 */
function check(section, name, fn) {
  checks.push({ section, name, fn })
}

async function runAll() {
  let current = ''
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]
    if (c.section !== current) {
      current = c.section
      console.log('\n[' + current + ']')
    }
    let ok = true
    let why = ''
    try {
      const r = await c.fn()
      if (r !== true) {
        ok = false
        why = typeof r === 'string' ? r : '断言返回了 ' + JSON.stringify(r)
      }
    } catch (e) {
      ok = false
      why = e && e.message ? e.message : String(e)
    }
    if (!ok) failed++
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + String(i + 1).padStart(2, '0') + ' ' + c.name + (ok ? '' : '\n       ↳ ' + why))
  }
  return { total: checks.length, failed: failed }
}

/* ══════════════════════════ 桩：DOM ══════════════════════════ */

function makeDom() {
  const head = {
    children: [],
    appendChild(el) {
      el.parentNode = head
      head.children.push(el)
      return el
    },
    removeChild(el) {
      const i = head.children.indexOf(el)
      if (i >= 0) head.children.splice(i, 1)
      el.parentNode = null
      return el
    },
  }
  const document = {
    head,
    hidden: false,
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attrs: {},
        parentNode: null,
        textContent: '',
        setAttribute(k, v) {
          this.attrs[k] = String(v)
        },
        getAttribute(k) {
          return this.attrs[k]
        },
        remove() {
          if (this.parentNode) this.parentNode.removeChild(this)
        },
      }
    },
  }
  return { document, head }
}

/* ══════════════════════════ 桩：React + hook 运行时 ══════════════════════════ */

const flatten = (arr) => arr.reduce((acc, v) => acc.concat(Array.isArray(v) ? flatten(v) : v), [])

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: flatten(children).filter((c) => c !== null && c !== undefined && c !== false) }
}

/**
 * 极简 hook 运行时：足够把面板「渲染一遍」而不抛异常。
 * 只实现面板真正用到的 useState / useEffect / useRef（deps 忽略，首轮 effect 只跑一次，
 * 之后由 setState 触发的重渲染不再重跑 effect —— 否则 fetch effect 会自激）。
 */
function createHarness() {
  const hState = []
  const hRefs = []
  let cursor = 0
  let dirty = false
  let effects = []
  let ranEffects = false
  const cleanups = []

  const React = {
    createElement,
    useState(init) {
      const i = cursor++
      if (!(i in hState)) hState[i] = typeof init === 'function' ? init() : init
      const set = (v) => {
        hState[i] = typeof v === 'function' ? v(hState[i]) : v
        dirty = true
      }
      return [hState[i], set]
    },
    useEffect(fn) {
      cursor++
      effects.push(fn)
    },
    useRef(init) {
      const i = cursor++
      if (!(i in hRefs)) hRefs[i] = { current: init }
      return hRefs[i]
    },
  }

  /** 把函数组件逐层展开成宿主元素树（宿主元素 = type 是字符串）。 */
  function resolve(node, depth = 0) {
    if (depth > 12) throw new Error('组件展开层级过深（疑似递归组件）')
    if (node && typeof node === 'object' && typeof node.type === 'function') {
      const before = cursor
      cursor = 0 // 每个函数组件从自己的 hook 槽 0 开始
      const out = node.type(node.props || {})
      if (depth > 0) cursor = before // 还原外层光标，避免嵌套函数组件串扰
      return resolve(out, depth + 1)
    }
    return node
  }

  function pass(Comp, props) {
    cursor = 0
    dirty = false
    effects = []
    const tree = resolve(Comp(props))
    if (!ranEffects) {
      ranEffects = true
      for (const fn of effects) {
        const c = fn()
        if (typeof c === 'function') cleanups.push(c)
      }
    }
    effects = []
    return tree
  }

  let mounted = null
  let lastTree = null

  /** 让 effect 里的 fetch 落地，再把 setState 引起的重渲染走完（有上限，防死循环）。 */
  async function settleTree(seed) {
    let tree = seed
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 0))
      if (!dirty) break
      tree = pass(mounted.Comp, mounted.props)
      dirty = false
    }
    lastTree = tree
    return tree
  }

  return {
    React,
    async mount(Comp, props) {
      mounted = { Comp, props }
      lastTree = pass(Comp, props)
      return await settleTree(lastTree)
    },
    /** 交互后把 state 变引起的重渲染走完（模拟「点一下，等界面稳定」）。 */
    async settle() {
      if (!mounted) throw new Error('还没 mount，无法 settle')
      return await settleTree(lastTree)
    },
    unmount() {
      for (const c of cleanups.splice(0)) {
        try {
          c()
        } catch {
          /* 清理失败不影响断言 */
        }
      }
    },
  }
}

/* ══════════════════════════ 树遍历工具 ══════════════════════════ */

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (typeof node === 'object') {
    visit(node)
    for (const c of node.children || []) walk(c, visit)
  }
}

function collect(node) {
  const elements = []
  const texts = []
  walk(node, (n) => {
    if (n.text !== undefined) texts.push(n.text)
    else elements.push(n)
  })
  return { elements, texts, text: texts.join(' ') }
}

function findByType(tree, type) {
  return collect(tree).elements.filter((e) => e.type === type)
}

/** 一个节点的可见文本（递归拼）。 */
function nodeText(node) {
  return collect(node).texts.join(' ')
}

/* ══════════════════════════ 加载 client.js ══════════════════════════ */

if (!fs.existsSync(clientPath)) {
  console.error('找不到 client.js：' + clientPath)
  process.exit(1)
}
const code = fs.readFileSync(clientPath, 'utf8')
const lineCount = code.split(/\r?\n/).length
const byteSize = Buffer.byteLength(code, 'utf8')

// 每次 loadClient() 都重建一整套桩，保证测试之间互不污染
function loadClient(opts = {}) {
  const dom = makeDom()
  const loads = []
  const timers = { timeouts: [], intervals: [], clearedTimeout: [], clearedInterval: [] }
  let nextTimerId = 1
  const harness = { fetchImpl: null }

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: dom.document,
    window: {
      __ModuleLoader__: {
        load(spec) {
          loads.push(spec)
        },
      },
    },
    setTimeout(fn, ms) {
      timers.timeouts.push({ ms })
      return nextTimerId++
    },
    clearTimeout(id) {
      timers.clearedTimeout.push(id)
    },
    setInterval(fn, ms) {
      timers.intervals.push({ ms })
      return nextTimerId++
    },
    clearInterval(id) {
      timers.clearedInterval.push(id)
    },
    fetch(url, init) {
      return harness.fetchImpl(url, init)
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(code, { filename: clientPath }).runInContext(sandbox)

  const spec = loads[0]
  return { loads, spec, dom, timers, harness, sandbox }
}

/** 造一个「浏览器 Response 桩」。 */
function res(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text
    },
  }
}

/** 用固定路由表做 fetch 桩；未知路径 404。 */
function routerFetch(routes) {
  return (url) => {
    const u = String(url)
    for (const key of Object.keys(routes)) {
      if (u === key || u.endsWith(key)) {
        const r = routes[key]
        if (typeof r === 'function') return r(u)
        return Promise.resolve(r)
      }
    }
    return Promise.resolve(res({ error: 'not found: ' + u }, 404))
  }
}

/* ══════════════════════════ A. 加载层 ══════════════════════════ */

const loaded = loadClient()

check('A · 加载层', 'window.__ModuleLoader__.load 只被调用一次', () => {
  if (loaded.loads.length !== 1) return '调用次数 = ' + loaded.loads.length
  return true
})

check('A · 加载层', 'bundle id === "dsh-plugin-hive"', () => {
  const id = loaded.spec && loaded.spec.id
  if (id !== 'dsh-plugin-hive') return '实际 id = ' + JSON.stringify(id)
  return true
})

const REQUIRED_MODULES = ['react']
check('A · 加载层', 'factory 只 require react（无 npm 包 / 无 CDN）', () => {
  const stub = loadClient()
  const requested = []
  const mod = stub.spec.factory((name) => {
    requested.push(name)
    if (name === 'react') return createHarness().React
    throw new Error('client.js 试图 require 未允许的模块：' + name)
  })
  if (requested.length !== 1 || requested[0] !== 'react') return 'require 调用 = ' + JSON.stringify(requested)
  if (!mod || typeof mod !== 'object') return 'factory 没返回对象'
  return true
})

check('A · 加载层', 'factory 返回 { inject: ["slots"], apply:function }', () => {
  const mod = loaded.spec.factory((name) => (name === 'react' ? createHarness().React : null))
  if (!Array.isArray(mod.inject)) return 'inject 不是数组'
  if (mod.inject.length !== 1 || mod.inject[0] !== 'slots') return 'inject = ' + JSON.stringify(mod.inject)
  if (typeof mod.apply !== 'function') return 'apply 不是函数'
  if (!mod.__test) return '缺少 __test 挂点（自检脚本需要）'
  return true
})

/** 把函数组件逐层展开成宿主元素树（只用于无 hook 的组件，例如侧栏图标）。 */
function expand(node, depth = 0) {
  if (depth > 12) return node
  if (node && typeof node === 'object' && typeof node.type === 'function') {
    return expand(node.type(node.props || {}), depth + 1)
  }
  return node
}

/** 每次要一份「干净的一次 apply」：新建沙箱 → 造模块 → 应用 → 返回全部记录。 */
function freshApply(opts = {}) {
  const stub = loadClient()
  if (opts.fetchImpl) stub.harness.fetchImpl = opts.fetchImpl
  const mod = stub.spec.factory((n) => (n === 'react' ? createHarness().React : null))
  const made = makeCtx(mod, opts)
  mod.apply(made.ctx)
  return { stub, mod, ...made }
}

/* ══════════════════════════ B. 槽位注册 ══════════════════════════ */

/** 造一个假的 ctx（slots + locale + effect 全记录）。 */
function makeCtx(mod, opts = {}) {
  const calls = { inject: [], register: [], effects: [], dispose: [], locale: [], logs: [] }
  const slots = {
    inject(name, fn) {
      calls.inject.push(name)
      return fn()
    },
    register(meta, comp) {
      calls.register.push({ meta, comp })
      return () => calls.unregistered && calls.unregistered.push(meta)
    },
  }
  const locale = opts.noLocale
    ? undefined
    : {
        register(ns, lang, dict) {
          calls.locale.push({ ns, lang, keys: Object.keys(dict || {}).length })
          return () => {}
        },
        bind(ns) {
          return (key) => (mod.__test.DICT.zh[key] !== undefined ? mod.__test.DICT.zh[key] : key)
        },
      }
  const ctx = {
    effect(fn, label) {
      calls.effects.push(label)
      const d = fn()
      if (typeof d === 'function') calls.dispose.push(d)
      return d
    },
    get(name) {
      if (name === 'slots') return opts.noSlots ? undefined : slots
      if (name === 'locale') return locale
      return undefined
    },
  }
  return { ctx, calls, slots }
}

check('B · 槽位注册', 'apply(ctx) 不抛异常', () => {
  const mod = loaded.spec.factory((n) => (n === 'react' ? createHarness().React : null))
  const { ctx } = makeCtx(mod)
  mod.apply(ctx)
  return true
})

const applied = freshApply()

check('B · 槽位注册', 'slots.inject 依次注入 sidebar.panellist、main', () => {
  const got = applied.calls.inject
  if (got.length !== 2) return 'inject 次数 = ' + got.length + '（期望 2）'
  if (got[0] !== 'sidebar.panellist') return '第 1 个 = ' + got[0]
  if (got[1] !== 'main') return '第 2 个 = ' + got[1]
  return true
})

check('B · 槽位注册', '两个槽位各 register 一次（共 2 次）', () => {
  if (applied.calls.register.length !== 2) return 'register 次数 = ' + applied.calls.register.length
  return true
})

check('B · 槽位注册', 'sidebar.panellist 元数据 = { id:"hive", order:30, label()==="HIVE" }', () => {
  const meta = applied.calls.register[0] && applied.calls.register[0].meta
  if (!meta) return '没有第 1 个注册'
  if (meta.name !== 'sidebar.panellist') return 'name = ' + meta.name
  if (meta.id !== 'hive') return 'id = ' + JSON.stringify(meta.id)
  if (meta.order !== 30) return 'order = ' + JSON.stringify(meta.order)
  if (typeof meta.label !== 'function') return 'label 不是函数（宿主按函数取文案）'
  const label = meta.label()
  if (label !== 'HIVE') return 'label() = ' + JSON.stringify(label)
  return true
})

check('B · 槽位注册', 'main 元数据 = { key:"hive" }（与侧栏 id 同名联动）', () => {
  const meta = applied.calls.register[1] && applied.calls.register[1].meta
  if (!meta) return '没有第 2 个注册'
  if (meta.name !== 'main') return 'name = ' + meta.name
  if (meta.key !== 'hive') return 'key = ' + JSON.stringify(meta.key)
  if (meta.key !== applied.calls.register[0].meta.id) return 'key 与侧栏 id 不同名，面板不会被切换'
  return true
})

check('B · 槽位注册', '两个注册的组件都是函数', () => {
  for (let i = 0; i < applied.calls.register.length; i++) {
    if (typeof applied.calls.register[i].comp !== 'function') return '第 ' + (i + 1) + ' 个组件不是函数'
  }
  return true
})

check('B · 槽位注册', '拿不到 slots 服务时只打日志、不抛异常', () => {
  const fresh = freshApply({ noSlots: true })
  if (fresh.calls.register.length !== 0) return '没有 slots 却注册了 ' + fresh.calls.register.length + ' 次'
  return true
})

check('B · 槽位注册', '没有 locale 服务时用内置中文兜底（label 仍为 HIVE）', () => {
  const fresh = freshApply({ noLocale: true })
  const label = fresh.calls.register[0].meta.label()
  if (label !== 'HIVE') return 'label() = ' + JSON.stringify(label)
  if (fresh.calls.locale.length !== 0) return '没有 locale 却登记了文案'
  return true
})

/* ══════════════════════════ C. 侧栏图标 ══════════════════════════ */

check('C · 侧栏图标', '渲染内联 <svg>（不依赖外部图片）', () => {
  const icon = applied.calls.register[0].comp
  const tree = expand(icon({ size: 22, active: false }))
  if (!tree || tree.type !== 'svg') return '根元素 = ' + String(tree && tree.type)
  if (tree.props.width !== 22 || tree.props.height !== 22) return '尺寸没跟着 size 走：' + tree.props.width
  const { elements } = collect(tree)
  if (!elements.some((e) => e.type === 'linearGradient')) return '缺少 linearGradient（amber 渐变）'
  return true
})

check('C · 侧栏图标', '渐变色 = #ffb648 → #f2701f', () => {
  const tree = expand(applied.calls.register[0].comp({ size: 20, active: false }))
  const stops = collect(tree).elements.filter((e) => e.type === 'stop').map((e) => String(e.props.stopColor).toLowerCase())
  if (stops.indexOf('#ffb648') < 0) return '缺少 #ffb648，实际 = ' + JSON.stringify(stops)
  if (stops.indexOf('#f2701f') < 0) return '缺少 #f2701f，实际 = ' + JSON.stringify(stops)
  return true
})

check('C · 侧栏图标', 'active 时多一圈高亮描边（path 数量 +1）', () => {
  const icon = applied.calls.register[0].comp
  const off = collect(expand(icon({ size: 20, active: false }))).elements.filter((e) => e.type === 'path')
  const on = collect(expand(icon({ size: 20, active: true }))).elements.filter((e) => e.type === 'path')
  if (on.length !== off.length + 1) return 'inactive=' + off.length + ' 条 path，active=' + on.length + ' 条（期望多 1）'
  const ring = on[on.length - 1]
  if (String(ring.props.stroke).toLowerCase() !== '#ffcf7a') return '高亮描边颜色 = ' + ring.props.stroke
  return true
})

check('C · 侧栏图标', '每次渲染的渐变 id 唯一（多实例不串色）', () => {
  const icon = applied.calls.register[0].comp
  const idOf = (t) => collect(expand(t)).elements.find((e) => e.type === 'linearGradient').props.id
  const a = idOf(icon({ size: 20, active: true }))
  const b = idOf(icon({ size: 20, active: true }))
  if (a === b) return '两次渲染拿到同一个 id：' + a
  return true
})

/* ══════════════════════════ D. 样式注入与清理 ══════════════════════════ */

check('D · 清理', 'apply 时注入 1 个 <style data-plugin-css="dsh-plugin-hive">', () => {
  const styles = applied.stub.dom.head.children
  if (styles.length !== 1) return 'head 里有 ' + styles.length + ' 个 style'
  if (styles[0].attrs['data-plugin-css'] !== 'dsh-plugin-hive') return 'data-plugin-css = ' + styles[0].attrs['data-plugin-css']
  if (!styles[0].textContent || styles[0].textContent.length < 500) return '样式内容过短（' + (styles[0].textContent || '').length + ' 字节）'
  return true
})

check('D · 清理', '所有 effect 都登记了（样式 + 中英文案 + 两个槽位 = 5）', () => {
  if (applied.calls.effects.length !== 5) return 'effect 次数 = ' + applied.calls.effects.length + '：' + JSON.stringify(applied.calls.effects)
  return true
})

check('D · 清理', '跑完 disposer 后 <style> 被移除（head 清空）', () => {
  const head = applied.stub.dom.head
  for (const d of applied.calls.dispose) d()
  if (head.children.length !== 0) return '卸载后 head 还剩 ' + head.children.length + ' 个节点'
  return true
})

check('D · 清理', 'locale 中英文各登记一次（命名空间 hive）', () => {
  const langs = applied.calls.locale.map((l) => l.lang).sort()
  if (langs.join(',') !== 'en,zh') return '登记的语言 = ' + JSON.stringify(langs)
  if (applied.calls.locale.some((l) => l.ns !== 'hive')) return '命名空间不是 hive'
  if (applied.calls.locale.some((l) => l.keys < 30)) return '文案条数偏少：' + JSON.stringify(applied.calls.locale)
  return true
})

check('D · 清理', '两个槽位的 disposer 都能拿到（交给宿主统一回收）', () => {
  // 样式 disposer 由 apply 自己持有（返回 undefined 不给 ctx.effect），
  // 这里能收到的是：中英文案 2 个 + 两个槽位 2 个 = 4
  if (applied.calls.dispose.length < 4) return 'disposer 只有 ' + applied.calls.dispose.length + ' 个：' + JSON.stringify(applied.calls.effects)
  return true
})

/* ══════════════════════════ E. 样式安全 ══════════════════════════ */

/** 扫出 CSS 里所有选择器（含 @media 内层）。 */
function selectorsOf(css) {
  const out = []
  let buf = ''
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      const sel = buf.trim()
      if (sel) out.push(sel)
      buf = ''
      depth++
    } else if (ch === '}') {
      buf = ''
      if (depth > 0) depth--
    } else if (ch === ';' && depth === 0) {
      buf = ''
    } else {
      buf += ch
    }
  }
  return out
}

check('E · 样式安全', '每条规则都限定在 [data-hive-*]（不覆盖宿主样式）', () => {
  const css = applied.mod.__test.CSS
  const sels = selectorsOf(css)
  if (sels.length < 40) return '解析到的规则数偏少：' + sels.length
  const bad = []
  for (const sel of sels) {
    for (const part of sel.split(',')) {
      const s = part.trim()
      if (!s) continue
      if (s.startsWith('@media') || s.startsWith('@keyframes')) continue
      if (/^[\d.%]+$/.test(s)) continue // keyframes 里的 0%/50%/100%
      if (!s.startsWith('[data-hive-')) bad.push(s)
    }
  }
  if (bad.length) return '有 ' + bad.length + ' 条规则没限定作用域：' + JSON.stringify(bad.slice(0, 5))
  return true
})

check('E · 样式安全', 'CSS 不含 :root / body / * / html 这类全局选择器', () => {
  const css = applied.mod.__test.CSS
  for (const bad of [':root', 'body{', 'html{', '*{', '* {']) {
    if (css.indexOf(bad) >= 0) return 'CSS 里出现了全局选择器：' + bad
  }
  return true
})

check('E · 样式安全', 'iframe 高度规则 = calc(100% - 48px)，控制条固定 48px', () => {
  const css = applied.mod.__test.CSS
  if (css.indexOf('[data-hive-frame]') < 0) return '缺少 [data-hive-frame] 规则'
  if (css.indexOf('height:calc(100% - 48px)') < 0) return '看板 iframe 高度规则不是 calc(100% - 48px)'
  if (css.indexOf('flex:0 0 48px') < 0) return '控制条没有固定 48px'
  return true
})

check('E · 样式安全', '状态点有绿/黄/红 + 加载态四套配色', () => {
  const css = applied.mod.__test.CSS
  for (const phase of ['ready', 'degraded', 'error', 'loading']) {
    if (css.indexOf('[data-phase="' + phase + '"]') < 0) return '缺少 ' + phase + ' 的状态点配色'
  }
  return true
})

check('E · 样式安全', '中英文案 key 完全对齐（无漏译）', () => {
  const dict = applied.mod.__test.DICT
  const zh = Object.keys(dict.zh).sort()
  const en = Object.keys(dict.en).sort()
  const missEn = zh.filter((k) => en.indexOf(k) < 0)
  const missZh = en.filter((k) => zh.indexOf(k) < 0)
  if (missEn.length) return 'en 缺 key：' + JSON.stringify(missEn)
  if (missZh.length) return 'zh 缺 key：' + JSON.stringify(missZh)
  if (zh.length < 40) return '文案 key 只有 ' + zh.length + ' 条，偏少'
  return true
})

/* ══════════════════════════ F. 接口契约 ══════════════════════════ */

check('F · 接口契约', '所有按钮的接口路径全部出现在源码里', () => {
  const need = [
    '/control/start',
    '/control/stop',
    '/control/scan',
    '/setup/doctor',
    '/setup/install',
    '/plugin/status',
    '/plugin/version',
    '/plugin/version/apply',
    '/deps',
    '/deps/check',
    '/health',
    '/overview',
  ]
  const miss = need.filter((p) => code.indexOf(p) < 0)
  if (miss.length) return '缺接口路径：' + JSON.stringify(miss)
  return true
})

check('F · 接口契约', '依赖动作走 /deps/{id}/install|update|uninstall（含 {version}）', () => {
  if (code.indexOf("'/deps/' + encodeURIComponent(row.id) + '/' + action") < 0) {
    return '依赖动作没有拼成 /deps/{id}/{action}'
  }
  if (code.indexOf('if (version) body.version = version') < 0) return '降级/指定版本没有把 version 放进请求体'
  if (code.indexOf("'/plugin/version/apply'") < 0) return '版本操作没有走 /plugin/version/apply'
  return true
})

check('F · 接口契约', '自检有降级兜底链：setup/doctor → plugin/doctor → doctor', () => {
  for (const p of ['/plugin/doctor', '/doctor']) {
    if (code.indexOf(p) < 0) return '缺少降级兜底路径：' + p
  }
  // 顺序也要对：主接口先试
  const a = code.indexOf("request('/setup/doctor')")
  const b = code.indexOf("request('/plugin/doctor')")
  const c = code.indexOf("request('/doctor')")
  if (a < 0 || b < 0 || c < 0) return '兜底顺序无法确认'
  if (!(a < b && b < c)) return '兜底顺序不对：setup/doctor(' + a + ') plugin/doctor(' + b + ') doctor(' + c + ')'
  return true
})

check('F · 接口契约', '看板 iframe 指向 /hive/，高度 style 就是 calc(100% - 48px)', async () => {
  const stub = loadClient()
  stub.harness.fetchImpl = routerFetch({
    '/hive/api/plugin/status': res({ ok: true, phase: 'ready', engine: { running: true }, model: { ready: true, current: 'deepseek-chat' } }),
    '/hive/api/health': res({ ok: true, version: '0.1.0', db: { ok: true } }),
    '/hive/api/overview': res({ ok: true, counts: { inbox: 3, outbox: 2, running: 1 } }),
  })
  const hh = createHarness()
  const mod = stub.spec.factory((n) => (n === 'react' ? hh.React : null))
  const made = makeCtx(mod)
  mod.apply(made.ctx)
  const tree = await hh.mount(made.calls.register[1].comp, {})
  const frames = findByType(tree, 'iframe')
  if (frames.length !== 1) return 'iframe 数量 = ' + frames.length
  const f = frames[0]
  if (f.props.src !== '/hive/') return 'iframe src = ' + JSON.stringify(f.props.src)
  if (!f.props.title) return 'iframe 缺少 title（无障碍）'
  if (!f.props.style || f.props.style.height !== 'calc(100% - 48px)') return 'iframe 高度 = ' + JSON.stringify(f.props.style && f.props.style.height)
  if (f.props.style.width !== '100%') return 'iframe 宽度 = ' + JSON.stringify(f.props.style.width)
  if (f.props.style.border !== 0) return 'iframe border 不是 0'
  return true
})

/* ══════════════════════════ G. 自检结果归一化 ══════════════════════════ */

const nt = loaded.spec.factory((n) => (n === 'react' ? createHarness().React : null)).__test

check('G · 归一化', 'setup/doctor 形态（items + summary + installable）', () => {
  const out = nt.normalizeDoctor({
    ok: false,
    status: 'FAIL',
    summary: { pass: 1, warn: 0, fail: 1, total: 2 },
    installable: ['dsh-cli'],
    items: [
      { id: 'node', group: 'core', title: 'Node.js 运行时', status: 'PASS', detail: 'v24.0.0' },
      { id: 'dsh-cli', group: 'dep', title: 'dsh CLI', status: 'FAIL', detail: '不在 PATH', fix: 'npm i -g dsh', installable: true },
    ],
  })
  if (out.rows.length !== 2) return '行数 = ' + out.rows.length
  if (out.rows[0].name !== 'Node.js 运行时') return 'name 没取 title：' + out.rows[0].name
  if (out.rows[0].level !== 'pass') return 'PASS 没归一成 pass：' + out.rows[0].level
  if (out.rows[1].level !== 'fail') return 'FAIL 没归一成 fail：' + out.rows[1].level
  if (out.rows[1].fix !== 'npm i -g dsh') return 'fix 丢了'
  if (!out.rows[1].installable) return 'installable 丢了'
  if (out.summary.pass !== 1 || out.summary.fail !== 1) return 'summary 没沿用后端：' + JSON.stringify(out.summary)
  return true
})

check('G · 归一化', 'plugin/doctor 形态（rows + name + status）', () => {
  const out = nt.normalizeDoctor({
    ok: true,
    rows: [
      { id: 'engine', name: '调度引擎', status: 'WARN', detail: '已停止', fix: '点「启动」' },
      { id: 'llm', name: 'LLM 通道', status: 'PASS', detail: 'deepseek-chat' },
    ],
  })
  if (out.rows.length !== 2) return '行数 = ' + out.rows.length
  if (out.rows[0].level !== 'warn') return 'WARN 没归一成 warn'
  if (out.rows[0].detail !== '已停止') return 'detail 丢了'
  if (out.summary.total !== 2) return '没给 summary 时应当自己数：' + JSON.stringify(out.summary)
  if (out.summary.warn !== 1 || out.summary.pass !== 1) return 'summary 计数不对：' + JSON.stringify(out.summary)
  return true
})

check('G · 归一化', '旧 /doctor 嵌套形态也能读成表', () => {
  const out = nt.normalizeDoctor({
    ok: true,
    node: { ok: true, version: 'v24.0.0', platform: 'win32', arch: 'x64' },
    db: { ok: true, path: 'D:\\x\\hive.db' },
    executors: { ready: false, reason: 'executor registry not ready', probes: { llm: { ok: true }, dsh: { ok: false, reason: 'not found' } } },
    channels: { mail: { ok: true, detail: 'agently-cli' }, x: { ok: false } },
    budget: { costCny: 1.5, dailyBudgetCny: 10 },
    warnings: ['数据库不可用: x'],
  })
  const ids = out.rows.map((r) => r.id)
  for (const need of ['node', 'db', 'executors', 'channel-mail', 'channel-x', 'budget', 'warning-0']) {
    if (ids.indexOf(need) < 0) return '缺少合成行 ' + need + '，实际 = ' + JSON.stringify(ids)
  }
  const exec = out.rows.find((r) => r.id === 'executors')
  if (exec.level !== 'warn') return 'executors 未就绪应当是 warn，实际 ' + exec.level
  if (exec.detail.indexOf('dsh') < 0) return '执行器明细没带上 probe 结果：' + exec.detail
  const warn = out.rows.find((r) => r.id === 'warning-0')
  if (warn.level !== 'warn') return '告警行等级 = ' + warn.level
  return true
})

check('G · 归一化', '空/垃圾输入返回空表，不抛异常', () => {
  for (const bad of [undefined, null, {}, 'x', 0, []]) {
    const out = nt.normalizeDoctor(bad)
    if (!out || !Array.isArray(out.rows)) return '输入 ' + JSON.stringify(bad) + ' 时没返回 rows 数组'
    if (out.rows.length !== 0) return '输入 ' + JSON.stringify(bad) + ' 时竟然有 ' + out.rows.length + ' 行'
    if (out.summary.total !== 0) return '输入 ' + JSON.stringify(bad) + ' 时 total ≠ 0'
  }
  return true
})

check('G · 归一化', '未知等级不硬猜，标成 unknown', () => {
  const out = nt.normalizeDoctor({ rows: [{ id: 'x', name: '怪状态', status: '???' }] })
  if (out.rows[0].level !== 'unknown') return '等级 = ' + out.rows[0].level
  if (out.summary.unknown !== 1) return 'summary.unknown = ' + out.summary.unknown
  return true
})

check('G · 归一化', '没有 id 的检查项会生成稳定 id（不丢行、不重复 key）', () => {
  const out = nt.normalizeDoctor({ items: [{ title: '没有 id 的项', status: 'WARN' }, { title: '没有 id 的项', status: 'WARN' }] })
  if (out.rows.length !== 2) return '行数 = ' + out.rows.length
  if (!out.rows[0].id || out.rows[0].id === 'row') return 'id 生成得过于笼统：' + out.rows[0].id
  return true
})

/* ══════════════════════════ H. 请求封装 ══════════════════════════ */

async function requestWith(fetchImpl, path) {
  const stub = loadClient()
  stub.harness.fetchImpl = fetchImpl
  const mod = stub.spec.factory((n) => (n === 'react' ? createHarness().React : null))
  return mod.__test.request(path)
}

check('H · 请求封装', '500 + {error} → ok:false 且原因含状态码与该错误', async () => {
  const r = await requestWith(() => Promise.resolve(res({ error: '引擎炸了' }, 500)), '/x')
  if (r.ok !== false) return 'ok 不是 false'
  if (r.status !== 500) return 'status = ' + r.status
  if (r.error.indexOf('500') < 0) return '原因里没有状态码：' + r.error
  if (r.error.indexOf('引擎炸了') < 0) return '原因里没有后端信息：' + r.error
  return true
})

check('H · 请求封装', '200 但不是 JSON → 明确说「不是 JSON」，不假装成功', async () => {
  const r = await requestWith(() => Promise.resolve(res('<html>502 Bad Gateway</html>', 200)), '/x')
  if (r.ok !== false) return 'ok 不是 false'
  if (r.error.indexOf('不是 JSON') < 0) return '原因 = ' + r.error
  return true
})

check('H · 请求封装', '网络异常（fetch reject）→ 原因写「请求没发出去」', async () => {
  const r = await requestWith(() => Promise.reject(new TypeError('Failed to fetch')), '/x')
  if (r.ok !== false) return 'ok 不是 false'
  if (r.status !== 0) return 'status = ' + r.status
  if (r.error.indexOf('没发出去') < 0) return '原因 = ' + r.error
  if (r.error.indexOf('Failed to fetch') < 0) return '没带底层异常：' + r.error
  return true
})

check('H · 请求封装', '请求体序列化失败也返回结构化错误', async () => {
  const cyc = {}
  cyc.self = cyc
  const stub = loadClient()
  stub.harness.fetchImpl = () => Promise.resolve(res({ ok: true }))
  const mod = stub.spec.factory((n) => (n === 'react' ? createHarness().React : null))
  const r = await mod.__test.request('/x', { method: 'POST', body: cyc })
  if (r.ok !== false) return 'ok 不是 false'
  if (r.error.indexOf('序列化') < 0) return '原因 = ' + r.error
  return true
})

check('H · 请求封装', '正常 JSON → ok:true 且 data 可读', async () => {
  const r = await requestWith(() => Promise.resolve(res({ ok: true, n: 7 })), '/x')
  if (!r.ok) return 'ok 不是 true：' + r.error
  if (!r.data || r.data.n !== 7) return 'data = ' + JSON.stringify(r.data)
  return true
})

/* ══════════════════════════ I. 状态判定 ══════════════════════════ */

check('I · 状态判定', '插件 404 → error（并提示 Host 路由没挂上）', () => {
  const r = nt.readPhase({ ok: false, status: 404, error: 'HTTP 404' }, { ok: false })
  if (r.phase !== 'error') return 'phase = ' + r.phase
  if (r.reason.indexOf('404') < 0) return '原因里没提 404：' + r.reason
  return true
})

check('I · 状态判定', '插件 ready + 引擎健康 → ready', () => {
  const r = nt.readPhase({ ok: true, data: { phase: 'ready', engine: { running: true }, model: { ready: true } } }, { ok: true, data: { ok: true } })
  if (r.phase !== 'ready') return 'phase = ' + r.phase
  return true
})

check('I · 状态判定', '插件在但引擎接口挂了 → degraded', () => {
  const r = nt.readPhase({ ok: true, data: { phase: 'ready', model: { ready: true } } }, { ok: false, status: 0, error: '请求没发出去：x' })
  if (r.phase !== 'degraded') return 'phase = ' + r.phase
  if (!r.reason) return 'degraded 却没有原因'
  return true
})

check('I · 状态判定', '插件 phase 不是 ready → uninit（走引导）', () => {
  const r = nt.readPhase({ ok: true, data: { phase: 'starting' } }, { ok: true, data: { ok: true } })
  if (r.phase !== 'uninit') return 'phase = ' + r.phase
  return true
})

check('I · 状态判定', 'LLM 没就绪 → degraded 且说明原因', () => {
  const r = nt.readPhase(
    { ok: true, data: { phase: 'ready', model: { ready: false, error: '没有配置模型' } } },
    { ok: true, data: { ok: true } },
  )
  if (r.phase !== 'degraded') return 'phase = ' + r.phase
  if (r.reason.indexOf('没有配置模型') < 0) return '原因 = ' + r.reason
  return true
})

/* ══════════════════════════ J. 依赖 / 版本 归一化 ══════════════════════════ */

check('J · 依赖与版本', 'cmpVersion 比较（1.10.0 > 1.9.9，v 前缀无影响，缺段补 0）', () => {
  const c = nt.cmpVersion
  const cases = [
    ['1.10.0', '1.9.9', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.0.0', '1.0', 0],
    ['v2.1.0', '2.1.0', 0],
    ['0.9', '1.0', -1],
  ]
  for (const [a, b, want] of cases) {
    const got = c(a, b)
    if (got !== want) return `cmpVersion(${a}, ${b}) = ${got}，期望 ${want}`
  }
  // 解析不出来时不撒谎：返回 0
  if (c('abc', 'xyz') !== 0) return '不可解析的版本应当返回 0'
  if (c('', '1.0.0') !== 0) return '空版本应当返回 0'
  return true
})

check('J · 依赖与版本', 'lowerVersions 只留低于当前的，且从高到低', () => {
  const got = nt.lowerVersions(['0.1.0', '0.2.0', '0.3.0', '1.0.0'], '0.3.0')
  if (got.join(',') !== '0.2.0,0.1.0') return '结果 = ' + JSON.stringify(got)
  if (nt.lowerVersions(['1.0.0'], '').length !== 0) return '没有当前版本时不该列降级项'
  return true
})

check('J · 依赖与版本', 'normalizeDeps 支持 {deps|items|rows|数组} 四种形态', () => {
  const a = nt.normalizeDeps({
    ok: true,
    deps: [{ id: 'codex', label: 'Codex CLI', purpose: '写代码', current: '0.3.1', latest: '0.4.0', versions: ['0.4.0', '0.3.1'] }],
  })
  if (a.rows.length !== 1) return 'deps 形态行数 = ' + a.rows.length
  const row = a.rows[0]
  if (row.name !== 'Codex CLI') return 'name 没取 label：' + row.name
  if (row.purpose !== '写代码') return 'purpose 丢了'
  if (row.current !== '0.3.1') return 'current = ' + row.current
  if (!row.installed) return '有当前版本却没标 installed'
  if (row.versions.length !== 2) return 'versions 丢了'

  const b = nt.normalizeDeps({ items: [{ id: 'pi', name: 'pi', version: '1.0.0' }] })
  if (b.rows.length !== 1) return 'items 形态行数 = ' + b.rows.length
  const c = nt.normalizeDeps({ rows: [{ id: 'claude', name: 'Claude Code' }] })
  if (c.rows.length !== 1) return 'rows 形态行数 = ' + c.rows.length
  if (c.rows[0].installed) return '没有当前版本却标成已安装'
  const d = nt.normalizeDeps([{ id: 'agently-cli', name: 'agently' }])
  if (d.rows.length !== 1) return '数组形态行数 = ' + d.rows.length
  if (nt.normalizeDeps(null).rows.length !== 0) return 'null 时应当空'
  return true
})

check('J · 依赖与版本', 'normalizeVersion 认得 Host 真实的对象形态（current:{version,…}）', () => {
  const host = {
    ok: true,
    current: { name: 'dsh-plugin-hive', version: '0.3.0', enabled: true, removable: false, installKind: 'path' },
    repo: 'elohia/hive',
    latest: '0.4.0',
    hasUpdate: true,
    canDowngrade: true,
    downgradeTargets: [{ version: '0.2.0' }, { version: '0.1.0' }],
    versions: [{ version: '0.4.0' }, { version: '0.3.0' }, { version: '0.2.0' }],
    error: null,
    hint: '当前是「本地目录」安装（link:）。升级需要换安装方式。',
  }
  const v = nt.normalizeVersion(host)
  if (v.current !== '0.3.0') return 'current 没从对象里取 version：' + JSON.stringify(v.current)
  if (v.name !== 'dsh-plugin-hive') return 'name = ' + v.name
  if (v.latest !== '0.4.0') return 'latest = ' + v.latest
  if (!v.hasUpdate) return 'hasUpdate 丢了'
  if (v.versions.length !== 3) return 'versions 对象数组没解析：' + JSON.stringify(v.versions)
  if (v.downgradeTargets.join(',') !== '0.2.0,0.1.0') return 'downgradeTargets = ' + JSON.stringify(v.downgradeTargets)
  if (v.enabled !== true) return 'enabled 没从 current 里取'
  if (v.removable !== false) return 'removable 没从 current 里取'
  if (v.installKind !== 'path') return 'installKind = ' + v.installKind
  if (v.hint.indexOf('本地目录') < 0) return 'hint 没透传'
  if (v.error !== '') return 'error 应为空串'
  const opts = nt.downgradeOptions(v)
  if (opts.join(',') !== '0.2.0,0.1.0') return 'downgradeOptions = ' + JSON.stringify(opts)
  return true
})

check('J · 依赖与版本', 'downgradeOptions 在没给 downgradeTargets 时兜底筛 versions', () => {
  const v = nt.normalizeVersion({ ok: true, current: '0.3.0', versions: ['0.5.0', '0.4.0', '0.3.0', '0.2.0'] })
  const opts = nt.downgradeOptions(v)
  if (opts.join(',') !== '0.2.0') return '兜底筛选不对：' + JSON.stringify(opts)
  return true
})

check('J · 依赖与版本', 'normalizeVersion 不编造版本号（后端没给 latest 就是空）', () => {
  const a = nt.normalizeVersion({ ok: true, current: '0.1.0' })
  if (a.current !== '0.1.0') return 'current = ' + a.current
  if (a.latest !== '') return '后端没给 latest 却编了一个：' + a.latest
  if (a.hasUpdate !== false) return '没有 latest 却判断有更新'
  const b = nt.normalizeVersion({ ok: true, current: '0.1.0', latest: '0.2.0', hasUpdate: true, versions: ['0.2.0', '0.1.0'] })
  if (!b.hasUpdate) return '后端说 hasUpdate 却没采纳'
  if (b.versions.length !== 2) return 'versions 丢了'
  const c = nt.normalizeVersion({ ok: false, error: '本地目录安装，仓库未发布' })
  if (c.error.indexOf('仓库未发布') < 0) return 'error 没透传：' + c.error
  if (c.latest !== '') return '报错时还在给 latest：' + c.latest
  if (nt.normalizeVersion(null).error === '') return '空返回应当带 error'
  return true
})

/* ══════════════════════════ K. 依赖 / 版本 UI（真点按钮） ══════════════════════════ */

/** 挂载面板，并返回一个能「按文案点按钮 → 等界面稳定」的 click。 */
async function mountPanel(fetchImpl) {
  const stub = loadClient()
  stub.harness.fetchImpl = fetchImpl
  const hh = createHarness()
  const mod = stub.spec.factory((n) => (n === 'react' ? hh.React : null))
  const made = makeCtx(mod)
  mod.apply(made.ctx)
  let tree = await hh.mount(made.calls.register[1].comp, {})
  const click = async (label, opts = {}) => {
    const btns = collect(tree).elements.filter((e) => e.type === 'button')
    const target = btns.find((b) => nodeText(b).indexOf(label) >= 0 && (!opts.enabledOnly || !b.props.disabled))
    if (!target) {
      throw new Error('点不到「' + label + '」；当前按钮：' + btns.map((b) => nodeText(b)).join(' | '))
    }
    if (typeof target.props.onClick !== 'function') throw new Error('按钮没有 onClick：' + label)
    target.props.onClick()
    tree = await hh.settle()
    return collect(tree)
  }
  return { stub, hh, mod, made, click, get tree() { return tree }, view: () => collect(tree) }
}

function depsRoutes(calls, state) {
  const base = routerFetch({
    '/hive/api/plugin/status': res({ ok: true, phase: 'ready', engine: { running: true }, model: { ready: true, current: 'deepseek-chat' } }),
    '/hive/api/health': res({ ok: true, db: { ok: true } }),
    '/hive/api/overview': res({ ok: true, counts: { inbox: 1, outbox: 0, running: 0 } }),
    '/hive/api/deps': () => res({ ok: true, deps: state.deps }),
    '/hive/api/deps/check': res({ ok: true, checked: true }),
    '/hive/api/deps/codex/install': res({ ok: true, before: '0.3.1', after: '0.4.0' }),
    '/hive/api/deps/codex/uninstall': res({ ok: true, before: '0.3.1', after: '' }),
    '/hive/api/plugin/version': () => res(state.version),
    '/hive/api/plugin/version/check': () => res(state.version),
    '/hive/api/plugin/version/apply': res({ ok: true, before: '0.1.0', after: '0.2.0' }),
  })
  return (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body })
    return base(url, init)
  }
}

const DEP_FIXTURE = [
  {
    id: 'codex',
    label: 'Codex CLI',
    purpose: '让 HIVE 能派代码任务',
    current: '0.3.1',
    latest: '0.4.0',
    installable: true,
    versions: ['0.4.0', '0.3.1', '0.3.0', '0.2.9'],
  },
  { id: 'claude', label: 'Claude Code', purpose: '另一种代码执行器', current: '', latest: '2.1.0', versions: ['2.1.0', '2.0.0'] },
]

check('K · 依赖 UI', '点「Agent 依赖」→ 抽屉打开，三个标签 + 那段「装不装由我决定」的说明', async () => {
  const calls = []
  const state = { deps: DEP_FIXTURE, version: { ok: true, current: '0.1.0', latest: '0.1.0', hasUpdate: false } }
  const p = await mountPanel(depsRoutes(calls, state))
  const view = await p.click('Agent 依赖')
  for (const tabName of ['自检', '依赖', '版本']) {
    if (view.text.indexOf(tabName) < 0) return '抽屉里没有标签「' + tabName + '」：' + view.text.slice(0, 200)
  }
  if (view.text.indexOf('这些是可选的执行器') < 0) return '缺少「可选执行器」说明文案'
  if (view.text.indexOf('不装也能用') < 0) return '说明文案不完整'
  if (!calls.some((c) => c.url.indexOf('/hive/api/deps') >= 0 && c.url.indexOf('/check') < 0)) return '打开抽屉没有 GET /hive/api/deps'
  if (view.text.indexOf('Codex CLI') < 0) return '没有渲染依赖行'
  return true
})

check('K · 依赖 UI', '依赖行四个按钮：安装/更新/降级/卸载（已装行禁用「安装」）', async () => {
  const calls = []
  const state = { deps: DEP_FIXTURE, version: { ok: true, current: '0.1.0', latest: '0.1.0' } }
  const p = await mountPanel(depsRoutes(calls, state))
  const view = await p.click('Agent 依赖')
  for (const label of ['安装', '更新', '降级', '卸载']) {
    if (view.text.indexOf(label) < 0) return '缺少按钮：' + label
  }
  const btns = view.elements.filter((e) => e.type === 'button')
  const installBtns = btns.filter((b) => nodeText(b).trim() === '安装')
  if (installBtns.length !== 2) return '「安装」按钮数量 = ' + installBtns.length
  const disabledCount = installBtns.filter((b) => b.props.disabled).length
  if (disabledCount !== 1) return '已安装的那行应当禁用「安装」（实际禁用 ' + disabledCount + ' 个）'
  return true
})

check('K · 依赖 UI', '点「安装」→ POST /deps/{id}/install，并显示结果', async () => {
  const calls = []
  const state = { deps: DEP_FIXTURE, version: { ok: true, current: '0.1.0', latest: '0.1.0' } }
  const p = await mountPanel(depsRoutes(calls, state))
  await p.click('Agent 依赖')
  const view = await p.click('安装', { enabledOnly: true })
  const post = calls.filter((c) => c.method === 'POST' && c.url.indexOf('/deps/') >= 0 && c.url.indexOf('/install') >= 0)
  if (!post.length) return '没有发出 install 请求；实际请求：' + JSON.stringify(calls.map((c) => c.method + ' ' + c.url))
  if (post[0].url.indexOf('/hive/api/deps/') < 0) return 'install 路径不对：' + post[0].url
  // 结果区（before→after 或失败原因）必须出现
  const pre = view.elements.filter((e) => e.props && e.props['data-hive-install'] !== undefined)
  if (!pre.length) return '没有显示安装结果'
  return true
})

check('K · 依赖 UI', '「卸载」要点两次（第一次只是上膛，不发请求）', async () => {
  const calls = []
  const state = { deps: DEP_FIXTURE, version: { ok: true, current: '0.1.0', latest: '0.1.0' } }
  const p = await mountPanel(depsRoutes(calls, state))
  await p.click('Agent 依赖')
  const before = calls.length
  const view1 = await p.click('卸载', { enabledOnly: true })
  if (calls.length !== before) return '第一次点「卸载」就发了请求（应当先二次确认）'
  if (view1.text.indexOf('确认卸载') < 0) return '第一次点「卸载」没有变成确认态'
  await p.click('确认卸载', { enabledOnly: true })
  const post = calls.filter((c) => c.method === 'POST' && c.url.indexOf('/uninstall') >= 0)
  if (!post.length) return '确认后没有发出 uninstall 请求'
  return true
})

check('K · 依赖 UI', '依赖接口 404 → 显示「该接口未就绪」，不崩', async () => {
  const stub = loadClient()
  stub.harness.fetchImpl = (url) => {
    const u = String(url)
    if (u.indexOf('/hive/api/deps') >= 0) return Promise.resolve(res({ error: 'not found' }, 404))
    return Promise.resolve(res({ ok: true, phase: 'ready', engine: { running: true }, model: { ready: true } }))
  }
  const hh = createHarness()
  const mod = stub.spec.factory((n) => (n === 'react' ? hh.React : null))
  const made = makeCtx(mod)
  mod.apply(made.ctx)
  let tree = await hh.mount(made.calls.register[1].comp, {})
  const findBtn = () => collect(tree).elements.filter((e) => e.type === 'button').find((b) => nodeText(b).indexOf('Agent 依赖') >= 0)
  findBtn().props.onClick()
  tree = await hh.settle()
  const view = collect(tree)
  if (view.text.indexOf('该接口未就绪') < 0) return '没有提示「该接口未就绪」：' + view.text.slice(-300)
  if (view.text.indexOf('Agent 依赖') < 0) return '面板整体塌了（按钮都没了）'
  return true
})

check('K · 依赖 UI', 'Host 真实 /deps 形态：version→current、totalVersions、fallback、required', () => {
  const n = nt.normalizeDeps({
    ok: true,
    generatedAt: '2026-11-05T13:00:42.658Z',
    registry: { requested: 'https://registry.npmjs.org/', used: 'https://registry.npmmirror.com/' },
    deps: [
      {
        id: 'dsh',
        name: 'DSH',
        purpose: 'DSH 本体：L4/L5 默认执行器',
        fallback: '卸载后 L4/L5 无法派单，只能退回 llm 内联',
        required: true,
        installed: true,
        version: '0.1.5-rc.2',
        versionSource: 'npm-global',
        latest: '0.2.1-rc.5',
        versions: ['0.2.2-rc.1', '0.2.0-rc.2', '0.1.7-rc.1'],
        totalVersions: 42,
        distTags: { latest: '0.2.1-rc.5' },
      },
    ],
  })
  const r = n.rows[0]
  if (!r) return '没解析出依赖行'
  if (r.current !== '0.1.5-rc.2') return 'version 没映射到 current：' + JSON.stringify(r.current)
  if (r.totalVersions !== 42) return 'totalVersions = ' + r.totalVersions
  if (!r.required) return 'required 丢了'
  if (r.fallback.indexOf('L4/L5') < 0) return 'fallback 丢了：' + r.fallback
  if (r.versionSource !== 'npm-global') return 'versionSource = ' + r.versionSource
  if (!r.installed) return 'installed 丢了'
  return true
})

check('K · 依赖 UI', '版本列表被截断时：显示卸载后果/必需标记，降级可点开并如实说明截断', async () => {
  const calls = []
  const state = {
    deps: [
      {
        id: 'dsh',
        name: 'DSH',
        purpose: 'DSH 本体',
        fallback: '卸载后 L4/L5 无法派单',
        required: true,
        installed: true,
        version: '0.1.5-rc.2',
        latest: '0.2.1-rc.5',
        versions: ['0.2.2-rc.1', '0.2.0-rc.2', '0.1.7-rc.1'],
        totalVersions: 42,
      },
    ],
    version: { ok: true, current: '0.1.0', latest: '0.1.0' },
  }
  const p = await mountPanel(depsRoutes(calls, state))
  const view = await p.click('Agent 依赖')
  if (view.text.indexOf('卸载后') < 0) return '没有显示 fallback（卸载后果）'
  if (view.text.indexOf('必需') < 0) return '没有显示「必需」标记'
  const opened = await p.click('降级', { enabledOnly: true })
  if (opened.text.indexOf('共 42 个') < 0) return '没有解释版本被截断：' + opened.text.slice(-240)
  if (opened.text.indexOf('没有低于当前的') < 0) return '截断说明文案不完整'
  return true
})

check('K · 版本 UI', '版本标签：显示当前版本；后端报错时原文显示且更新/降级/卸载禁用', async () => {
  const calls = []
  const state = {
    deps: DEP_FIXTURE,
    version: { ok: false, current: '0.1.0', error: '本地目录安装，仓库未发布，无法检查更新' },
  }
  const p = await mountPanel(depsRoutes(calls, state))
  const view = await p.click('版本')
  if (view.text.indexOf('0.1.0') < 0) return '没显示当前版本'
  if (view.text.indexOf('仓库未发布') < 0) return '后端 error 没有原文显示：' + view.text.slice(0, 300)
  const btns = view.elements.filter((e) => e.type === 'button')
  const find = (label) => btns.find((b) => nodeText(b).trim() === label)
  for (const label of ['更新', '卸载']) {
    const b = find(label)
    if (!b) return '缺少按钮：' + label
    if (!b.props.disabled) return '报错时「' + label + '」应当禁用'
  }
  const downgrade = btns.find((b) => nodeText(b).indexOf('降级') >= 0)
  if (!downgrade) return '缺少「降级」按钮'
  if (!downgrade.props.disabled) return '报错时「降级」应当禁用（不能瞎猜版本）'
  // 检查更新仍然可用（用户要能重试）
  const check = find('检查更新')
  if (!check) return '缺少「检查更新」按钮'
  if (check.props.disabled) return '「检查更新」不该禁用'
  return true
})

check('K · 版本 UI', '版本标签：降级列表只列低于当前的版本', async () => {
  const calls = []
  const state = {
    deps: DEP_FIXTURE,
    version: { ok: true, current: '0.3.0', latest: '0.3.0', hasUpdate: false, versions: ['0.5.0', '0.4.0', '0.3.0', '0.2.0', '0.1.0'] },
  }
  const p = await mountPanel(depsRoutes(calls, state))
  await p.click('版本')
  const view = await p.click('降级', { enabledOnly: true })
  const verBtns = view.elements.filter((e) => e.props && e.props['data-hive-ver-btn'] !== undefined)
  const labels = verBtns.map((b) => nodeText(b).trim())
  if (!labels.length) return '降级没展开版本列表'
  for (const v of labels) {
    if (nt.cmpVersion(v, '0.3.0') >= 0) return '列表里出现了不低于当前的版本：' + v + '（全部 = ' + labels.join(',') + '）'
  }
  if (labels.indexOf('0.2.0') < 0 || labels.indexOf('0.1.0') < 0) return '缺少应有的低版本：' + labels.join(',')
  return true
})

check('K · 版本 UI', 'Host 真实形态：current 是对象也显示对版本、hint 原样显示、不可卸载时禁用', async () => {
  const calls = []
  const state = {
    deps: DEP_FIXTURE,
    version: {
      ok: true,
      current: { name: 'dsh-plugin-hive', version: '0.3.0', enabled: true, removable: false, installKind: 'path' },
      latest: '0.4.0',
      hasUpdate: true,
      canDowngrade: false,
      downgradeTargets: [],
      versions: [{ version: '0.4.0' }, { version: '0.3.0' }],
      error: null,
      hint: '当前是「本地目录」安装（link:）。升级需要换安装方式。',
    },
  }
  const p = await mountPanel(depsRoutes(calls, state))
  const view = await p.click('版本')
  if (view.text.indexOf('0.3.0') < 0) return '没显示对象里的当前版本'
  if (view.text.indexOf('本地目录') < 0) return 'Host 的 hint 没有原样显示'
  if (view.text.indexOf('有可用更新') < 0) return '没显示「有可用更新」徽标'
  if (view.text.indexOf('0.4.0') < 0) return '没显示最新版本'
  const btns = view.elements.filter((e) => e.type === 'button')
  const uninstall = btns.find((b) => nodeText(b).trim() === '卸载')
  if (!uninstall) return '缺少「卸载」按钮'
  if (!uninstall.props.disabled) return 'removable=false 时「卸载」应当禁用'
  if (String(uninstall.props.title).indexOf('不可卸载') < 0) return '禁用原因没写清楚：' + uninstall.props.title
  // 「更新」在 hasUpdate 时可用
  const update = btns.find((b) => nodeText(b).trim() === '更新')
  if (!update) return '缺少「更新」按钮'
  if (update.props.disabled) return 'hasUpdate=true 时「更新」不该禁用'
  return true
})

check('K · 版本 UI', '「检查更新」走 POST /plugin/version/check（强制重查），不是只读缓存', async () => {
  const calls = []
  const state = {
    deps: DEP_FIXTURE,
    version: { ok: true, current: '0.3.0', latest: '0.3.0', hasUpdate: false, versions: ['0.3.0'] },
  }
  const p = await mountPanel(depsRoutes(calls, state))
  await p.click('版本')
  await p.click('检查更新', { enabledOnly: true })
  const force = calls.filter((c) => c.method === 'POST' && c.url.indexOf('/plugin/version/check') >= 0)
  if (!force.length) return '没有发出强制检查请求；实际：' + JSON.stringify(calls.map((c) => c.method + ' ' + c.url))
  return true
})



/* ══════════════════════════ L. 不白屏（真渲染） ══════════════════════════ */

const HAPPY_ROUTES = {
  '/hive/api/plugin/status': res({ ok: true, phase: 'ready', engine: { running: true }, model: { ready: true, current: 'deepseek-chat' } }),
  '/hive/api/health': res({ ok: true, version: '0.1.0', db: { ok: true }, executors: { ready: true } }),
  '/hive/api/overview': res({ ok: true, counts: { inbox: 3, outbox: 2, running: 1, failed24h: 0 } }),
}

async function renderPanel(fetchImpl) {
  const stub = loadClient()
  stub.harness.fetchImpl = fetchImpl
  const hh = createHarness()
  const mod = stub.spec.factory((n) => (n === 'react' ? hh.React : null))
  const made = makeCtx(mod)
  mod.apply(made.ctx)
  const tree = await hh.mount(made.calls.register[1].comp, {})
  return { tree, hh, mod, made, stub, view: collect(tree) }
}

check('L · 不白屏', '正常后端：渲染出控制条七个按钮', async () => {
  const { view } = await renderPanel(routerFetch(HAPPY_ROUTES))
  const text = view.text
  const need = ['启动', '停止', '立即巡检', '环境自检', 'Agent 依赖', '版本', '刷新']
  const miss = need.filter((k) => text.indexOf(k) < 0)
  if (miss.length) return '按钮文案缺：' + JSON.stringify(miss) + '（实际文本：' + text.slice(0, 240) + '）'
  return true
})

check('L · 不白屏', '正常后端：标题 / 状态点 / 看板 iframe 都在', async () => {
  const { view, tree } = await renderPanel(routerFetch(HAPPY_ROUTES))
  if (view.text.indexOf('HIVE') < 0) return '没有 HIVE 标题'
  if (view.text.indexOf('主动服务') < 0) return '没有副标题「主动服务」'
  const dots = view.elements.filter((e) => e.props && e.props['data-hive-dot'] !== undefined)
  if (dots.length !== 1) return '状态点数量 = ' + dots.length
  if (dots[0].props['data-phase'] !== 'loading' && dots[0].props['data-phase'] !== 'ready' && dots[0].props['data-phase'] !== 'degraded') {
    return '状态点相位异常：' + dots[0].props['data-phase']
  }
  if (findByType(tree, 'iframe').length !== 1) return '看板 iframe 没渲染'
  return true
})

check('L · 不白屏', '正常后端：待拍板/在跑的数字来自 overview', async () => {
  const { view } = await renderPanel(routerFetch(HAPPY_ROUTES))
  if (view.text.indexOf('待拍板 2') < 0) return '没显示待拍板数（期望「待拍板 2」）：' + view.text.slice(0, 240)
  if (view.text.indexOf('在跑 1') < 0) return '没显示在跑数（期望「在跑 1」）'
  return true
})

check('L · 不白屏', '后端全挂：不抛异常，且引导卡片出现（三步 + 一键开始）', async () => {
  const { view } = await renderPanel(() => Promise.reject(new TypeError('Failed to fetch')))
  if (view.text.indexOf('HIVE 还没接上') < 0) return '引导卡片没出现：' + view.text.slice(0, 240)
  if (view.text.indexOf('一键开始') < 0) return '没有「一键开始」按钮'
  if (view.text.indexOf('①') < 0 || view.text.indexOf('③') < 0) return '三步引导不完整'
  // 原因必须显示出来（不许只是空白）
  const errs = view.elements.filter((e) => e.props && e.props['data-hive-guide-reason'] !== undefined)
  if (!errs.length) return '没有显示失败原因的元素'
  return true
})

check('L · 不白屏', '后端全挂：看板 iframe 仍然挂着（不整块白掉）', async () => {
  const { tree } = await renderPanel(() => Promise.reject(new TypeError('Failed to fetch')))
  const frames = findByType(tree, 'iframe')
  if (frames.length !== 1) return 'iframe 数量 = ' + frames.length
  if (frames[0].props.src !== '/hive/') return 'iframe src 不对'
  return true
})

check('L · 不白屏', '按钮有 busy 兜底：loading 时点按钮不会二次发请求', async () => {
  // 直接检查源码里的防连点逻辑（busy 守卫），渲染层面不依赖时序
  if (code.indexOf('if (busy) return') < 0) return '缺少「同一时刻只允许一个动作」的守卫'
  if (code.indexOf('disabled: Boolean(busy)') < 0 && code.indexOf('disabled: !busy') < 0 && code.indexOf('disabled: Boolean(busy) && busy !== tag') < 0) {
    return '按钮没有 busy 期间的 disabled 逻辑'
  }
  return true
})

check('L · 不白屏', '卸载面板后没有遗留真实定时器（轮询/提示条都回收）', async () => {
  const stub = loadClient()
  stub.harness.fetchImpl = routerFetch(HAPPY_ROUTES)
  const hh = createHarness()
  const mod = stub.spec.factory((n) => (n === 'react' ? hh.React : null))
  const made = makeCtx(mod)
  mod.apply(made.ctx)
  await hh.mount(made.calls.register[1].comp, {})
  const before = stub.timers.clearedInterval.length
  hh.unmount()
  const after = stub.timers.clearedInterval.length
  if (stub.timers.intervals.length === 0) return '面板没有登记轮询间隔（应当定时刷状态）'
  if (!(after > before)) return '卸载时没有 clearInterval（轮询会泄漏）'
  return true
})

/* ══════════════════════════ 跑起来 ══════════════════════════ */

const t0 = Date.now()
console.log('=== dsh-plugin-hive · client.js 自检 ===')
console.log('文件：' + clientPath)
console.log('规模：' + lineCount + ' 行 · ' + (byteSize / 1024).toFixed(1) + ' KB')
console.log('用法：最小桩模拟 window.__ModuleLoader__ / document / fetch / 定时器')

const { total, failed: failCount } = await runAll()
const ms = Date.now() - t0

console.log('\n结果：' + (total - failCount) + '/' + total + (failCount ? ' FAIL' : ' PASS') + '（' + ms + 'ms）')
if (failCount) {
  console.log('有一条以上断言失败 —— client.js 还不能进插件。')
  process.exit(1)
}
console.log('全部通过：槽位注册、图标、清理、样式作用域、接口契约、归一化、依赖/版本、不白屏。')
process.exit(0)
