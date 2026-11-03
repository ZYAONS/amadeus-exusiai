import { useState } from 'react'
import { OPERATOR } from '../lib/operator'

export default function LoginOverlay({ onEnter }: { onEnter: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(4,4,6,0.86)] backdrop-blur-md">
      <form
        className="fade-up w-[min(92vw,440px)] border border-[var(--po-line)] bg-[rgba(8,8,11,0.9)] p-8"
        onSubmit={(e) => {
          e.preventDefault()
          onEnter(name)
        }}
      >
        <div className="font-hud text-[11px] tracking-[0.35em] text-[var(--po-muted)]">AMADEUS // TERRA</div>
        <h1 className="mt-3 text-2xl font-bold tracking-wide">
          神经同步终端<span className="text-[var(--po-crimson)]">·</span>新约能天使
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--po-muted)]">
          系统将依据官方档案重建 {OPERATOR.name} 的情感与语气，并允许调用她的
          <span className="text-[var(--po-halo)]">官方语音库</span> 回应你。请输入你的代号以建立链接。
        </p>
        <label className="mt-6 block font-hud text-[11px] tracking-[0.2em] text-[var(--po-muted)]" htmlFor="callsign">
          你的代号（她一般会叫你「{OPERATOR.address}」）
        </label>
        <input
          id="callsign"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="博士"
          autoComplete="off"
          className="mt-2 w-full border border-[var(--po-line)] bg-[rgba(16,16,24,0.9)] px-3 py-2 text-[15px] text-[var(--po-bone)] outline-none focus:border-[var(--po-crimson)]"
        />
        <button
          type="submit"
          className="mt-6 w-full bg-[linear-gradient(92deg,var(--po-amber),var(--po-crimson))] px-4 py-3 text-[15px] font-bold tracking-wide text-[#1a0708] transition hover:brightness-110 active:brightness-95"
        >
          建立链接
        </button>
        <p className="mt-4 text-[11px] leading-relaxed text-[var(--po-muted)]">
          非官方同人作品。立绘、语音与台词著作权归上海鹰角网络科技有限公司所有，本项目仅作个人学习用途。
        </p>
      </form>
    </div>
  )
}
