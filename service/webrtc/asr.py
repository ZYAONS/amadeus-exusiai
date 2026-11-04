"""
Whisper（或任何 OpenAI 兼容的语音转写接口）客户端。

没有配 key 时走 stub：返回一句固定文本，让整条链路（VAD→ASR→LLM→TTS→回传）
仍然可以端到端跑通并被自检断言。stub 会在 /health 里标出来，绝不假装是真识别。
"""

import io
import os
import wave

import httpx

WHISPER_BASE_URL = os.getenv("WHISPER_BASE_URL", "https://api.openai.com/v1").rstrip("/")
WHISPER_API_KEY = os.getenv("WHISPER_API_KEY", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-1")
FORCE_STUB = os.getenv("AMADEUS_FORCE_STUB", "") == "1"

STUB_TEXT = os.getenv("AMADEUS_STUB_ASR_TEXT", "老板在吗，今天有我的快递吗")


def mode() -> str:
    return "stub" if (FORCE_STUB or not WHISPER_API_KEY) else "whisper"


def transcribe(pcm16: bytes, sample_rate: int = 48000) -> str:
    """一段 s16le 单声道 PCM → 文本"""
    if mode() == "stub":
        return STUB_TEXT

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16)
    buf.seek(0)

    files = {"file": ("utterance.wav", buf.getvalue(), "audio/wav")}
    data = {"model": WHISPER_MODEL, "language": "zh"}
    with httpx.Client(timeout=60) as client:
        res = client.post(
            f"{WHISPER_BASE_URL}/audio/transcriptions",
            headers={"Authorization": f"Bearer {WHISPER_API_KEY}"},
            files=files,
            data=data,
        )
        res.raise_for_status()
        return (res.json().get("text") or "").strip()
