import type { ReactNode } from 'react'
import { X } from 'lucide-react'

type Props = {
  open: boolean
  title: string
  subtitle?: string
  side?: 'left' | 'right'
  onClose: () => void
  children: ReactNode
}

/** 三块面板共用的抽屉壳 */
export default function Sheet({ open, title, subtitle, side = 'right', onClose, children }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[600]">
      <button
        type="button"
        aria-label="关闭面板"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-[rgba(23,24,26,0.28)] backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-label={title}
        className={`fade-up absolute bottom-0 top-0 flex w-[min(94vw,420px)] flex-col border-[var(--po-line)] bg-[var(--po-card)] shadow-[-8px_0_40px_rgba(23,24,26,0.12)] ${
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r'
        }`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--po-line)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-bold tracking-wide">{title}</h2>
            {subtitle && (
              <p className="mt-1 font-hud text-[10px] tracking-[0.2em] text-[var(--po-muted)]">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="text-[var(--po-muted)] transition hover:text-[var(--po-bone)]"
          >
            <X size={17} />
          </button>
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  )
}
