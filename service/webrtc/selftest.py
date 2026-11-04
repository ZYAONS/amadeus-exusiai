"""
语音链路自检（不经浏览器、不依赖 Chrome 假麦克风的边界行为）。

把 make_fixture 生成的那句已知语音按 20ms 帧喂进 pipeline：
  VAD 断句 → Whisper 转写 → 人格服务 → TTS 合成
然后比对「转写」与「原文」的字符重合度，并把计数器打出来。

为什么单独做这一层：Chrome 的假麦克风会把一句话切成碎片，Whisper 对 1 秒碎片
会像对噪音一样「脑补」（实测会编出「如果大家喜歡我的影片」这种句子）。
所以要验 ASR 的准确率，就得给它完整的一句音频；WebRTC 那层只验传输。

  python selftest.py          输出 JSON（给 tools/check.mjs 解析）
"""

import asyncio
import json
import os
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import asr  # noqa: E402
import pipeline  # noqa: E402
import tts  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WAV = os.path.join(HERE, "..", "..", "_ref", "fixture-utterance.wav")


def overlap(a: str, b: str) -> float:
    """字符重合度（去掉标点），用来给「转写和原文是否同一句」打分"""
    if not a or not b:
        return 0.0
    norm = lambda s: "".join(ch for ch in s if ch not in " \t\r\n，。、？！,.?!「」()（）")  # noqa: E731
    A, B = norm(a), norm(b)
    if not A:
        return 0.0
    hit = sum(1 for ch in A if ch in B)
    return hit / len(A)


async def run(wav_path: str) -> dict:
    text_path = os.path.splitext(wav_path)[0] + ".txt"
    source = open(text_path, encoding="utf-8").read().strip() if os.path.exists(text_path) else ""

    with wave.open(wav_path, "rb") as wf:
        pcm = wf.readframes(wf.getnframes())

    session = pipeline.VoiceSession(user="博士")
    step = pipeline.FRAME_SAMPLES * 2  # 20ms
    for i in range(0, len(pcm), step):
        session.feed(pcm[i : i + step])
        await asyncio.sleep(0)
    for _ in range(40):  # 补静音触发断句
        session.feed(b"\x00" * step)
        await asyncio.sleep(0.01)

    events = []
    for _ in range(240):
        events += session.drain_events()
        if pipeline.STATS["replies"] > 0 and (pipeline.STATS["tts_bytes"] > 0 or any(e.get("type") == "error" for e in events)):
            break
        await asyncio.sleep(0.5)
    events += session.drain_events()

    transcript = next((e.get("text", "") for e in events if e.get("type") == "final"), "")
    reply = next((e.get("text", "") for e in events if e.get("type") == "reply"), "")
    error = next((e.get("message", "") for e in events if e.get("type") == "error"), "")

    return {
        "source": source,
        "transcript": transcript,
        "reply": reply,
        "error": error,
        "overlap": round(overlap(source, transcript), 3),
        "asr": asr.mode(),
        "tts": tts.mode(),
        "stats": {k: pipeline.STATS[k] for k in ("frames_in", "segments", "transcripts", "replies", "tts_bytes", "interrupts")},
        "queued_frames": session.out_queue.qsize(),
    }


def main() -> int:
    wav = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_WAV
    if not os.path.exists(wav):
        print(json.dumps({"ok": False, "error": f"没有素材 {wav}；先跑 make_fixture.py"}, ensure_ascii=False))
        return 2
    result = asyncio.run(run(wav))
    result["ok"] = bool(result["transcript"]) and not result["error"]
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
