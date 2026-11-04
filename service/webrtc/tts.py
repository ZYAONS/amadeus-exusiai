"""
SiliconFlow（硅基流动）TTS 客户端：把回复文本合成成语音，使用自定义音色。

没有配 key 时走 stub：本地生成一段很短的提示音 WAV。这样「服务端合成→回传浏览器播放」
这条路径依然是真跑通的，只是声音是个提示音，听感上不会被误当成她的配音。
"""

import io
import math
import os
import struct
import wave

import httpx

SILICONFLOW_BASE_URL = os.getenv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")
SILICONFLOW_VOICE = os.getenv("SILICONFLOW_VOICE", "")
TTS_MODEL = os.getenv("SILICONFLOW_TTS_MODEL", "FunAudioLLM/CosyVoice2-0.5B")
FORCE_STUB = os.getenv("AMADEUS_FORCE_STUB", "") == "1"


def mode() -> str:
    return "stub" if (FORCE_STUB or not SILICONFLOW_API_KEY) else "siliconflow"


def _stub_wav(text: str, sample_rate: int = 24000) -> bytes:
    """按字数给一个长短不同的双音提示音，方便在自检里量出音频确实有内容"""
    seconds = min(3.0, 0.25 + 0.06 * len(text))
    frames = int(sample_rate * seconds)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        out = bytearray()
        for i in range(frames):
            t = i / sample_rate
            env = min(1.0, t * 12) * min(1.0, (seconds - t) * 12)
            freq = 440 if (i // (sample_rate // 4)) % 2 == 0 else 554
            out += struct.pack("<h", int(8000 * env * math.sin(2 * math.pi * freq * t)))
        wf.writeframes(bytes(out))
    return buf.getvalue()


def synthesize(text: str) -> bytes:
    """文本 → WAV/MP3 字节（浏览器播放靠 WebRTC 音轨，格式由服务端统一转成 PCM）"""
    if mode() == "stub" or not text.strip():
        return _stub_wav(text)

    payload = {
        "model": TTS_MODEL,
        "voice": SILICONFLOW_VOICE,
        "input": text[:400],
        "response_format": "wav",
        "sample_rate": 24000,
    }
    with httpx.Client(timeout=90) as client:
        res = client.post(
            f"{SILICONFLOW_BASE_URL}/audio/speech",
            headers={"Authorization": f"Bearer {SILICONFLOW_API_KEY}", "Content-Type": "application/json"},
            json=payload,
        )
        res.raise_for_status()
        return res.content
