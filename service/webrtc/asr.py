"""
语音转写（ASR）。

按可用性依次回落，且 /health 会如实报出当前用的是哪一档：
  1. Whisper API（配了 WHISPER_API_KEY）
  2. 本地 faster-whisper（没配 key 也能真转写；模型由 WHISPER_LOCAL_MODEL 指定，默认 tiny）
  3. stub：固定文本，只用于既没有模型也没有网络的机器

本地这条路是自检实际走的：Chrome 假麦克风播真语音 → 本地 Whisper 转写 →
再和原文比字符重合度，而不是「有个字符串回来了」就算过。
"""

import io
import os
import tempfile
import wave

import httpx

WHISPER_BASE_URL = os.getenv("WHISPER_BASE_URL", "https://api.openai.com/v1").rstrip("/")
WHISPER_API_KEY = os.getenv("WHISPER_API_KEY", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-1")
WHISPER_LOCAL_MODEL = os.getenv("WHISPER_LOCAL_MODEL", "tiny")
WHISPER_LOCAL_COMPUTE = os.getenv("WHISPER_LOCAL_COMPUTE", "int8")
FORCE_STUB = os.getenv("AMADEUS_FORCE_STUB", "") == "1"

STUB_TEXT = os.getenv("AMADEUS_STUB_ASR_TEXT", "老板在吗，今天有我的快递吗")

_local_model = None
_local_error = None


def _local_available() -> bool:
    global _local_error
    if _local_model is not None:
        return True
    if _local_error is not None:
        return False
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        _local_error = f"faster-whisper 不可用: {exc}"
        return False
    return True


def _get_local_model():
    global _local_model, _local_error
    if _local_model is not None:
        return _local_model
    try:
        from faster_whisper import WhisperModel

        _local_model = WhisperModel(WHISPER_LOCAL_MODEL, device="cpu", compute_type=WHISPER_LOCAL_COMPUTE)
        return _local_model
    except Exception as exc:  # noqa: BLE001
        _local_error = f"本地模型加载失败: {exc}"
        return None


def mode() -> str:
    if FORCE_STUB:
        return "stub"
    if WHISPER_API_KEY:
        return "whisper-api"
    if _local_available() and _get_local_model() is not None:
        return "whisper-local"
    return "stub"


def detail() -> dict:
    """给 /health 用：说清为什么是这个档"""
    return {
        "mode": mode(),
        "local_model": WHISPER_LOCAL_MODEL,
        "local_error": _local_error,
        "api_configured": bool(WHISPER_API_KEY),
    }


def _write_wav(pcm16: bytes, sample_rate: int) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16)
    fd, path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(buf.getvalue())
    return path


def transcribe(pcm16: bytes, sample_rate: int = 48000) -> str:
    """一段 s16le 单声道 PCM → 文本"""
    kind = mode()

    if kind == "whisper-local":
        model = _get_local_model()
        path = _write_wav(pcm16, sample_rate)
        try:
            segments, _info = model.transcribe(
                path,
                language="zh",
                beam_size=1,
                vad_filter=True,
                # 这三个参数是专门压「对噪音/碎片脑补出一句不存在的话」的
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
            )
            text = "".join(s.text for s in segments).strip()
            # 太短的输出多半是幻觉（比如一两声呼吸被编成半句话），直接丢掉
            return text if len(text) >= 2 else ""
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    if kind == "whisper-api":
        path = _write_wav(pcm16, sample_rate)
        try:
            with open(path, "rb") as fh:
                files = {"file": ("utterance.wav", fh.read(), "audio/wav")}
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
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    return STUB_TEXT
