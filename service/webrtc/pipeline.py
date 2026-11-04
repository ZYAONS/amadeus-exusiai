"""
语音链路：麦克风 PCM → VAD 断句 → Whisper 转写 → 大模型回复 → SiliconFlow 合成 → 回传。

VAD 用能量阈值（20ms 一帧），不额外拉依赖；参数都在环境变量里，实测可调。
"""

import asyncio
import audioop
import io
import json
import logging
import os
import random
from pathlib import Path

import av
import httpx

import asr
import tts

log = logging.getLogger("amadeus.voice")

SAMPLE_RATE = 48000
FRAME_SAMPLES = 960  # 20ms @ 48k
RMS_THRESHOLD = int(os.getenv("VAD_RMS", "900"))
SILENCE_MS = int(os.getenv("VAD_SILENCE_MS", "700"))
MIN_SPEECH_MS = int(os.getenv("VAD_MIN_SPEECH_MS", "240"))
MAX_SEGMENT_MS = int(os.getenv("VAD_MAX_SEGMENT_MS", "8000"))
LLM_URL = os.getenv("AMADEUS_CHAT_URL", "http://127.0.0.1:3002/api/chat")

STATS = {
    "frames_in": 0,
    "segments": 0,
    "transcripts": 0,
    "replies": 0,
    "tts_bytes": 0,
    "frames_out": 0,
    "max_rms": 0,
    "voiced_frames": 0,
}

# 没有大模型时的兜底：只引用官方台词库（和网页版「本地人格模式」同一条规矩）
_LINES_PATH = Path(__file__).resolve().parents[2] / "src/data/voice-lines.json"
_RULES = [
    (("你好", "在吗", "在么", "老板", "早上", "晚上"), [42, 1]),
    (("苹果", "吃", "饿", "派"), [36, 28]),
    (("快递", "包裹", "物流", "送"), [1, 33]),
    (("作战", "任务", "上班", "出发"), [19, 20]),
    (("累", "休息", "睡"), [10, 9]),
]


def _load_lines() -> list[dict]:
    try:
        return json.loads(_LINES_PATH.read_text(encoding="utf-8"))["lines"]
    except Exception:  # noqa: BLE001
        log.warning("读不到 %s，离线回复将不可用", _LINES_PATH)
        return []


def offline_reply(text: str) -> str:
    """不编造她的台词：只从官方台词库里挑"""
    lines = _load_lines()
    if not lines:
        return "（本地人格模式：台词库没加载上）"
    for keys, nos in _RULES:
        if any(k in text for k in keys):
            for no in nos:
                hit = next((ln for ln in lines if ln["no"] == no and ln.get("zh")), None)
                if hit:
                    return hit["zh"]
    pick = random.choice([ln for ln in lines if ln.get("zh")])
    return pick["zh"]



def stats() -> dict:
    import os as _os

    return dict(STATS, asr=asr.mode(), tts=tts.mode(), pid=_os.getpid())


