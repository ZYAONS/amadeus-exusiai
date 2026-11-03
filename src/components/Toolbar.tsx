import { History, Library, Power, Settings, Volume2, VolumeX } from 'lucide-react'

type Props = {
  voice: boolean
  onToggleVoice: () => void
  onChange: (sheet: 'history' | 'voices' | 'config' | null) => void
  onSignOut: () => void
  active: 'history' | 'voices' | 'config' | null
}

const btn =
  'flex h-11 w-11 items-center justify-center rounded-full border border-[var(--po-line)] bg-[rgba(14,14,20,0.86)] text-[var(--po-muted)] backdrop-blur transition hover:border-[var(--po-crimson)] hover:text-[var(--po-bone)]'

export default function Toolbar({ voice, onToggleVoice, onChange, onSignOut, active }: Props) {
  return (
    <nav
      aria-label="工具栏"
      className="pointer-events-auto fixed right-3 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-2 md:right-5"
    >
      <button type="button" aria-label="对话记录" className={btn} onClick={() => onChange(active === 'history' ? null : 'history')}>
        <History size={17} />
      </button>
      <button type="button" aria-label="台词库" className={btn} onClick={() => onChange(active === 'voices' ? null : 'voices')}>
        <Library size={17} />
      </button>
      <button
        type="button"
        aria-label={voice ? '关闭语音' : '开启语音'}
        aria-pressed={voice}
        className={btn}
        onClick={onToggleVoice}
      >
        {voice ? <Volume2 size={17} /> : <VolumeX size={17} />}
      </button>
      <button type="button" aria-label="设置与档案" className={btn} onClick={() => onChange(active === 'config' ? null : 'config')}>
        <Settings size={17} />
      </button>
      <button type="button" aria-label="断开链接" className={btn} onClick={onSignOut}>
        <Power size={17} />
      </button>
    </nav>
  )
}
