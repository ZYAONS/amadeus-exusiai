// 高分辨率特写：按骨骼世界坐标投影取景，把脸（或手）拍到能判断细节的程度。
//   node tools/closeup.mjs <输出文件> [骨骼名] [框边长CSS px] [url] [标签]
// 例：node tools/closeup.mjs _ref/face.png head 240        # 脸部特写（dpr 3）
//     node tools/closeup.mjs _ref/hand.png hand 200         # 手部特写
// 为什么要它：整屏截图里眼睛只有几个像素宽，无法判断虹膜色偏/手指曲度。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? '_ref/closeup.png'
const boneName = process.argv[3] ?? 'head'
const boxSide = Number(process.argv[4] ?? 220)
const URL_ARG = process.argv[5] ?? 'http://127.0.0.1:1002/'
const label = process.argv[6] ?? ''
const PORT = 9347
const DPR = 3
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const browserPath = BROWSERS.find((p) => existsSync(p))
const profile = mkdtempSync(join(tmpdir(), 'amadeus-closeup-'))
mkdirSync('_ref', { recursive: true })
const child = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--window-size=1200,1800',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}
let target = null
await until(async () => {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = l.find((t) => t.type === 'page')
    return Boolean(target)
  } catch {
    return false
  }
}, 25000)
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => {
  ws.addEventListener('open', ok, { once: true })
  ws.addEventListener('error', fail, { once: true })
})
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result)
  }
})
const send = (method, params = {}, timeoutMs = 90000) =>
  new Promise((ok, fail) => {
    const n = ++id
    const t = setTimeout(() => {
      pending.delete(n)
      fail(new Error('CDP 超时 ' + method))
    }, timeoutMs)
    pending.set(n, { ok: (v) => (clearTimeout(t), ok(v)), fail: (e) => (clearTimeout(t), fail(e)) })
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面异常')
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
// 高 dpr：canvas 的 backing store 变大，细节才拍得出来
await send('Emulation.setDeviceMetricsOverride', {
  width: 1200, height: 1800, deviceScaleFactor: DPR, mobile: false,
})
await send('Page.navigate', { url: URL_ARG })
await until(() => evaluate("document.readyState !== 'loading'"))
await evaluate('localStorage.clear()')
await send('Page.navigate', { url: URL_ARG })
await until(() => evaluate("Boolean(document.getElementById('callsign'))"))
const staged = await evaluate(`(async () => {
  const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 150)) } return false }
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  const input = document.getElementById('callsign')
  setVal(input, '博士')
  await new Promise(r => setTimeout(r, 120))
  input.closest('form').querySelector('button[type="submit"]').click()
  if (!await until(() => document.getElementById('official-voice'))) return 'no-voice'
  document.querySelector('[aria-label="设置与档案"]').click()
  if (!await until(() => document.querySelector('[role="dialog"][aria-label="终端设置"]'))) return 'no-panel'
  const sel = document.querySelector('[aria-label="舞台人物"]')
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, '3d')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  document.querySelector('[aria-label="关闭"]').click()
  return 'ok'
})()`)
if (staged !== 'ok') throw new Error('进场失败: ' + staged)
await until(() => evaluate('document.querySelector(\'[data-model="ready"]\') !== null'), 90000, 400)
await sleep(2000)

const spot = await evaluate(`(() => {
  const M = window.__AMADEUS_MODEL
  const THREE = M.THREE
  const want = ${JSON.stringify(boneName)}
  let bone = null
  M.model.traverse((n) => { if (!bone && n.isBone && n.name.replace(/[._]/g, '').toLowerCase().includes(want.replace(/[._]/g, '').toLowerCase())) bone = n })
  if (!bone) return { error: '找不到骨骼 ' + want }
  bone.updateWorldMatrix(true, false)
  const v = new THREE.Vector3()
  bone.getWorldPosition(v)
  v.project(M.camera)
  const cv = document.querySelector('[data-model] canvas').getBoundingClientRect()
  return { name: bone.name, ndc: [+v.x.toFixed(3), +v.y.toFixed(3)], cv: { x: cv.x, y: cv.y, w: cv.width, h: cv.height }, dpr: window.devicePixelRatio }
})()`)
if (spot.error) throw new Error(spot.error)
const cx = spot.cv.x + (spot.ndc[0] * 0.5 + 0.5) * spot.cv.w
const cy = spot.cv.y + (-spot.ndc[1] * 0.5 + 0.5) * spot.cv.h
const clip = {
  x: Math.round(cx - boxSide / 2),
  y: Math.round(cy - boxSide / 2),
  width: boxSide,
  height: boxSide,
  scale: 2,
}
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`✓ ${out}  骨=${spot.name} dpr=${spot.dpr} 画布=${Math.round(spot.cv.w)}x${Math.round(spot.cv.h)} 截取 ${boxSide}px@2x ${label}`)
ws.close()
child.kill()
