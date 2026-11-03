import { useEffect, useRef, useState } from 'react'
import { Mic, Send, Square, Volume2 } from 'lucide-react'
import type { VoiceLang } from '../lib/operator'

type Props = {
  text: string
  lineTitle?: string
  official: boolean
  streaming: boolean
  busy: boolean
  listening: boolean
  micSupported: boolean
  onSend: (text: string) => void
  onToggleMic: () => void
  onReplay: () => void
  hint: string
  lang: VoiceLang
  onToggleLang: () => void
}

/** 打字机：data-typing 是给自检用的——动画没走完就断言文本，会得到一屏假失败 */
function useTypewriter(text: string, streaming: boolean) {
  const [shown, setShown] = useState('')
  const raf = useRef(0)
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || streaming) {
      setShown(text)
      return
    }
    let i = 0
    cancelAnimationFrame(raf.current)
    const tick = () => {
      i += Math.max(1, Math.round(text.length / 90))
      setShown(text.slice(0, i))
      if (i < text.length) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [text, streaming])
  return { shown, typing: shown.length < text.length }
}

export default function DialogBox({
  text,
  lineTitle,
  official,
  streaming,
  busy,
  listening,
  micSupported,
  onSend,
  onToggleMic,
  onReplay,
  hint,
  lang,
  onToggleLang,
}: Props) {
  const [draft, setDraft] = useState('')
  const { shown, typing } = useTypewriter(text, streaming)

  const send = () => {
    const t = draft.trim()
    if (!t || busy) return
    setDraft('')
    onSend(t)
  }

  return (
    <section
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-30 px-3 pb-3 md:px-8 md:pb-6"
      aria-label="对话区"
    >
      <div
        className="relative mx-auto max-w-[1080px] border border-[var(--po-line)] bg-[rgba(14,14,20,0.82)] backdrop-blur-md"
        style={{ boxShadow: '0 0 40px rgba(224,57,60,0.10)' }}
      >
        <div className="h-[2px] w-full bg-[linear-gradient(90deg,var(--po-amber),var(--po-crimson))]" />

        <div className="flex flex-wrap items-center gap-2 px-4 pt-2 font-hud text-[10px] tracking-[0.2em] text-[var(--po-muted)]">
          <span className="text-[var(--po-halo)]">新约能天使</span>
          {/* 当前模式永远要写出来：靠官方台词回答的时候尤其不能让人误以为是真模型 */}
          <span className="border border-[var(--po-line)] px-1.5 py-[1px]">{hint}</span>
          {official && lineTitle && (
            <span className="border border-[rgba(255,179,71,0.5)] px-1.5 py-[1px] text-[var(--po-amber)]">
              官方语音 · {lineTitle}
            </span>
          )}
          <button
            type="button"
            onClick={onToggleLang}
            aria-label="切换配音语言"
            title="切换中配 / 日配"
            className="ml-auto border border-[var(--po-line)] px-1.5 py-[1px] text-[10px] text-[var(--po-halo)] transition hover:border-[var(--po-amber)]"
          >
            {lang === 'jp' ? '日本語' : '中文'}
          </button>
          <button
            type="button"
            onClick={onReplay}
            className="flex items-center gap-1 text-[var(--po-muted)] transition hover:text-[var(--po-bone)]"
            aria-label="重播上一句"
          >
            <Volume2 size={13} /> 重播
          </button>
        </div>

        <div
          className="scroll-thin max-h-[22vh] min-h-[86px] overflow-y-auto px-4 py-2 text-[15px] leading-relaxed md:text-[16px]"
          role="log"
          aria-live="polite"
          data-typing={typing}
        >
          {shown ? (
            <p className={typing ? 'caret' : undefined}>{shown}</p>
          ) : (
            <p className="text-[var(--po-muted)]">{busy ? '……' : '点一下立绘，或者直接跟她说点什么。'}</p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--po-line)] px-3 py-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
            placeholder={listening ? '在听……也可以直接打字' : '对她说点什么'}
            aria-label="输入框"
            className="min-w-0 flex-1 bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-[rgba(242,234,224,0.35)]"
          />
          <button
            type="button"
            onClick={onToggleMic}
            disabled={!micSupported}
            title={micSupported ? '语音输入' : '当前浏览器不支持语音识别（Chrome / Edge 可用）'}
            aria-pressed={listening}
            aria-label="语音输入"
            className={`flex h-9 w-9 items-center justify-center rounded-full border transition ${
              listening
                ? 'border-[var(--po-crimson)] bg-[rgba(224,57,60,0.22)] text-[var(--po-crimson)]'
                : 'border-[var(--po-line)] text-[var(--po-muted)] hover:text-[var(--po-bone)]'
            } ${micSupported ? '' : 'opacity-40'}`}
          >
            {listening ? <Square size={14} /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            onClick={send}
            disabled={busy || !draft.trim()}
            className="flex h-9 items-center gap-1.5 bg-[linear-gradient(92deg,var(--po-amber),var(--po-crimson))] px-3 text-[13px] font-bold text-[#1a0708] transition disabled:opacity-40"
          >
            <Send size={13} /> 发送
          </button>
        </div>
      </div>
    </section>
  )
}
