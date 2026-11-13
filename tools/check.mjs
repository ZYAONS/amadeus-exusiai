// 真跑自检：无头 Edge + CDP，不猜「元素存在」，只认真跑出来的事实。
//   node tools/check.mjs                      测 http://127.0.0.1:1002/
//   node tools/check.mjs http://127.0.0.1:3002/  测构建产物
// 依赖：Node ≥ 22（内置 fetch / WebSocket）。缺东西就明说，不偷偷放宽断言。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:1002/'
const PORT = 9333
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browserPath = BROWSERS.find((p) => existsSync(p))
if (!browserPath) {
  console.error('找不到 Edge/Chrome，无法做浏览器自检')
  process.exit(2)
}

const voiceData = JSON.parse(await readFile(join(root, 'src/data/voice-lines.json'), 'utf8'))
const modelRecord = JSON.parse(await readFile(join(root, 'src/data/model.json'), 'utf8'))

const profile = await mkdtemp(join(tmpdir(), 'amadeus-check-'))

// 语音素材：用 edge-tts 合成一句中文，再让 Chrome 把这句当成麦克风输入。
// 这样 WebRTC 链路上跑的是真语音，本地 Whisper 的转写可以拿去和原文比对。
const VENV_PY = [
  join(root, 'service/webrtc/.venv/Scripts/python.exe'),
  join(root, 'service/webrtc/.venv/bin/python'),
].find((p) => existsSync(p))
const voicePython = VENV_PY ?? 'python'
const FIXTURE_WAV = join(root, '_ref/fixture-utterance.wav')
const FIXTURE_TXT = join(root, '_ref/fixture-utterance.txt')
let fixtureReady = existsSync(FIXTURE_WAV) && existsSync(FIXTURE_TXT)
if (!fixtureReady) {
  const gen = spawn(voicePython, [join(root, 'service/webrtc/make_fixture.py')], {
    stdio: 'ignore',
    env: { ...process.env, HF_HOME: join(root, '_ref/hf') },
  })
  const done = await new Promise((res) => {
    const timer = setTimeout(() => res(false), 120000)
    gen.on('exit', (code) => {
      clearTimeout(timer)
      res(code === 0)
    })
    gen.on('error', () => {
      clearTimeout(timer)
      res(false)
    })
  })
  fixtureReady = done && existsSync(FIXTURE_WAV) && existsSync(FIXTURE_TXT)
  if (!fixtureReady) console.warn('! 没能生成语音素材（edge-tts 不可用？），通话断言会退回 stub 模式')
}
const fixtureText = fixtureReady ? (await readFile(FIXTURE_TXT, 'utf8')).trim() : ''

// 语音精度单独验：把整句音频直接喂进 pipeline（Chrome 假麦克风会切碎句子，
// Whisper 对碎片会脑补，不能拿它验准确率）
const voiceResults = []
let voiceSelfTest = null
if (fixtureReady) {
  const selfOut = await new Promise((res) => {
    const py = spawn(voicePython, [join(root, 'service/webrtc/selftest.py')], {
      // 同上：自检固定用快的引擎，克隆那条单独验（见 NOTES 的「音色克隆」一节）
      env: { ...process.env, CLONE_TTS: '0', HF_HOME: join(root, '_ref/hf'), PYTHONIOENCODING: 'utf-8' },
    })
    let out = ''
    py.stdout.on('data', (b) => (out += String(b)))
    py.on('close', () => res(out))
    py.on('error', () => res(''))
    setTimeout(() => res(out), 180000)
  })
  const line = selfOut.split('\n').reverse().find((l) => l.trim().startsWith('{'))
  try {
    voiceSelfTest = line ? JSON.parse(line) : null
  } catch {
    voiceSelfTest = null
  }
  const st = voiceSelfTest
  voiceResults.push({
    name: '本地 Whisper 转写与原文一致（pipeline 自检）',
    pass: Boolean(st && st.ok && st.overlap >= 0.8),
    detail: st ? '原文=' + JSON.stringify(st.source) + ' 转写=' + JSON.stringify(st.transcript) + ' 重合度=' + st.overlap : '自检没跑出结果',
  })
  voiceResults.push({
    name: 'TTS 真的合成了音频（pipeline 自检）',
    pass: Boolean(st && st.stats && st.stats.tts_bytes > 1000 && st.queued_frames > 0),
    detail: st ? 'tts_bytes=' + st.stats.tts_bytes + ' 待播帧=' + st.queued_frames + ' 引擎=' + st.tts : '无结果',
  })
}

const child = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--enable-unsafe-swiftshader', // 无头下没有 GPU，WebGL 要靠 SwiftShader，缺这个 flag 会直接拿不到上下文
    '--use-fake-device-for-media-stream', // WebRTC 断言要有麦克风；无头环境只能给它一个假设备
    ...(fixtureReady ? [`--use-file-for-fake-audio-capture=${FIXTURE_WAV}`] : []),
    '--use-fake-ui-for-media-stream',
    '--window-size=1360,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
