export type Health = { configured: boolean; model: string | null; persona: string }

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** 探测本地服务是否配好了模型；没起来或没配 key 都算「本地人格模式」 */
export async function fetchHealth(): Promise<Health> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as Health
  } catch {
    return { configured: false, model: null, persona: 'offline' }
  }
}

/** SSE 流式对话；服务端没配 key 时抛 OfflineError，调用方回落到本地人格引擎 */
export class OfflineError extends Error {}

export async function* chatStream(messages: ChatMessage[], userName: string): AsyncGenerator<string> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, user: userName }),
  })
  if (res.status === 501 || !res.ok || !res.body) throw new OfflineError(`chat ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const chunk = JSON.parse(payload) as { delta?: string; error?: string }
        if (chunk.error) throw new OfflineError(chunk.error)
        if (chunk.delta) yield chunk.delta
      } catch (err) {
        if (err instanceof OfflineError) throw err
      }
    }
  }
}
