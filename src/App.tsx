import { useEffect, useMemo, useRef, useState } from 'react'
import Stage from './components/Stage'
import ModelStage from './components/ModelStage'
import Hud from './components/Hud'
import DialogBox from './components/DialogBox'
import ParticleField from './components/ParticleField'
import Toolbar from './components/Toolbar'
import ChatHistory from './components/ChatHistory'
import VoiceLibrary from './components/VoiceLibrary'
import ConfigPanel from './components/ConfigPanel'
import LoginOverlay from './components/LoginOverlay'
import { useStore } from './lib/store'
import { chatStream, OfflineError, type ChatMessage } from './lib/api'
import { classifyEmotion, type Emotion } from './lib/emotion'
import { offlineReply } from './lib/offlinePersona'
import { IDLE_POOL, LINES, TOUCH_POOL, lineText, type VoiceLang, type VoiceLine } from './lib/operator'
import { unlockedLines } from './lib/trust'
import { startVoiceCall, type CallEvent, type CallHandle } from './lib/rtc'
import modelRecord from './data/model.json'

const MODEL = modelRecord as { file: string | null; demo?: boolean }
import { playOfficial, resetVoiceCache, speak, stopOfficial, stopSpeaking } from './lib/audio'

type SheetKind = 'history' | 'voices' | 'config' | null

const pick = <T,>(arr: T[]): T | undefined => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined)

