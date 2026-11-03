import Sheet from './Sheet'
import type { Msg } from '../lib/store'
import { OPERATOR } from '../lib/operator'

type Props = {
  open: boolean
  messages: Msg[]
  trust: number
  onClose: () => void
  onClear: () => void
  onReplay: (m: Msg) => void
}

export default function ChatHistory({ open, messages, trust, onClose, onClear, onReplay }: Props) {
  return (
    <Sheet open={open} title="记忆档案" subtitle={`LINKED · ${OPERATOR.name}`} side="left" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between font-hud text-[11px] text-[var(--po-muted)]">
        <span>{messages.length} 条记录 · 信赖 {trust}</span>
        <button type="button" onClick={onClear} className="text-[var(--po-crimson)] transition hover:brightness-125">
          清空记录
        </button>
      </div>

      {messages.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-[var(--po-muted)]">
          还没有记录。她记得住的东西都在这份档案里——换台机器就没有了，因为一切都是本地存储。
        </p>
      ) : (
        <ol className="space-y-3">
          {messages.map((m) => (
            <li key={m.id} className="border-l border-[var(--po-line)] pl-3">
              <div className="flex items-center gap-2 font-hud text-[10px] tracking-[0.16em] text-[var(--po-muted)]">
                <span className={m.role === 'user' ? 'text-[var(--po-halo)]' : 'text-[var(--po-amber)]'}>
                  {m.role === 'user' ? '你' : OPERATOR.name}
                </span>
                {m.lineTitle && <span className="opacity-70">官方语音 · {m.lineTitle}</span>}
                <time className="ml-auto opacity-60">
                  {new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{m.text}</p>
              {m.role === 'operator' && (
                <button
                  type="button"
                  onClick={() => onReplay(m)}
                  className="mt-1 font-hud text-[10px] text-[var(--po-muted)] transition hover:text-[var(--po-bone)]"
                >
                  ▷ 重播这句
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  )
}