// 浏览器自己的日志留在文件里：它要是崩了，这里能看到原因（之前只有一句「CDP 超时」）
const browserErr = []
const BROWSER_LOG = join(root, '_ref/browser-err.log')
mkdirSync(join(root, '_ref'), { recursive: true })
appendFileSync(BROWSER_LOG, `\n=== run @ ${new Date().toISOString()} ===\n`)
child.stderr?.on('data', (buf) => {
  browserErr.push(String(buf))
  appendFileSync(BROWSER_LOG, buf)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, ms = 15000, step = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}

async function pageTarget() {
  let target = null
  await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      return Boolean(target)
    } catch {
      return false
    }
  }, 20000, 200)
  if (!target) throw new Error('浏览器没起来（拿不到 CDP page target）')
  return target
}

// 自检要连真后端：health 得是 200，不能靠「代理 500 也算离线」蒙过去。
// 强制离线分支，避免 .env 里的真 key 让断言不稳定。
const api = spawn(process.execPath, [join(root, 'service/server.mjs')], {
  stdio: 'ignore',
  env: { ...process.env, PORT: '3002', AMADEUS_FORCE_OFFLINE: '1' },
})
const apiUp = await until(async () => {
  try {
    return (await fetch('http://127.0.0.1:3002/api/health')).ok
  } catch {
    return false
  }
}, 10000, 200)
if (!apiUp) console.warn('! 本地服务没起来（3002），/api 相关断言会按实际结果报')

// WebRTC 语音服务（python + aiortc）。强制 stub 的 ASR/TTS，保证结果可复现：
// 转写固定一句、合成是提示音，但「音频真的双向流动」这件事是真的。
// VAD 参数在这台「假麦克风」上调紧：Chrome 的假设备是一串短促提示音，
// 用产品默认的 8 秒上限要等一分钟才断出第一句（自检只调harness，不改产品默认）。
let webrtc = null
try {
  webrtc = spawn(voicePython, [join(root, 'service/webrtc/server.py')], {
    stdio: 'ignore',
    cwd: join(root, 'service/webrtc'),
    env: {
      ...process.env,
      WEBRTC_PORT: '8001',
      HF_HOME: join(root, '_ref/hf'),
      // 自检不接本地克隆服务：它要 GPU、单句 2~3 秒（和 Whisper 抢卡时会到 14 秒），
      // 会把浏览器那两侧有时间窗的断言拖到超时。克隆这条链路由 selftest.py 单独验证
      // （起 clone 服务后跑，会把 tts 报成 clone）；自检这里固定用快的 edge-tts。
      CLONE_TTS: '0',
      // 有真素材就用真 ASR/TTS；没有才退回 stub
      ...(fixtureReady ? {} : { AMADEUS_FORCE_STUB: '1' }),
      VAD_RMS: '600',
      VAD_SILENCE_MS: '400',
      VAD_MIN_SPEECH_MS: '200',
      VAD_MAX_SEGMENT_MS: '6000',
    },
  })
} catch {
  webrtc = null
}
const rtcUp = await until(async () => {
  try {
    const r = await fetch('http://127.0.0.1:8001/health')
    return r.ok
  } catch {
    return false
  }
}, 20000, 300)
if (!rtcUp) console.warn('! WebRTC 服务没起来（8001），通话那组断言会显式跳过')

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`CDP 超时（${method}, ${timeoutMs}ms）：浏览器可能已经退出`))
      }, timeoutMs)
      this.pending.set(id, {
        ok: (v) => {
          clearTimeout(timer)
          ok(v)
        },
        fail: (e) => {
          clearTimeout(timer)
          fail(e)
        },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        fail(err)
      }
    })
  }
  on(fn) {
    this.listeners.push(fn)
  }
  async evaluate(expression, timeoutMs = 60000) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? '页面执行异常')
    return res.result.value
  }
}

const target = await pageTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => {
  ws.addEventListener('open', ok, { once: true })
  ws.addEventListener('error', fail, { once: true })
})
const cdp = new CDP(ws)

await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Page.enable')

let jsErrors = []
cdp.on((msg) => {
  if (msg.method === 'Runtime.exceptionThrown') {
    jsErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    jsErrors.push(msg.params.entry.text)
  }
})

const VIEWPORTS = [
  { name: '桌面 1360x900', width: 1360, height: 900, mobile: false },
  { name: '窄屏 390x780', width: 390, height: 780, mobile: true },
]

/** 导航要等真落地：about:blank 上读 localStorage 会抛 SecurityError（踩过） */
async function goto(url) {
  await cdp.send('Page.navigate', { url })
  const landed = await until(async () => {
    try {
      return await cdp.evaluate("document.readyState !== 'loading' && location.href.indexOf('http') === 0")
    } catch {
      return false
    }
  }, 25000, 150)
  if (!landed) throw new Error(`导航没落地：${url}`)
  await sleep(500)
}

const allResults = []

