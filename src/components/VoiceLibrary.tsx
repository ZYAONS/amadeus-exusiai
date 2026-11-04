import { Lock, Play } from 'lucide-react'
import Sheet from './Sheet'
import { LINES, VOICE, lineText, type VoiceLang, type VoiceLine } from '../lib/operator'
import { isUnlocked, lockLabel } from '../lib/trust'

type Props = {
  open: boolean
  trust: number
  lang: VoiceLang
  playingNo?: number
  onClose: () => void
  onPlay: (line: VoiceLine) => void
}

export default function VoiceLibrary({ open, trust, lang, playingNo, onClose, onPlay }: Props) {
  const unlocked = LINES.filter((l) => isUnlocked(l, trust)).length
  return (
    <Sheet
      open={open}
      title="台词库"
      subtitle={`OFFICIAL VOICE · ${unlocked}/${LINES.length} 已解锁 · ${lang === 'jp' ? '日本語' : '中文'}`}
      onClose={onClose}
    >
      <p className="mb-4 border-l-2 border-[var(--po-crimson)] pl-3 text-[12px] leading-relaxed text-[var(--po-muted)]">
        全部为官方原话与官方配音音频，未做任何改写。中配与日配都有，按设置里选的语种播放；解锁条件沿用游戏内设定（精英阶段换算成信赖门槛）。
      </p>
      <ul className="space-y-1.5">
        {LINES.map((line) => {
          const open_ = isUnlocked(line, trust)
          const active = playingNo === line.no
          return (
            <li key={line.no}>
              <button
                type="button"
                disabled={!open_}
                onClick={() => onPlay(line)}
                className={`flex w-full items-start gap-2 border px-2.5 py-2 text-left transition ${
                  open_
                    ? 'border-[var(--po-line)] hover:border-[var(--po-amber)] hover:bg-[var(--po-amber-soft)]'
                    : 'border-dashed border-[var(--po-line)] opacity-45'
                } ${active ? 'border-[var(--po-amber)] bg-[var(--po-amber-soft)]' : ''}`}
              >
                <span className="mt-[3px] shrink-0 text-[var(--po-amber)]">
                  {open_ ? <Play size={11} /> : <Lock size={11} />}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 font-hud text-[10px] tracking-[0.14em] text-[var(--po-muted)]">
                    <span className="text-[var(--po-halo)]">{line.title}</span>
                    <span>{line.no.toString().padStart(2, '0')}</span>
                    {line.unlock && (
                      <span className={open_ ? 'text-[var(--po-muted)]' : 'text-[var(--po-crimson)]'}>
                        {open_ ? `· ${lockLabel(line)}` : `· 需 ${lockLabel(line)}`}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug">{lineText(line, lang)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-5 text-[11px] leading-relaxed text-[var(--po-muted)]">{VOICE.copyright}</p>
      <p className="mt-1 text-[11px] text-[var(--po-muted)]">
        来源：<span className="text-[var(--po-halo)]">{VOICE.source}</span>
      </p>
    </Sheet>
  )
}