export default function App() {
  const s = useStore()
  const [emotion, setEmotion] = useState<Emotion>('smile1')
  const [dialog, setDialog] = useState<{ text: string; lineTitle?: string; official: boolean }>({
    text: '',
    official: false,
  })
  const [busy, setBusy] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [listening, setListening] = useState(false)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [playingNo, setPlayingNo] = useState<number | undefined>()
  // 3D 舞台的记录来自 src/data/model.json（模型文件本身在 public/assets/model/，不入库）
  const [modelFailed, setModelFailed] = useState<string | null>(null)
  const [callState, setCallState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle')
  const [callError, setCallError] = useState<string | null>(null)
  const callRef = useRef<CallHandle | null>(null)
  const stoppingCall = useRef(false)

  const busyRef = useRef(false)
  const sendRef = useRef<(t: string) => void>(() => {})
  const spokenNos = useRef<number[]>([])
  const greeted = useRef(false)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const pendingLine = useRef<VoiceLine | null>(null)
  const playLineRef = useRef<(line: VoiceLine) => Promise<void>>(async () => {})
  const [needGesture, setNeedGesture] = useState(false)

  const micSupported = useMemo(() => {
    const w = window as unknown as Record<string, unknown>
    return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition)
  }, [])

  const modelUrl = MODEL.file ? `/assets/model/${MODEL.file}` : null
  const use3d = Boolean(modelUrl) && !modelFailed && s.config.stage === '3d'

  // 官方语音播放器的说话状态，直接读真实媒体事件
  useEffect(() => {
    const audio = document.getElementById('official-voice') as HTMLAudioElement | null
    if (!audio) return
    const on = () => setSpeaking(true)
    const off = () => setSpeaking(false)
    audio.addEventListener('playing', on)
    audio.addEventListener('ended', off)
    audio.addEventListener('pause', off)
    audio.addEventListener('error', off)
    return () => {
      audio.removeEventListener('playing', on)
      audio.removeEventListener('ended', off)
      audio.removeEventListener('pause', off)
      audio.removeEventListener('error', off)
    }
  }, [s.signedIn])

  function emit(m: { text: string; lineNo?: number; lineTitle?: string; emotion: Emotion }) {
    s.push({ role: 'operator', text: m.text, lineNo: m.lineNo, lineTitle: m.lineTitle, emotion: m.emotion })
    setDialog({ text: m.text, lineTitle: m.lineTitle, official: Boolean(m.lineNo) })
    setEmotion(m.emotion)
    if (m.lineNo) spokenNos.current = [...spokenNos.current.slice(-8), m.lineNo]
  }

  async function playLineAudio(line: VoiceLine, langOverride?: VoiceLang) {
    if (!s.config.voice) return
    stopSpeaking()
    setPlayingNo(line.no)
    const lang = langOverride ?? s.config.lang
    const res = await playOfficial(line.file, lang)
    if (res === 'blocked') {
      // 移动端/无手势时浏览器会拒掉 play()：留个待播，等第一次点击再补
      pendingLine.current = line
      setNeedGesture(true)
    } else if (res === 'absent' && s.config.tts) {
      speak(lineText(line, lang), { onStart: () => setSpeaking(true), onEnd: () => setSpeaking(false), lang })
    }
    window.setTimeout(() => setPlayingNo((n) => (n === line.no ? undefined : n)), 1200)
  }
  playLineRef.current = playLineAudio

  async function runLine(line: VoiceLine, langOverride?: VoiceLang) {
    const text = lineText(line, langOverride ?? s.config.lang)
    emit({ text, lineNo: line.no, lineTitle: line.title, emotion: classifyEmotion(text) })
    await playLineAudio(line, langOverride)
  }

  /** 补播被浏览器拦下的那句（第一次点击时触发） */
  function armVoice() {
    setNeedGesture(false)
    const line = pendingLine.current
    pendingLine.current = null
    if (line) void playLineRef.current(line)
  }

  // ---------- WebRTC 语音通话 ----------
  function handleCallEvent(event: CallEvent) {
    const w = window as unknown as { __CALL_EVENTS?: unknown[] }
    w.__CALL_EVENTS = [...(w.__CALL_EVENTS ?? []).slice(-19), event]
    if (event.type === 'final') {
      s.push({ role: 'user', text: event.text })
      s.bumpTrust()
    } else if (event.type === 'reply') {
      const emotion = classifyEmotion(event.text)
      emit({ text: event.text, emotion })
    } else if (event.type === 'state' && event.state.startsWith('pc:')) {
      // 主动挂断时 pc 会依次发 closed/disconnected，别把它们当成故障
      if (stoppingCall.current) return
      const s = event.state.slice(3)
      if (s === 'connected') setCallState('live')
      else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        setCallState((prev) => (prev === 'idle' ? prev : 'error'))
      }
    } else if (event.type === 'error') {
      console.warn('[webrtc] 服务端报错：', event.message)
      setCallError(event.message)
    }
  }

  async function startCall() {
    stoppingCall.current = false
    setCallError(null)
    setCallState('connecting')
    const audio = document.getElementById('voice-call') as HTMLAudioElement | null
    if (!audio) {
      setCallState('error')
      return
    }
    try {
      const handle = await startVoiceCall(s.name, handleCallEvent, audio)
      callRef.current = handle
      setCallState('live')
    } catch (err) {
      console.warn('[webrtc] 通话没起来：', err)
      setCallState('error')
      setCallError(String((err as Error)?.message ?? err))
    }
  }

  function stopCall() {
    stoppingCall.current = true
    callRef.current?.stop()
    callRef.current = null
    setCallState('idle')
  }

  function toggleCall() {
    if (callState === 'live' || callState === 'connecting') stopCall()
    else void startCall()
  }

  async function send(raw: string) {
    const text = raw.trim()
    if (!text || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const history: ChatMessage[] = [
      ...s.messages.slice(-16).map<ChatMessage>((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      })),
      { role: 'user', content: text },
    ]
    s.push({ role: 'user', text })
    s.bumpTrust()
    stopOfficial()
    stopSpeaking()
    setSpeaking(false)
    setDialog({ text: '', official: false })

    try {
      if (s.health.configured) {
        let acc = ''
        setStreaming(true)
        for await (const delta of chatStream(history, s.name)) {
          acc += delta
          setDialog({ text: acc, official: false })
        }
        setStreaming(false)
        if (!acc.trim()) throw new OfflineError('模型返回为空')
        emit({ text: acc, emotion: classifyEmotion(acc) })
        if (s.config.voice && s.config.tts) {
          speak(acc, { onStart: () => setSpeaking(true), onEnd: () => setSpeaking(false), lang: s.config.lang })
        }
      } else {
        throw new OfflineError('offline')
      }
    } catch {
      setStreaming(false)
      // 本地人格模式：只引用官方台词库，不编造她的话
      const reply = offlineReply(text, s.name, s.trust, spokenNos.current)
      if (reply.line) await runLine(reply.line)
      else {
        emit({ text: reply.text, emotion: 'neutral' })
        if (s.config.voice && s.config.tts) {
          speak(reply.text, { onStart: () => setSpeaking(true), onEnd: () => setSpeaking(false), lang: s.config.lang })
        }
      }
    } finally {
      setStreaming(false)
      busyRef.current = false
      setBusy(false)
    }
  }
  sendRef.current = send

  function tapStage() {
    if (busyRef.current) return
    const line = pick([...TOUCH_POOL, ...unlockedLines(IDLE_POOL, s.trust)])
    if (line) void runLine(line)
  }

  function replayLast() {
    const last = [...s.messages].reverse().find((m) => m.role === 'operator')
    if (!last) return
    const line = last.lineNo ? LINES.find((l) => l.no === last.lineNo) : undefined
    if (line) void playLineAudio(line)
    else if (s.config.tts) {
      speak(last.text, { onStart: () => setSpeaking(true), onEnd: () => setSpeaking(false), lang: s.config.lang })
    }
  }

  function toggleMic() {
    const w = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!SR) return
    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }
    const rec = new SR()
    rec.lang = 'zh-CN'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e: any) => {
      const final = Array.from(e.results as any[])
        .filter((r: any) => r.isFinal)
        .map((r: any) => r[0].transcript)
        .join('')
      if (final.trim()) {
        setListening(false)
        sendRef.current(final)
      }
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    try {
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch {
      setListening(false)
    }
  }

  // 上场第一句：问候（第 42 条没有任何解锁条件，固定用它开场）
  useEffect(() => {
    if (!s.signedIn || greeted.current) return
    greeted.current = true
    const line = LINES.find((l) => l.no === 42) ?? LINES[0]
    if (line) void runLine(line)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.signedIn])

  // 自动播放被拦下后，等用户第一次点击再补播（移动端必踩）
  useEffect(() => {
    if (!needGesture) return
    document.addEventListener('pointerdown', armVoice, { once: true })
    return () => document.removeEventListener('pointerdown', armVoice)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needGesture])

  // 闲置主动说话：每收到一条消息/每次忙碌状态变化都会重置计时
  useEffect(() => {
    if (!s.signedIn || !s.config.autoIdle || sheet) return
    const timer = window.setTimeout(() => {
      if (busyRef.current) return
      const pool = unlockedLines(IDLE_POOL, s.trust).filter((l) => !spokenNos.current.includes(l.no))
      const line = pick(pool)
      if (line) void runLine(line)
    }, 80_000)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.signedIn, s.config.autoIdle, s.trust, s.messages.length, busy, sheet])

  if (!s.signedIn) {
    // 登录时也把舞台放在后面，别让人对着一块纯黑等
    return (
      <main className="relative h-full w-full overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(70% 60% at 72% 30%, rgba(255,255,255,0.95), transparent 70%), radial-gradient(40% 40% at 18% 82%, rgba(18,167,189,0.10), transparent 70%), linear-gradient(180deg,#f2f2ee 0%,#eaeae6 60%,#e4e4e0 100%)',
          }}
        />
        <ParticleField />
      {/* 青色水印：呼应官方那张版式里反复出现的 Laterano 字样 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <span
            key={i}
            className="absolute select-none font-hud text-[12px] tracking-[0.42em] text-[rgba(18,167,189,0.20)]"
            style={{ left: `${6 + (i % 4) * 24}%`, top: `${10 + Math.floor(i / 4) * 74}%` }}
          >
            LATERANO
          </span>
        ))}
      </div>
        <div className="emotion-smile1 absolute inset-0 select-none">
          <Stage trust={0} onTap={() => {}} />
        </div>
        <LoginOverlay
          onEnter={(name) => {
            s.signIn(name)
          }}
        />
      </main>
    )
  }

  return (
    <main className="relative h-full w-full overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(70% 60% at 72% 30%, rgba(255,255,255,0.95), transparent 70%), radial-gradient(45% 45% at 12% 78%, rgba(18,167,189,0.12), transparent 72%), linear-gradient(180deg,#f2f2ee 0%,#eaeae6 60%,#e2e2de 100%)',
        }}
      />
      <ParticleField />

      {/* 青色水印：呼应官方那张版式里反复出现的 Laterano 字样 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <span
            key={i}
            className="absolute select-none font-hud text-[12px] tracking-[0.42em] text-[rgba(18,167,189,0.20)]"
            style={{ left: `${6 + (i % 4) * 24}%`, top: `${10 + Math.floor(i / 4) * 74}%` }}
          >
            LATERANO
          </span>
        ))}
      </div>

      <div className={`emotion-${emotion} absolute inset-0 select-none`}>
        {use3d && modelUrl ? (
          <ModelStage
            url={modelUrl}
            emotion={emotion}
            speaking={speaking}
            onTap={tapStage}
            onFail={(reason) => {
              console.warn('[3d] 模型加载失败，退回立绘：', reason)
              setModelFailed(reason)
            }}
          />
        ) : (
          <Stage trust={s.trust} onTap={tapStage} />
        )}
      </div>

      <Hud emotion={emotion} speaking={speaking} listening={listening} trust={s.trust} />

      {use3d && MODEL.demo && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2 border border-[rgba(255,179,71,0.5)] bg-[var(--po-card)] px-2 py-1 font-hud text-[10px] tracking-[0.2em] text-[var(--po-amber)]">
          占位模型 · 换成真模型见 README
        </div>
      )}

      <div className="absolute left-5 top-1/2 hidden -translate-y-1/2 font-hud text-[10px] leading-[1.9] text-[var(--po-muted)] opacity-60 md:block">
        <div>AMADEUS // TERRA</div>
        <div>NEURAL SYNC: {s.health.configured ? 'ONLINE' : 'LOCAL'}</div>
        <div>VOICE BANK: 38</div>
        <div>TRUST: {s.trust}/200</div>
      </div>

      <Toolbar
        voice={s.config.voice}
        active={sheet}
        callState={callState}
        onToggleCall={toggleCall}
        onToggleVoice={() => {
          s.setConfig({ voice: !s.config.voice })
          if (s.config.voice) {
            stopOfficial()
            stopSpeaking()
          }
        }}
        onChange={setSheet}
        onSignOut={() => {
          stopCall()
          stopOfficial()
          stopSpeaking()
          s.signOut()
        }}
      />

      {callState !== 'idle' && (
        <div
          data-call={callState}
          className="pointer-events-none fixed left-1/2 top-3 z-40 -translate-x-1/2 border border-[var(--po-line)] bg-[var(--po-card)] px-3 py-1.5 font-hud text-[11px] tracking-[0.14em] text-[var(--po-muted)] shadow-[0_2px_10px_rgba(23,24,26,0.08)]"
        >
          {callState === 'connecting' && '语音链路建立中…'}
          {callState === 'live' && <span className="text-[var(--po-amber)]">● WebRTC 通话中 · 说话就会被听见</span>}
          {callState === 'error' && (
            <span className="text-[var(--po-crimson)]">
              语音服务连不上{callError ? `（${callError.slice(0, 40)}）` : ''} —— 先跑 npm run dev:webrtc
            </span>
          )}
        </div>
      )}

      {needGesture && (
        <button
          type="button"
          onClick={armVoice}
          className="fixed left-1/2 top-4 z-50 -translate-x-1/2 border border-[var(--po-line-strong)] bg-[var(--po-card)] px-3 py-1.5 font-hud text-[11px] tracking-[0.14em] text-[var(--po-crimson)] shadow-[0_2px_10px_rgba(23,24,26,0.1)]"
        >
          浏览器拦截了自动播放 · 点一下开启语音
        </button>
      )}

      <DialogBox
        text={dialog.text}
        lineTitle={dialog.lineTitle}
        official={dialog.official}
        streaming={streaming}
        busy={busy}
        listening={listening}
        micSupported={micSupported}
        hint={s.health.configured ? '大模型生成' : '本地人格模式'}
        onSend={(t) => void send(t)}
        onToggleMic={toggleMic}
        onReplay={replayLast}
        lang={s.config.lang}
        onToggleLang={() => {
          const next = s.config.lang === 'jp' ? 'zh' : 'jp'
          s.setConfig({ lang: next })
          // 换语种后把当前这句用新语种再说一遍，别让文字和声音对不上
          const last = [...s.messages].reverse().find((m) => m.role === 'operator' && m.lineNo)
          const line = last?.lineNo ? LINES.find((l) => l.no === last.lineNo) : undefined
          if (line) void runLine(line, next)
        }}
      />

      <ChatHistory
        open={sheet === 'history'}
        messages={s.messages}
        trust={s.trust}
        onClose={() => setSheet(null)}
        onClear={s.clearHistory}
        onReplay={(m) => {
          const line = m.lineNo ? LINES.find((l) => l.no === m.lineNo) : undefined
          if (line) void playLineAudio(line)
        }}
      />

      <VoiceLibrary
        open={sheet === 'voices'}
        trust={s.trust}
        lang={s.config.lang}
        playingNo={playingNo}
        onClose={() => setSheet(null)}
        onPlay={(line) => {
          const text = lineText(line, s.config.lang)
          setDialog({ text, lineTitle: line.title, official: true })
          setEmotion(classifyEmotion(text))
          s.push({ role: 'operator', text, lineNo: line.no, lineTitle: line.title })
          void playLineAudio(line)
        }}
      />

      <ConfigPanel
        open={sheet === 'config'}
        health={s.health}
        config={s.config}
        trust={s.trust}
        name={s.name}
        hasModel={Boolean(modelUrl) && !modelFailed}
        onConfig={s.setConfig}
        onResetVoice={resetVoiceCache}
        onClearHistory={s.clearHistory}
        onSignOut={() => {
          stopOfficial()
          stopSpeaking()
          s.signOut()
        }}
        onClose={() => setSheet(null)}
      />

      {/* 播放器必须留在 DOM 上，自检和「重播」按钮都靠它 */}
      <audio id="official-voice" preload="none" className="hidden" />
      {/* WebRTC 通话的远端音轨挂这里 */}
      <audio id="voice-call" preload="auto" className="hidden" />
    </main>
  )
}
