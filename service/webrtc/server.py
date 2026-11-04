"""
WebRTC 语音服务（aiortc）。

  python service/webrtc/server.py         # 默认 http://127.0.0.1:8001

提供：
  GET  /health          → 组件状态与计数器（asr/tts 是 whisper/siliconflow 还是 stub）
  GET  /stats           → 只读计数器，自检用它确认「音频真的到了服务端」
  POST /rtc/offer       → SDP 交换：收 offer，回 answer，把音轨和 data channel 接起来

音频方向：浏览器麦克风 →(Opus/WebRTC)→ 本服务 → VAD 断句 → Whisper → Node 人格服务
        → SiliconFlow 合成 →(PCM 48k/WebRTC)→ 浏览器播放。
事件（转写 / 回复 / 状态）走浏览器开的 data channel。
"""

import asyncio
import json
import logging
import os
from fractions import Fraction

import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamTrack
from av import AudioFrame
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import pipeline

logging.basicConfig(level=logging.INFO, format="[webrtc] %(levelname)s %(message)s")
log = logging.getLogger("amadeus.webrtc")

PORT = int(os.getenv("WEBRTC_PORT", "8001"))
SAMPLES = pipeline.FRAME_SAMPLES

app = FastAPI(title="AMADEUS // TERRA · WebRTC voice")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_peers: set[RTCPeerConnection] = set()


class SpeakerTrack(MediaStreamTrack):
    """回传给浏览器的音轨：从 session 的输出队列取 PCM，没内容就送静音帧"""

    kind = "audio"

    def __init__(self, session: pipeline.VoiceSession):
        super().__init__()
        self.session = session
        self.pts = 0

    async def recv(self):
        try:
            pcm = await asyncio.wait_for(self.session.out_queue.get(), timeout=0.4)
        except asyncio.TimeoutError:
            pcm = b""
        data = np.frombuffer(pcm, dtype=np.int16)[:SAMPLES]
        if data.size < SAMPLES:
            data = np.pad(data, (0, SAMPLES - data.size))
        frame = AudioFrame(format="s16", layout="mono", samples=SAMPLES)
        frame.sample_rate = pipeline.SAMPLE_RATE
        frame.planes[0].update(data.astype(np.int16).tobytes())
        frame.pts = self.pts
        frame.time_base = Fraction(1, pipeline.SAMPLE_RATE)
        self.pts += SAMPLES
        pipeline.STATS["frames_out"] += 1
        return frame


async def consume_mic(track, session: pipeline.VoiceSession):
    """把浏览器送上来的音轨解成 s16 单声道，喂给 VAD"""
    while True:
        try:
            frame = await track.recv()
        except Exception:  # noqa: BLE001  轨结束或连接断了
            log.info("远端音轨结束")
            return
        pcm = frame.to_ndarray()
        if pcm.dtype != np.int16:
            pcm = np.clip(pcm, -1.0, 1.0)
            pcm = (pcm * 32767).astype(np.int16)
        if pcm.ndim > 1:
            pcm = pcm.mean(axis=0).astype(np.int16)
        session.feed(pcm.tobytes())


async def pump_events(pc: RTCPeerConnection, session: pipeline.VoiceSession, channels: list):
    """把 pipeline 产生的事件推到 data channel（浏览器开的那个）"""
    while pc.connectionState not in ("failed", "closed"):
        for event in session.drain_events():
            for ch in channels:
                if ch.readyState == "open":
                    try:
                        ch.send(json.dumps(event, ensure_ascii=False))
                    except Exception:  # noqa: BLE001
                        pass
        await asyncio.sleep(0.1)


class Offer(BaseModel):
    sdp: str
    type: str
    user: str = "博士"


@app.get("/health")
def health():
    return {
        "ok": True,
        **pipeline.stats(),
        "vad": {
            "rms": pipeline.RMS_THRESHOLD,
            "silence_ms": pipeline.SILENCE_MS,
            "min_speech_ms": pipeline.MIN_SPEECH_MS,
            "max_segment_ms": pipeline.MAX_SEGMENT_MS,
        },
    }


@app.get("/stats")
def stats_only():
    return pipeline.stats()


@app.post("/rtc/offer")
async def rtc_offer(offer: Offer):
    session = pipeline.VoiceSession(user=offer.user)
    pc = RTCPeerConnection()
    _peers.add(pc)

    pc.addTrack(SpeakerTrack(session))
    channels: list = []

    @pc.on("datachannel")
    def _on_datachannel(dc):
        log.info("datachannel 打开: %s", dc.label)
        channels.append(dc)

    @pc.on("track")
    def _on_track(track):
        log.info("收到远端音轨: %s", track.kind)
        if track.kind == "audio":
            asyncio.ensure_future(consume_mic(track, session))
            asyncio.ensure_future(pump_events(pc, session, channels))

    @pc.on("connectionstatechange")
    async def _on_state():
        log.info("连接状态: %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            _peers.discard(pc)
            await pc.close()

    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer.sdp, type=offer.type))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}


if __name__ == "__main__":
    import uvicorn

    log.info("ASR=%s TTS=%s LLM=%s", pipeline.asr.mode(), pipeline.tts.mode(), pipeline.LLM_URL)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
