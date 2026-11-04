import { OPERATOR } from '../lib/operator'
import { rankOf, TRUST_MAX } from '../lib/trust'
import { EMOTION_LABEL, type Emotion } from '../lib/emotion'

type Props = {
  emotion: Emotion
  speaking: boolean
  listening: boolean
  trust: number
}

/** 舞台上的 HUD：名牌、信赖度、情绪与说话状态。与「用立绘还是 3D 模型」无关 */
export default function Hud({ emotion, speaking, listening, trust }: Props) {
  const pct = Math.round((trust / TRUST_MAX) * 100)

  return (
    <div className="pointer-events-none absolute left-5 top-5 max-w-[68vw] md:left-8 md:top-7">
      <div className="font-hud text-[10px] tracking-[0.42em] text-[var(--po-muted)]">RHODES ISLAND // DATA LINK</div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[15px] tracking-[0.4em] text-[var(--po-amber)]">{'★'.repeat(OPERATOR.stars)}</span>
        <h1 className="text-2xl font-bold tracking-wide md:text-3xl">{OPERATOR.name}</h1>
      </div>
      <div className="mt-1 font-hud text-[11px] leading-relaxed tracking-[0.16em] text-[var(--po-muted)]">
        {OPERATOR.nameEn.toUpperCase()} ·{' '}
        <span className="whitespace-nowrap">
          {OPERATOR.klass}/{OPERATOR.branch}
        </span>
        <span className="hidden sm:inline"> · {OPERATOR.faction}</span>
      </div>

      <div className="mt-4 w-[min(58vw,300px)]">
        <div className="flex items-baseline justify-between font-hud text-[11px] text-[var(--po-muted)]">
          <span>{rankOf(trust)}</span>
          <span className="text-[var(--po-halo)]">{pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="信赖度"
          aria-valuemin={0}
          aria-valuemax={TRUST_MAX}
          aria-valuenow={trust}
          className="mt-1 h-[3px] w-full bg-[rgba(242,234,224,0.14)]"
        >
          <div
            className="h-full bg-[linear-gradient(90deg,var(--po-amber),var(--po-crimson))] transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 font-hud text-[11px] text-[var(--po-muted)]">
        <span className="border border-[var(--po-line)] px-2 py-[2px]">{EMOTION_LABEL[emotion]}</span>
        {speaking && (
          <span className="flex items-end gap-[2px]" aria-label="说话中">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="w-[3px] bg-[var(--po-amber)]"
                style={{ height: 12, animation: `bar ${0.5 + i * 0.12}s ease-in-out infinite`, transformOrigin: 'bottom' }}
              />
            ))}
          </span>
        )}
        {listening && <span className="text-[var(--po-crimson)]">● 录音中</span>}
      </div>
    </div>
  )
}
