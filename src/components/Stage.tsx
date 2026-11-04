import { useEffect, useState } from 'react'
import { OPERATOR, PORTRAIT_E1, PORTRAIT_E2 } from '../lib/operator'

type Props = {
  trust: number
  onTap: () => void
}

/** 精英阶段 2 起换精二立绘（门槛与 trust.ts 保持一致） */
const ELITE2_AT = 120

/** 2D 舞台：官方立绘。光晕是软的，不对齐任何具体部位，换图也不会错位 */
export default function Stage({ trust, onTap }: Props) {
  const sources = trust >= ELITE2_AT ? PORTRAIT_E2 : PORTRAIT_E1
  // 候选链：本地 → 远程镜像。error 时换下一个，全都失败才显示占位（缺席是终态）
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [sources])
  const exhausted = idx >= sources.length

  return (
    <>
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
    </>
  )
}