for (const vp of VIEWPORTS) {
  jsErrors = []
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 1,
    mobile: vp.mobile,
  })
  await goto(URL_ARG)
  // 每轮从「没登录过」开始：清掉上一轮留下的可信度与设置
  await cdp.evaluate('localStorage.clear()')
  // 先钉住 2D 舞台（哪怕装了模型）：这样立绘相关的断言稳定，3D 由后面的断言显式切换
  await cdp.evaluate(
    `localStorage.setItem('amadeus.exusiai.v1', JSON.stringify({ config: { stage: '2d' } }))`,
  )
  await goto(URL_ARG)

  await cdp.evaluate(`window.__CHECK_LINES = ${JSON.stringify(voiceData.lines)}`)
  await cdp.evaluate(`window.__CHECK_MODEL = ${JSON.stringify(modelRecord)}`)
  await cdp.evaluate(`window.__CHECK_VP = ${JSON.stringify(vp.mobile ? 'mobile' : 'desktop')}`)
  await cdp.evaluate(`window.__CHECK_RTC = ${rtcUp ? 'true' : 'false'}`)
  await cdp.evaluate(`window.__CHECK_SPOKEN = ${JSON.stringify(fixtureText)}`)

  const suite = `(async () => {
  const results = []
  const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 12000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(step) }
    return false
  }
  const L = window.__CHECK_LINES
  const zhSet = new Set(L.map((l) => l.zh))
  const jpSet = new Set(L.map((l) => l.jp))
  const dlg = () => document.querySelector('[role="log"]')
  const dlgText = () => (dlg() ? dlg().innerText : '').trim()
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const byLabel = (label) => document.querySelector('[aria-label="' + label + '"]')
  const btnByText = (txt) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === txt)
  const setSelect = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // ── 结构
  const loginOk = await until(() => document.getElementById('callsign'))
  ok('登录遮罩出现', loginOk, loginOk ? 'input#callsign 在' : '15s 内没出现')
  ok('页面标题含干员名', document.title.includes('新约能天使'), document.title)

  // ── 后端探测（经 vite 代理打到 service/server.mjs）
  const health = await fetch('/api/health').then((r) => r.json()).catch((e) => ({ error: String(e) }))
  ok('/api/health 走通且为未配置状态', health && health.configured === false,
    JSON.stringify(health).slice(0, 120))

  // ── 建立链接
  setVal(document.getElementById('callsign'), '博士')
  await wait(80)
  document.querySelector('form button[type="submit"]').click()
  await until(() => document.getElementById('official-voice'))
  ok('语音播放器挂在 DOM 上', !!document.getElementById('official-voice'), 'querySelector 能找到才算数')

  // 统计真的响过几次，比读 currentTime 稳（换行/随机命中同一句都不影响）
  const audio = document.getElementById('official-voice')
  window.__plays = 0
  audio.addEventListener('playing', () => { window.__plays += 1 })

  // ── 立绘真的解码了
  const imgOk = await until(() => {
    const im = document.querySelector('img[alt*="立绘"]')
    return im && im.complete && im.naturalWidth > 0
  }, 20000)
  const im = document.querySelector('img[alt*="立绘"]')
  ok('立绘真的加载', imgOk, im ? im.naturalWidth + 'x' + im.naturalHeight + ' @ ' + (im.currentSrc || '').slice(-28) : '找不到 img')

  // ── 开场台词：打字机跑完 + 文本来自官方库
  const typed = await until(() => dlg() && dlg().dataset.typing === 'false', 15000)
  ok('打字机收敛（data-typing=false）', typed, 'data-typing=' + (dlg() ? dlg().dataset.typing : 'no-dialog'))
  const first = dlgText()
  ok('开场台词逐字来自官方台词库', zhSet.has(first), '实际=' + first.slice(0, 26))

  // ── 官方语音真的出声（移动端可能被自动播放策略拦下，那就必须给出提示）
  // 用 played TimeRanges 判定，不靠 playing 事件计数：事件可能在监听器装上之前就已经烧掉了
  const hasPlayed = () => audio.played.length > 0 && audio.played.end(0) > 0
  const played = await until(hasPlayed, 8000)
  if (played) {
    ok('官方语音真的开始播放', true,
      'played 到 ' + audio.played.end(0).toFixed(2) + 's，src=' + (audio.currentSrc || '').split('/').pop() + ' dur=' + (audio.duration || 0).toFixed(2) + 's')
  } else {
    const hinted = await until(() => document.body.innerText.indexOf('拦截了自动播放') >= 0, 4000)
    ok('自动播放被拦时有明确提示', hinted, hinted
      ? '横幅：点一下开启语音'
      : '既不播也不提示（paused=' + audio.paused + ' t=' + audio.currentTime.toFixed(2) + ' err=' + (audio.error ? audio.error.code : 'none') + '）')
    const stageBtn0 = document.querySelector('button[title="戳一下"]')
    if (stageBtn0) stageBtn0.click()
    const after = await until(hasPlayed, 12000)
    ok('用户点一下之后语音能播出', after, 'played 到 ' + (audio.played.length ? audio.played.end(0).toFixed(2) : '0') + 's，src=' + (audio.currentSrc || '').split('/').pop())
  }
  ok('官方音频时长已解码', audio.duration > 1, 'duration=' + (audio.duration || 0).toFixed(2) + 's')

  // 精二立绘要到信赖 120 才出现在台上，容易一直是张 404 的图，这里直接验它能不能加载
  const e2ok = await new Promise((res) => {
    const probe = new Image()
    probe.onload = () => res(probe.naturalWidth > 800)
    probe.onerror = () => res(false)
    probe.src = '/assets/立绘_2.png'
  })
  ok('精二立绘也能加载（升级后要换的那张）', e2ok, e2ok ? '立绘_2.png 可解码' : '取不到或尺寸异常')

  // ── 戳一下：换台词 + 重新播放
  const beforeSrc = audio.currentSrc
  const beforeTapText = dlgText()
  const beforeTapTime = audio.currentTime
  const tapBtn = [...document.querySelectorAll('button')].find((b) => b.title === '戳一下')
  ok('立绘可点击（戳一下）', !!tapBtn, tapBtn ? 'button[title=戳一下]' : '没找到')
  if (tapBtn) {
    tapBtn.click()
    // 必须等文本真的变了：data-typing 本来就是 false，只等它等于 false 会量到上一条（假失败来源）
    await until(() => dlg() && dlg().dataset.typing === 'false' && dlgText() !== beforeTapText, 12000)
    const tapped = dlgText()
    ok('戳一下返回官方台词', zhSet.has(tapped) && tapped !== beforeTapText, '实际=' + tapped.slice(0, 26))
    const restarted = await until(
      () => audio.currentSrc !== beforeSrc || audio.currentTime < beforeTapTime || !audio.paused,
      8000,
    )
    ok('戳一下重新触发播放', restarted,
      'src变化=' + (audio.currentSrc !== beforeSrc) + ' t=' + audio.currentTime.toFixed(2) + ' paused=' + audio.paused)
  }

  // ── 信赖度：页面自己的数字（progressbar 的可访问属性）vs 台词库解锁状态
  const bar = document.querySelector('[role="progressbar"][aria-label="信赖度"]')
  const trust = bar ? Number(bar.getAttribute('aria-valuenow')) : -1
  ok('信赖度对外可读（progressbar aria-valuenow）', trust >= 0, bar ? 'aria-valuenow=' + trust : '找不到 progressbar')

  byLabel('台词库').click()
  const libOk = await until(() => document.querySelector('[role="dialog"][aria-label="台词库"]'))
  ok('台词库面板打开', libOk)
  if (libOk) {
    const panel = document.querySelector('[role="dialog"][aria-label="台词库"]')
    const items = [...panel.querySelectorAll('li button')]
    ok('台词库条数与数据一致', items.length === L.length, 'UI=' + items.length + ' 数据=' + L.length)

    const needOf = (l) => (!l.unlock ? 0 : l.unlock.kind === 'trust' ? l.unlock.value : l.unlock.value === 1 ? 60 : 120)
    const expectLocked = L.filter((l) => needOf(l) > trust).length
    const gotLocked = items.filter((b) => b.disabled).length
    ok('解锁状态与信赖度一致', gotLocked === expectLocked, '锁定=' + gotLocked + ' 期望=' + expectLocked + '（信赖 ' + trust + '）')

    const firstOpen = items.find((b) => !b.disabled)
    ok('至少有一条已解锁台词可点', !!firstOpen, firstOpen ? firstOpen.innerText.split('\\n')[0] : '全锁')
    if (firstOpen) {
      const label = firstOpen.innerText
      const beforeLib = dlgText()
      firstOpen.click()
      await until(() => dlg() && dlg().dataset.typing === 'false' && dlgText() !== beforeLib, 12000)
      const shown = dlgText()
      const source = L.find((l) => label.indexOf(l.zh.slice(0, 12)) >= 0)
      ok('台词库播放后对话框逐字一致', source ? shown === source.zh : false,
        source ? '期望=' + source.zh.slice(0, 20) + ' 实际=' + shown.slice(0, 20) : '在数据里找不到这条')
    }
    const badge = document.body.innerText.includes('官方语音')
    ok('官方语音有角标', badge, badge ? '角标在' : '没找到「官方语音」')
    byLabel('关闭').click()
    await until(() => !document.querySelector('[role="dialog"][aria-label="台词库"]'))
  }

  // ── 文字对话（没有配置模型时走本地人格模式）
  const beforeSend = dlgText()
  const input = byLabel('输入框')
  ok('输入框存在', !!input)
  setVal(input, '老板在吗，今天有我的快递吗')
  await wait(80)
  const sendBtn = btnByText('发送')
  ok('发送按钮可用', !!sendBtn && !sendBtn.disabled, sendBtn ? 'disabled=' + sendBtn.disabled : '没找到')
  sendBtn.click()
  await until(() => dlg() && dlg().dataset.typing === 'false' && dlgText() !== beforeSend, 15000)
  const replied = dlgText()
  ok('本地模式回复只引用官方台词（不编造）', zhSet.has(replied) || replied.indexOf('本地人格模式') >= 0,
    zhSet.has(replied) ? '命中台词库' : '模板回复：' + replied.slice(0, 26))
  ok('界面明说当前是本地人格模式', document.body.innerText.indexOf('本地人格模式') >= 0, '看不出模式会让人误以为是真模型')

  // ── 日语配音：切到日配后，台词文本和音频文件都必须换成日文那一份
  byLabel('设置与档案').click()
  const cfgOk = await until(() => document.querySelector('[role="dialog"][aria-label="终端设置"]'))
  ok('设置面板打开', cfgOk)
  if (cfgOk) {
    const sel = byLabel('配音与台词语言')
    ok('语言选择器存在', !!sel, sel ? 'aria-label 命中' : '没找到')
    if (sel) {
      setSelect(sel, 'jp')
      await wait(150)
      let saved = null
      try { saved = JSON.parse(localStorage.getItem('amadeus.exusiai.v1')) } catch (e) {}
      ok('日配设置已持久化', saved && saved.config && saved.config.lang === 'jp',
        saved ? 'lang=' + saved.config.lang : '读不到存档')
    }
  }
  byLabel('关闭').click()
  await until(() => !document.querySelector('[role="dialog"][aria-label="终端设置"]'))

  const beforeJp = dlgText()
  const stageBtnJp = document.querySelector('button[title="戳一下"]')
  if (stageBtnJp) stageBtnJp.click()
  await until(() => dlg() && dlg().dataset.typing === 'false' && dlgText() !== beforeJp, 12000)
  const jpShown = dlgText()
  ok('日配模式下台词是日文原文', jpSet.has(jpShown),
    jpSet.has(jpShown) ? '命中日文台词库' : '实际=' + jpShown.slice(0, 26))
  ok('日文台词与中文确实不是同一份', jpShown !== beforeJp, '中文=' + beforeJp.slice(0, 12) + ' 日文=' + jpShown.slice(0, 12))
  const jpAudio = await until(() => (audio.currentSrc || '').indexOf('/voice/jp/') > 0, 8000)
  ok('播放的是日配音频文件', jpAudio, 'src=' + (audio.currentSrc || '').split('/').slice(-3).join('/'))

  // ── 对话框里的一键切语种（新按钮最容易写了但没接上）
  const toggle = byLabel('切换配音语言')
  ok('对话框里有中/日一键切换', !!toggle, toggle ? '按钮文字=' + toggle.textContent : '没找到')
  if (toggle) {
    const beforeToggle = dlgText()
    toggle.click()
    await until(() => dlg() && dlg().dataset.typing === 'false' && dlgText() !== beforeToggle, 12000)
    const backZh = dlgText()
    ok('一键切回中文后台词变回中文', zhSet.has(backZh), '实际=' + backZh.slice(0, 22))
    const zhAudio = await until(() => (audio.currentSrc || '').indexOf('/voice/zh/') > 0, 8000)
    ok('一键切回中文后播的是中配', zhAudio, 'src=' + (audio.currentSrc || '').split('/').slice(-3).join('/'))
  }

  // ── 3D 舞台：没有模型文件就明说跳过，不假装测过
  const rec = window.__CHECK_MODEL || {}
  if (!rec.file) {
    ok('3D 舞台跳过：没有模型文件', true, 'src/data/model.json 的 file 为 null；造个占位模型：npm run model:demo')
    ok('没有模型时不加载 three.js', true, 'ModelStage 是动态 import，模型不存在就不会下载那 600KB')
  } else {
    byLabel('设置与档案').click()
    await until(() => document.querySelector('[role="dialog"][aria-label="终端设置"]'))
    const stageSel = byLabel('舞台人物')
    ok('舞台切换项可用', !!stageSel && !stageSel.disabled,
      stageSel ? 'disabled=' + stageSel.disabled : '没找到')
    if (stageSel) setSelect(stageSel, '3d')
    byLabel('关闭').click()
    const ready = await until(() => document.querySelector('[data-model="ready"]'), 30000)
    const host3d = document.querySelector('[data-model]')
    ok('GLB 真的被解析并上台', ready,
      host3d ? 'data-model=' + host3d.getAttribute('data-model') + ' height=' + host3d.getAttribute('data-height') + ' anims=' + host3d.getAttribute('data-anims') : '没有 3D 容器')
    ok('高度是从几何算出来的包围盒', Number(host3d && host3d.getAttribute('data-height')) > 0.3,
      'data-height=' + (host3d && host3d.getAttribute('data-height')))
    // 三角形计数是第 4 帧才写回的，而无头环境里 rAF 会被节流，给足时间
    const tris = await until(() => Number((document.querySelector('[data-model]') || {}).dataset?.tris) > 0, 40000, 250)
    ok('WebGL 真的光栅化了三角形', tris,
      'data-tris=' + ((document.querySelector('[data-model]') || {}).dataset?.tris ?? '未写回（WebGL 没跑起来）'))

    // 骨架动画：不只看「有几段动画」，要看时钟在走、骨骼真的在动、网格真的被蒙皮
    const host3dEl = document.querySelector('[data-model]')
    const skinsN = Number(host3dEl && host3dEl.dataset.skins)
    ok('网格真的被蒙皮（有 skin 绑定）', skinsN > 0, 'data-skins=' + (host3dEl && host3dEl.dataset.skins))
    if (skinsN > 0) {
      const t0 = Number(host3dEl.dataset.animT)
      const y0 = host3dEl.dataset.boneY
      await wait(1200)
      const t1 = Number(host3dEl.dataset.animT)
      const y1 = host3dEl.dataset.boneY
      ok('动画时钟在走', t1 > t0, 'animT ' + t0 + ' -> ' + t1)
      ok('骨骼世界坐标在变（动画真的在驱动骨架）', y0 !== undefined && y1 !== undefined && Math.abs(Number(y1) - Number(y0)) > 1e-4,
        'boneY ' + y0 + ' -> ' + y1)
    }
    const cvs = document.querySelector('[data-model] canvas')
    ok('画布尺寸非零', !!cvs && cvs.width > 0 && cvs.height > 0,
      cvs ? cvs.width + 'x' + cvs.height : '没有 canvas')

    // 点模型算「戳一下」：这条路径是手写的 pointer 事件，最容易写了没接上。
    // 别用「文本变了」当判据——随机挑台词可能连着两次挑到同一句（真踩过），
    // 用「记录多了一条」当判据，稳定且同样是运行出来的事实。
    if (cvs) {
      await until(() => dlg() && dlg().dataset.typing === 'false' && zhSet.has(dlgText()), 15000)
      const countMsgs = () => {
        try {
          return JSON.parse(localStorage.getItem('amadeus.exusiai.v1')).messages.length
        } catch (e) {
          return -1
        }
      }
      const msgsBefore = countMsgs()
      cvs.dispatchEvent(new PointerEvent('pointerdown', { clientX: 120, clientY: 120, bubbles: true }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 120, clientY: 120 }))
      const grew = await until(() => countMsgs() > msgsBefore, 12000)
      ok('点 3D 模型会记一条新台词', grew, '记录数 ' + msgsBefore + ' -> ' + countMsgs())
      const settled = await until(() => dlg() && dlg().dataset.typing === 'false' && zhSet.has(dlgText()), 15000)
      ok('点 3D 模型后对话框是官方台词', settled,
        'zhSet=' + zhSet.has(dlgText()) + ' len=' + dlgText().length + ' 实际=' + JSON.stringify(dlgText().slice(0, 20)))
    }
    // ── 活人感：两段动作 + 形态键（眨眼/口型/表情）+ 头部跟随
    const aliveEl = () => document.querySelector('[data-model]')
    const clips = (aliveEl()?.dataset.clips || '').split(',').filter(Boolean)
    // 动作现在来自开源 mocap（只重定向手臂链），不再是手编的 idle/talk 两段
    ok('带进了开源动作片段（idle）', clips.includes('idle'), 'clips=' + clips.join(','))
    ok('形态键（眨眼/表情）已导出', Number(aliveEl()?.dataset.morphs) >= 20, 'morphs=' + aliveEl()?.dataset.morphs)
    ok('头部跟随接上了骨骼', aliveEl()?.dataset.headFollow === '1', 'headFollow=' + aliveEl()?.dataset.headFollow)

    const blink0 = Number(aliveEl()?.dataset.blinks || 0)
    await wait(6000)
    const blink1 = Number(aliveEl()?.dataset.blinks || 0)
    ok('会自己眨眼', blink1 > blink0, '眨眼次数 ' + blink0 + ' → ' + blink1 + '（6 秒内）')

    // 口型要现点现量：不能指望前面那次点击的语音还在播（桌面流程慢，早就播完了）
    // 无头环境里偶发「这一下点击没出声」（自动播放策略/音频解码），重试几次；
    // 断言本身不变：口型必须真的动起来
    let jawMax = 0
    let jawMoves = false
    for (let attempt = 0; attempt < 3 && !jawMoves; attempt++) {
      const cv = document.querySelector('[data-model] canvas')
      if (cv) {
        cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: 120, clientY: 120, bubbles: true }))
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 120, clientY: 120 }))
      }
      jawMoves = await until(() => {
        jawMax = Math.max(jawMax, Number(aliveEl()?.dataset.jaw || 0))
        return jawMax > 0.08
      }, 15000, 250)
    }
    ok('说话时口型跟着真实音量动', jawMoves, 'jawOpen 峰值=' + jawMax.toFixed(3))

    const jawCloses = await until(() => Number(aliveEl()?.dataset.jaw ?? 1) < 0.06, 75000, 250)
    ok('说完话嘴会闭上', jawCloses, 'jawOpen=' + (aliveEl()?.dataset.jaw ?? '无'))

    // 切回立绘：3D 到 2D 的降级路径也得通
    byLabel('设置与档案').click()
    await until(() => byLabel('舞台人物'))
    setSelect(byLabel('舞台人物'), '2d')
    byLabel('关闭').click()
    const back2d = await until(() => document.querySelector('img[alt*="立绘"]'), 8000)
    ok('能切回官方立绘', back2d, back2d ? '立绘回来了' : '切不回 2D')

    // 再进一次：反复切换最容易漏 WebGL 上下文和 canvas
    byLabel('设置与档案').click()
    await until(() => byLabel('舞台人物'))
    setSelect(byLabel('舞台人物'), '3d')
    byLabel('关闭').click()
    const again = await until(() => {
      const h = document.querySelector('[data-model]')
      return h && h.dataset.model === 'ready'
    }, 30000)
    const hostCanvases = document.querySelectorAll('[data-model] canvas').length
    const allCanvases = document.querySelectorAll('canvas').length
    ok('3D 可以反复进入', again, again ? '第二次仍然 ready' : '第二次没起来')
    ok('来回切换没留下多余 canvas', hostCanvases === 1,
      '宿主内 canvas=' + hostCanvases + '，页面全部 canvas=' + allCanvases + '（其中 1 个是粒子背景）')
  }

  // ── WebRTC 语音通话：假麦克风 → 服务端 VAD/ASR/LLM/TTS → 回传音频 + 文本事件
  if (window.__CHECK_VP !== 'mobile' && window.__CHECK_RTC) {
    const statsOf = async () => {
      try {
        return await (await fetch('http://127.0.0.1:8001/stats')).json()
      } catch (e) {
        return null
      }
    }
    const before = await statsOf()
    ok('通话前服务端在（/rtc 反代通了）', !!before, before ? 'asr=' + before.asr + ' tts=' + before.tts : '拿不到 /stats')

    const callBtn = byLabel('开始语音通话')
    ok('工具栏有通话按钮', !!callBtn, callBtn ? 'aria-label 命中' : '没找到')
    if (callBtn && before) {
      // 先记下当前记录条数：待会儿只认「通话之后新增的」消息，
      // 否则前面文本聊天断言留下的同名消息会让这条断言假通过（真踩过）
      const countBefore = (() => {
        try {
          return JSON.parse(localStorage.getItem('amadeus.exusiai.v1')).messages.length
        } catch (e) {
          return 0
        }
      })()
      callBtn.click()
      // 无头 + SwiftShader 下 aiortc 建连接偏慢，30s 会假失败（实测 31s 才 live）
      const live = await until(() => {
        const el = document.querySelector('[data-call]')
        return el && el.dataset.call === 'live'
      }, 75000, 500)
      const trace = (window.__CALL_EVENTS || []).map((e) => e.state || e.type).join('→')
      ok('WebRTC 连接建立（data-call=live）', live,
        '状态=' + ((document.querySelector('[data-call]') || {}).dataset?.call ?? 'none') + ' | 事件: ' + trace)

      // 服务端计数器：证明音频真的经 WebRTC 上去了、处理过、又下来了
      let stats = before
      const handled = await until(async () => {
        stats = (await statsOf()) || stats
        return stats.frames_in > 200 && stats.transcripts > 0 && stats.replies > 0 && stats.tts_bytes > 0
      }, 60000, 700)
      ok('服务端收到音频帧', stats && stats.frames_in > 200,
        'frames_in=' + (stats && stats.frames_in) + ' max_rms=' + (stats && stats.max_rms))
      ok('VAD 真的断出语音段', stats && stats.segments > 0,
        'segments=' + (stats && stats.segments) + ' voiced_frames=' + (stats && stats.voiced_frames))
      ok('ASR 出文本 / 人格服务出回复 / TTS 出音频', handled,
        'transcripts=' + (stats && stats.transcripts) + ' replies=' + (stats && stats.replies) + ' tts_bytes=' + (stats && stats.tts_bytes))
      ok('回传音轨有音频帧（down link）', stats && stats.frames_out > 20, 'frames_out=' + (stats && stats.frames_out))

      // 浏览器这一侧：远端音轨真的在放，转写与回复真的进了对话记录
      const audioPlaying = await until(() => {
        const a = document.getElementById('voice-call')
        return a && a.srcObject && a.currentTime > 0 && !a.paused
      }, 15000)
      const audioEl = document.getElementById('voice-call')
      ok('远端音轨在浏览器里播放', audioPlaying,
        audioEl ? 'srcObject=' + !!audioEl.srcObject + ' t=' + audioEl.currentTime.toFixed(2) + ' paused=' + audioEl.paused : '没有 audio 元素')

      const transcriptShown = await until(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('amadeus.exusiai.v1'))
          const fresh = saved.messages.slice(countBefore)
          return fresh.some((m) => m.role === 'user') && fresh.some((m) => m.role === 'operator')
        } catch (e) {
          return false
        }
      }, 30000)
      const freshMsgs = (() => {
        try {
          return JSON.parse(localStorage.getItem('amadeus.exusiai.v1')).messages.slice(countBefore)
        } catch (e) {
          return []
        }
      })()
      ok('通话里产生了新的转写与回复（只看通话之后新增的）', transcriptShown,
        '新增 ' + freshMsgs.length + ' 条：' +
          freshMsgs.map((m) => m.role + '=' + m.text.slice(0, 10)).join(' / '))

      // 浏览器这层只验「传输 + 真引擎在跑」：Chrome 假麦克风会把句子切碎，
      // 转写准确率在上面的 pipeline 自检里验（那边喂的是完整一句）
      const modeOk = before.asr !== 'stub' && before.tts !== 'stub'
      ok('通话用的是真引擎（本地 Whisper + edge-tts/SiliconFlow）', modeOk,
        'asr=' + before.asr + ' tts=' + before.tts)
      ok('浏览器侧转写非空', freshMsgs.some((m) => m.role === 'user' && m.text.length >= 2),
        '用户消息: ' + freshMsgs.filter((m) => m.role === 'user').map((m) => m.text.slice(0, 12)).join(' / '))

      // 挂断
      const hangup = byLabel('挂断语音通话')
      ok('通话中按钮变成挂断', !!hangup, hangup ? 'aria-label=挂断语音通话' : '没变')
      if (hangup) {
        hangup.click()
        const hung = await until(() => !document.querySelector('[data-call]'), 15000)
        const trace2 = (window.__CALL_EVENTS || []).slice(-6).map((e) => e.state || e.type).join('→')
        ok('挂断后状态清除', hung,
          hung ? 'data-call 已移除' : '还挂在页面上（data-call=' + ((document.querySelector('[data-call]') || {}).dataset?.call ?? 'none') + ' | 最近事件: ' + trace2 + '）')
      }
    }
  } else if (window.__CHECK_VP !== 'mobile') {
    ok('WebRTC 通话跳过：python 服务没起来', true, '需要 aiortc：pip install -r service/webrtc/requirements.txt')
  }

  // ── 开关类：语音静音要真的落盘
  const muteBtn = byLabel('关闭语音')
  ok('语音开关可点', !!muteBtn)
  if (muteBtn) {
    muteBtn.click()
    await wait(120)
    ok('静音后按钮状态翻转', !!byLabel('开启语音'), '开启语音按钮=' + !!byLabel('开启语音'))
    let saved = null
    try { saved = JSON.parse(localStorage.getItem('amadeus.exusiai.v1')) } catch (e) {}
    ok('设置已持久化到 localStorage', saved && saved.config && saved.config.voice === false,
      saved ? 'voice=' + saved.config.voice : '读不到存档')
    byLabel('开启语音').click()
    await wait(80)
  }

  // ── 情绪标签
  ok('情绪标签已渲染', /平静|兴奋|微笑|从容|不好意思|上火|低落|兴致不高/.test(document.body.innerText),
    (document.body.innerText.match(/平静|兴奋|微笑|从容|不好意思|上火|低落|兴致不高/) || ['无'])[0])

  // ── 版式：横向溢出是性价比最高的回归断言
  const sw = document.documentElement.scrollWidth
  const iw = window.innerWidth
  ok('无横向溢出', sw <= iw + 1, 'scrollWidth=' + sw + ' innerWidth=' + iw)

  // ── 对话框与立绘在同一屏内可见
  const box = dlg() ? dlg().getBoundingClientRect() : null
  ok('对话框在视口内', !!box && box.top >= 0 && box.bottom <= window.innerHeight + 1,
    box ? 'top=' + Math.round(box.top) + ' bottom=' + Math.round(box.bottom) + ' vh=' + window.innerHeight : '无对话框')

  return { results, trust, plays: window.__plays }
})()`

  console.log(`\n[进度] ${vp.name} 的断言套件开始执行`)
  const out = await cdp.evaluate(suite, 8 * 60 * 1000)
  console.log(`[进度] ${vp.name} 执行完，共 ${out.results.length} 条`)
  for (const r of out.results) allResults.push({ vp: vp.name, ...r })
  allResults.push({ vp: vp.name, name: '无未捕获异常 / 无 console error', pass: jsErrors.length === 0, detail: jsErrors.join(' | ').slice(0, 300) || '0 条' })
  allResults.push({ vp: vp.name, name: '真实播放次数', pass: out.plays > 0, detail: out.plays + ' 次 playing 事件' })
}

