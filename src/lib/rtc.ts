/**
 * WebRTC 通话：浏览器做 offer，服务端（aiortc）回 answer。
 * 麦克风音轨上行、她的语音下行，转写与回复文本走 data channel。
 */

export type CallEvent =
  | { type: 'state'; state: string }
  | { type: 'final'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'error'; message: string }

export type CallHandle = {
  stop: () => void
  connectionState: () => string
}

/** 等 ICE 收集完（不做 trickle：服务端只收一次 SDP，简单可靠） */
function waitForIce(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    window.setTimeout(done, timeoutMs)
  })
}

export async function startVoiceCall(
  user: string,
  onEvent: (event: CallEvent) => void,
  remoteAudio: HTMLAudioElement,
): Promise<CallHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  })
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })

  const stop = () => {
    try {
      pc.close()
    } catch {
      /* 关掉就行 */
    }
    for (const t of stream.getTracks()) t.stop()
    remoteAudio.srcObject = null
  }

  try {
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)

    const dc = pc.createDataChannel('events', { ordered: true })
    dc.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)) as CallEvent)
      } catch {
        // 不是 JSON 就忽略
      }
    }

    pc.ontrack = (ev) => {
      remoteAudio.srcObject = ev.streams[0]
      void remoteAudio.play().catch(() => {
        // 自动播放被拦时用户点一下就会播
      })
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIce(pc)

    const res = await fetch('/rtc/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp, type: pc.localDescription?.type, user }),
    })
    if (!res.ok) throw new Error(`信令失败 ${res.status}`)
    const answer = (await res.json()) as RTCSessionDescriptionInit
    await pc.setRemoteDescription(answer)
  } catch (err) {
    stop()
    throw err
  }

  return { stop, connectionState: () => pc.connectionState }
}
