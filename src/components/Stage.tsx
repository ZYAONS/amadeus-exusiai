import { useEffect, useState } from 'react'
import { OPERATOR, PORTRAIT_E1, PORTRAIT_E2 } from '../lib/operator'

type Props = {
  trust: number
  onTap: () => void
}

/** 精英阶段 2 起换精二立绘（门槛与 trust.ts 保持一致） */
const ELITE2_AT = 120

/** 2D 舞台：官方立绘，裁成半身（助理该有的距离感，也避开全身像腿部的呆板） */
export default function Stage({ trust, onTap }: Props) {
  const sources = trust >= ELITE2_AT ? PORTRAIT_E2 : PORTRAIT_E1
  // 候选链：本地 → 远程镜像。error 时换下一个，全都失败才显示占位（缺席是终态）
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [sources])
  const exhausted = idx >= sources.length

  return (
    <>
      {/* 贴纸白底板 */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[10vh] left-1/2 h-[64vmin] w-[64vmin] -translate-x-1/2 rounded-[45%] blur-3xl md:left-[72%]"
        style={{
          background:
            'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.98), rgba(255,255,255,0.7) 48%, rgba(255,255,255,0) 74%)',
        }}
      />

      {/* 半身窗口：图比窗口高 1.62 倍，只露头到髋，腿自然裁在窗外 */}
      <div className="absolute inset-x-0 bottom-[24vh] flex justify-center overflow-hidden md:bottom-[21vh] md:justify-end md:pr-[11vw]">
        {exhausted ? (
          <div className="border border-[var(--po-line)] px-4 py-3 font-hud text-[12px] text-[var(--po-muted)]">
            立绘信号丢失 —— 运行 <span className="text-[var(--po-crimson)]">npm run setup</span> 取回素材
          </div>
        ) : (
          <button
            type="button"
            onClick={onTap}
            title="戳一下"
            className="stage-rise group relative block h-[44vh] w-[70vw] md:h-[60vh] md:w-[34vw]"
          >
            <img
              key={idx}
              src={sources[idx]}
              alt={`${OPERATOR.name} 立绘`}
              onError={() => setIdx((i) => i + 1)}
              className="breathe absolute left-1/2 top-[-13%] h-[192%] w-auto -translate-x-1/2 object-contain drop-shadow-[0_10px_30px_rgba(23,24,26,0.18)] transition group-hover:brightness-105"
            />
            <span className="pointer-events-none absolute -bottom-1 left-1/2 -translate-x-1/2 font-hud text-[10px] tracking-[0.3em] text-[var(--po-muted)] opacity-0 transition group-hover:opacity-100">
              TAP
            </span>
          </button>
        )}
      </div>
    </>
  )
}