class VoiceSession:
    """一次通话：吃麦克风音频、吐出她的语音，并通过 data channel 推事件"""

    def __init__(self, user: str = "博士"):
        self.user = user
        self.buffer = bytearray()
        self.speech_ms = 0
        self.silence_ms = 0
        self.in_speech = False
        self.events: list[dict] = []      # 待通过 data channel 发出的事件
        self.out_queue: asyncio.Queue = asyncio.Queue()
        self._busy = asyncio.Lock()

    # ---------- 音频输入 ----------
    def feed(self, pcm16: bytes) -> None:
        """喂一段 s16le 48k 单声道 PCM，跑到断句就触发一轮处理"""
        global STATS
        STATS["frames_in"] += 1
        chunk_ms = 20
        rms = audioop.rms(pcm16, 2) if pcm16 else 0
        voiced = rms >= RMS_THRESHOLD
        if rms > STATS["max_rms"]:
            STATS["max_rms"] = rms
        if voiced:
            STATS["voiced_frames"] += 1

        if voiced:
            self.in_speech = True
            self.speech_ms += chunk_ms
            self.silence_ms = 0
            self.buffer.extend(pcm16)
        elif self.in_speech:
            self.silence_ms += chunk_ms
            self.buffer.extend(pcm16)
            if self.silence_ms >= SILENCE_MS or self.speech_ms >= MAX_SEGMENT_MS:
                self._cut()

        if self.in_speech and self.speech_ms >= MAX_SEGMENT_MS:
            self._cut()

    def _cut(self) -> None:
        global STATS
        STATS["cut_calls"] = STATS.get("cut_calls", 0) + 1
        log.info("断句判定: speech=%dms silence=%dms buffer=%dB", self.speech_ms, self.silence_ms, len(self.buffer))
        if self.speech_ms < MIN_SPEECH_MS or not self.buffer:
            self.buffer.clear()
            self.speech_ms = 0
            self.silence_ms = 0
            self.in_speech = False
            return
        segment = bytes(self.buffer)
        self.buffer.clear()
        self.speech_ms = 0
        self.silence_ms = 0
        self.in_speech = False
        STATS["segments"] += 1
        asyncio.create_task(self._handle(segment))

    # ---------- 一轮处理 ----------
    async def _handle(self, segment: bytes) -> None:
        global STATS
        async with self._busy:
            try:
                self.events.append({"type": "state", "state": "thinking"})
                loop = asyncio.get_running_loop()
                text = await loop.run_in_executor(None, asr.transcribe, segment)
                if not text:
                    self.events.append({"type": "state", "state": "listening"})
                    return
                STATS["transcripts"] += 1
                self.events.append({"type": "final", "text": text})

                reply = await self._llm(text)
                STATS["replies"] += 1
                self.events.append({"type": "reply", "text": reply})

                audio = await loop.run_in_executor(None, tts.synthesize, reply)
                STATS["tts_bytes"] += len(audio)
                await self._enqueue_audio(audio)
                self.events.append({"type": "state", "state": "listening"})
            except Exception as exc:  # noqa: BLE001
                log.exception("处理失败")
                self.events.append({"type": "error", "message": f"{type(exc).__name__}: {exc}"})

    async def _llm(self, text: str) -> str:
        """优先用 Node 那份人格服务（同一套 prompt）；没配模型/连不上就退到官方台词库"""
        try:
            history = [{"role": "user", "content": text}]
            collected = []
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream("POST", LLM_URL, json={"messages": history, "user": self.user}) as res:
                    if res.status_code == 501:
                        return offline_reply(text)
                    if res.status_code != 200:
                        log.warning("人格服务返回 %s，改用官方台词", res.status_code)
                        return offline_reply(text)
                    async for raw in res.aiter_lines():
                        if not raw.startswith("data:"):
                            continue
                        payload = raw[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            collected.append(json.loads(payload).get("delta", ""))
                        except json.JSONDecodeError:
                            continue
            reply = "".join(collected).strip()
            return reply or offline_reply(text)
        except Exception as exc:  # noqa: BLE001
            log.warning("连不上人格服务（%s），改用官方台词", exc)
            return offline_reply(text)

    # ---------- 音频输出 ----------
    async def _enqueue_audio(self, data: bytes) -> None:
        """把 TTS 出来的音频统一转成 48k 单声道 s16，塞进输出队列"""
        try:
            container = av.open(io.BytesIO(data))
        except Exception:
            log.warning("TTS 返回的不是可解码音频，跳过")
            return
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                pcm = bytes(out.planes[0])[: out.samples * 2]
                await self.out_queue.put(pcm)
        for out in resampler.resample(None):
            pcm = bytes(out.planes[0])[: out.samples * 2]
            await self.out_queue.put(pcm)

    def drain_events(self) -> list[dict]:
        out, self.events = self.events, []
        return out