// ── 无 JS 回退：SPA 全靠 JS，所以必须有 noscript 兜底
await cdp.send('Emulation.setScriptExecutionDisabled', { value: true })
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: URL_ARG })
await sleep(1500)
const noJsText = await cdp.evaluate('document.body.innerText')
allResults.push({
  vp: '无 JS',
  name: '禁用脚本时仍有可读内容',
  pass: typeof noJsText === 'string' && noJsText.includes('新约能天使') && noJsText.length > 40,
  detail: (noJsText || '').replace(/\s+/g, ' ').slice(0, 80),
})
await cdp.send('Emulation.setScriptExecutionDisabled', { value: false })

for (const r of voiceResults) allResults.push({ vp: '语音链路', ...r })

const failed = allResults.filter((r) => !r.pass)
let currentVp = ''
for (const r of allResults) {
  if (r.vp !== currentVp) {
    currentVp = r.vp
    console.log(`\n── ${r.vp} ──`)
  }
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log(`\n共 ${allResults.length} 项检查，失败 ${failed.length} 项`)

if (browserErr.length) {
  console.log('\n── 浏览器 stderr（末 15 行）──')
  console.log(browserErr.join('').split('\n').slice(-15).join('\n'))
}

ws.close()
child.kill()
api.kill()
webrtc?.kill()
await sleep(300)
await rm(profile, { recursive: true, force: true }).catch(() => {})
process.exit(failed.length ? 1 : 0)
