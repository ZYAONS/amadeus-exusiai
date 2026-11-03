import { useEffect, useState } from 'react'
import { OPERATOR, PORTRAIT_E1, PORTRAIT_E2 } from '../lib/operator'
import { rankOf, TRUST_MAX } from '../lib/trust'
import type { Emotion } from '../lib/emotion'
import { EMOTION_LABEL } from '../lib/emotion'

type Props = {
  emotion: Emotion
  speaking: boolean
  listening: boolean
  trust: number
  onTap: () => void
}

/** 精英阶段 2 起换精二立绘（门槛与 trust.ts 保持一致） */
const ELITE2_AT = 120

export default function Stage({ emotion, speaking, listening, trust, onTap }: Props) {
  const sources = trust >= ELITE2_AT ? PORTRAIT_E2 : PORTRAIT_E1
  // 候选链：本地 → 远程镜像。error 时换下一个，全都失败才显示占位（缺席是终态）
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [sources])
  const exhausted = idx >= sources.length
  const pct = Math.round((trust / TRUST_MAX) * 100)

  return (
    <div className={`emotion-${emotion} absolute inset-0 select-none`}>
      {/* 光晕：软的，不对齐任何具体部位，换图也不会错位 */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[4vh] left-1/2 h-[78vmin] w-[78vmin] -translate-x-1/2 rounded-full blur-3xl md:left-[70%]"
        style={{
          background:
            'radial-gradient(circle, rgba(255,179,71,0.20), rgba(224,57,60,0.14) 42%, rgba(8,8,11,0) 72%)',
        }}
      />

      {/* 立绘：底边抬到对话框上沿，别让靴子被 HUD 吃掉 */}
      <div className="absolute inset-x-0 bottom-[26vh] flex justify-center md:bottom-[22vh] md:justify-end md:pr-[7vw]">
        {exhausted ? (
          <div className="border border-[var(--po-line)] px-4 py-3 font-hud text-[12px] text-[var(--po-muted)]">
            立绘信号丢失 —— 运行 <span className="text-[var(--po-halo)]">npm run setup</span> 取回素材
          </div>
        ) : (
          <button
            type="button"
            onClick={onTap}
            title="戳一下"
            className="stage-rise group relative block h-[52vh] md:h-[64vh]"
          >
            <img
              key={idx}
              src={sources[idx]}
              alt={`${OPERATOR.name} 立绘`}
              onError={() => setIdx((i) => i + 1)}
              className="breathe h-full w-auto object-contain drop-shadow-[0_18px_60px_rgba(224,57,60,0.28)] transition group-hover:brightness-105"
            />
            <span className="pointer-events-none absolute -bottom-1 left-1/2 -translate-x-1/2 font-hud text-[10px] tracking-[0.3em] text-[var(--po-muted)] opacity-0 transition group-hover:opacity-100">
              TAP
            </span>
          </button>
        )}
      </div>

      {/* 名牌 */}
      <div className="absolute left-5 top-5 max-w-[68vw] md:left-8 md:top-7">
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
    </div>
  )
}
