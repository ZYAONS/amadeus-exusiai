import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { TRUST_MAX, TRUST_PER_TURN } from './trust'
import { fetchHealth, type Health } from './api'
import type { Emotion } from './emotion'

export type Msg = {
  id: string
  role: 'operator' | 'user'
  text: string
  /** 引用的是官方语音库里的第几条（null 表示自由生成） */
  lineNo?: number
  lineTitle?: string
  emotion?: Emotion
  at: number
}

export type Config = {
  voice: boolean
  tts: boolean
  autoIdle: boolean
  textLang: 'zh' | 'ja' | 'en'
}

const DEFAULT_CONFIG: Config = { voice: true, tts: true, autoIdle: true, textLang: 'zh' }
const KEY = 'amadeus.exusiai.v1'

type Save = { name: string; trust: number; messages: Msg[]; config: Config }

const read = (): Partial<Save> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Save>
  } catch {
    return {}
  }
}

type Store = {
  name: string
  signedIn: boolean
  signIn: (name: string) => void
  signOut: () => void
  trust: number
  bumpTrust: (n?: number) => void
  messages: Msg[]
  push: (m: Omit<Msg, 'id' | 'at'>) => Msg
  clearHistory: () => void
  config: Config
  setConfig: (patch: Partial<Config>) => void
  health: Health
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const saved = useMemo(read, [])
  const [name, setName] = useState(saved.name ?? '')
  const [trust, setTrust] = useState(saved.trust ?? 0)
  const [messages, setMessages] = useState<Msg[]>(saved.messages ?? [])
  const [config, setConfigState] = useState<Config>({ ...DEFAULT_CONFIG, ...saved.config })
  const [health, setHealth] = useState<Health>({ configured: false, model: null, persona: 'offline' })

  useEffect(() => {
    void fetchHealth().then(setHealth)
  }, [])

  useEffect(() => {
    if (!name) return
    const save: Save = { name, trust, messages: messages.slice(-60), config }
    try {
      localStorage.setItem(KEY, JSON.stringify(save))
    } catch {
      // 存不下就算了，不影响对话
    }
  }, [name, trust, messages, config])

  const push = useCallback((m: Omit<Msg, 'id' | 'at'>) => {
    const full: Msg = { ...m, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, at: Date.now() }
    setMessages((prev) => [...prev, full])
    return full
  }, [])

  const value: Store = {
    name,
    signedIn: Boolean(name),
    signIn: (n) => setName(n.trim() || '博士'),
    signOut: () => {
      setName('')
      setMessages([])
      setTrust(0)
      try {
        localStorage.removeItem(KEY)
      } catch {
        /* 忽略 */
      }
    },
    trust,
    bumpTrust: (n = TRUST_PER_TURN) => setTrust((t) => Math.min(TRUST_MAX, t + n)),
    messages,
    push,
    clearHistory: () => setMessages([]),
    config,
    setConfig: (patch) => setConfigState((c) => ({ ...c, ...patch })),
    health,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用')
  return ctx
}
