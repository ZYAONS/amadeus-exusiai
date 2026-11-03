import { voiceCandidates } from './operator'

// 播放器必须挂在 DOM 上（<audio id="official-voice">）：游离的 new Audio() 外面 querySelector
// 找不到，自检也没法验证「真的在响」。
const el = () => document.getElementById('official-voice') as HTMLAudioElement | null

// 「先试完所有地址，再判缺席」：本地 → 中文配音 → 日配，全部试过才认命
const absent = new Set<string>()

export function resetVoiceCache() {
  absent.clear()
}

export type PlayResult = 'playing' | 'blocked' | 'absent'

export async function playOfficial(file: string): Promise<PlayResult> {
  const audio = el()
  if (!audio || absent.has(file)) return 'absent'
  for (const src of voiceCandidates(file)) {
    audio.src = src
    try {
      await audio.play()
      return 'playing'
    } catch (err) {
      // 移动端会在没有用户手势时用 NotAllowedError 拒掉 play()：
      // 这不是素材问题，不能算「缺席」，否则这条语音以后永远放不出来。
      if ((err as DOMException)?.name === 'NotAllowedError') return 'blocked'
      // 其余（NotSupportedError / 解码失败）换下一个镜像
    }
  }
  absent.add(file)
  return 'absent'
}

export function stopOfficial() {
  const audio = el()
  if (audio) {
    audio.pause()
    audio.currentTime = 0
  }
}

/** 浏览器 TTS：没有官方语音可用时读回复正文 */
export function speak(
  text: string,
  hooks: { onStart?: () => void; onEnd?: () => void } = {},
): boolean {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return false
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text.replace(/[（(][^）)]*[）)]/g, ''))
  const zh = synth.getVoices().find((v) => /^zh/i.test(v.lang))
  if (zh) u.voice = zh
  u.lang = zh?.lang ?? 'zh-CN'
  u.rate = 1.05
  u.pitch = 1.15
  u.onstart = () => hooks.onStart?.()
  u.onend = () => hooks.onEnd?.()
  u.onerror = () => hooks.onEnd?.()
  synth.speak(u)
  return true
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel()
}
