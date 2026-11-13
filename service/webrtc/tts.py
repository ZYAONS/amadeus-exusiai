"""
语音合成（TTS）。

按可用性依次回落，/health 如实报当前档位：
  1. clone：本地音色克隆服务（service/clone/server.py，XTTS-v2 + 官方录音当参考音）
     —— 这条才是「她的音色」；参考音就是官方配音里的一段，零样本，不需要训练
  2. SiliconFlow（配了 SILICONFLOW_API_KEY，可用自定义音色）
  3. 本地 edge-tts（不需要 key，微软在线语音；注意这里是通用音色，不是她）
  4. stub：本地生成一段短提示音

自检走第 3 档——所以「她的回复真的被念出来、并且经 WebRTC 传回浏览器播放」是真验证过的。
"""

import asyncio
import io
import math
import os
import struct
import time
import wave

import httpx

SILICONFLOW_BASE_URL = os.getenv("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")
SILICONFLOW_VOICE = os.getenv("SILICONFLOW_VOICE", "")
TTS_MODEL = os.getenv("SILICONFLOW_TTS_MODEL", "FunAudioLLM/CosyVoice2-0.5B")
EDGE_VOICE = os.getenv("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
FORCE_STUB = os.getenv("AMADEUS_FORCE_STUB", "") == "1"

# 本地克隆服务跑在另一个 venv 里（要 torch），所以这边只走 HTTP，不把 torch 拖进语音服务。
# CLONE_TTS=0 显式关掉；探测结果缓存 30 秒，避免每次合成都探一次。
CLONE_URL = os.getenv("CLONE_TTS_URL", "http://127.0.0.1:8100").rstrip("/")
CLONE_DISABLED = os.getenv("CLONE_TTS", "1") == "0"
_clone_probe = {"ok": None, "at": 0.0}


def _clone_available() -> bool:
    if CLONE_DISABLED:
        return False
    now = time.time()
    if _clone_probe["ok"] is not None and now - _clone_probe["at"] < 30.0:
        return bool(_clone_probe["ok"])
    try:
        res = httpx.get(f"{CLONE_URL}/health", timeout=1.5)
        ok = res.status_code == 200 and bool(res.json().get("ok"))
    except Exception:  # noqa: BLE001  没起服务就当没有
        ok = False
    _clone_probe["ok"] = ok
    _clone_probe["at"] = now
    return ok


def _clone_synth(text: str, lang: str = "zh") -> bytes:
    with httpx.Client(timeout=120) as client:
        res = client.post(f"{CLONE_URL}/tts", json={"text": text[:400], "lang": lang})
        res.raise_for_status()
        return res.content


def _edge_available() -> bool:
    try:
        import edge_tts  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def mode() -> str:
    if FORCE_STUB:
        return "stub"
    if _clone_available():
        return "clone"
    if SILICONFLOW_API_KEY:
        return "siliconflow"
    if _edge_available():
        return "edge-tts"
    return "stub"


def detail() -> dict:
    return {
        "mode": mode(),
        "edge_voice": EDGE_VOICE,
        "siliconflow_configured": bool(SILICONFLOW_API_KEY),
        "clone_url": CLONE_URL,
        "clone_disabled": CLONE_DISABLED,
    }


def _stub_wav(text: str, sample_rate: int = 24000) -> bytes:
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


def _edge_synth(text: str) -> bytes:
    import edge_tts

    async def run() -> bytes:
        comm = edge_tts.Communicate(text, voice=EDGE_VOICE)
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    # 由 pipeline 在线程池里调用，这里没有正在跑的事件循环
    return asyncio.run(run())


def synthesize(text: str, lang: str = "zh") -> bytes:
    """文本 → 音频字节（mp3/wav 均可，pipeline 统一解码成 48k PCM）"""
    kind = mode()

    if kind == "clone" and text.strip():
        try:
            return _clone_synth(text, lang)
        except Exception:  # noqa: BLE001  克隆服务挂了就往下退，别把整轮对话打断
            _clone_probe["ok"] = False
            _clone_probe["at"] = time.time()
            kind = mode()

    if kind == "siliconflow" and text.strip():
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

    if kind == "edge-tts" and text.strip():
        try:
            return _edge_synth(text)
        except Exception:  # noqa: BLE001  断网时退到提示音，别把整轮对话打断
            return _stub_wav(text)

    return _stub_wav(text)
