"""
生成自检用的「真人语音」素材：edge-tts 合成一句中文 → 48k 单声道 WAV。

自检把它喂给 Chrome 的假麦克风（--use-file-for-fake-audio-capture），
这样 WebRTC 链路上跑的是**真语音**，本地 Whisper 出来的转写可以拿去和原文比对，
而不是只验证「有个字符串回来了」。

  python make_fixture.py [输出路径]
"""

import asyncio
import io
import os
import sys

import av
import edge_tts

TEXT = "老板，今天有我的快递吗"
VOICE = os.getenv("FIXTURE_VOICE", "zh-CN-XiaoxiaoNeural")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "_ref", "fixture-utterance.wav")


async def synth_mp3(text: str) -> bytes:
    comm = edge_tts.Communicate(text, voice=VOICE)
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    return bytes(buf)


def to_wav_48k_mono(mp3: bytes) -> bytes:
    """Chrome 的假麦克风要 16-bit PCM；统一成 48k 单声道"""
    container = av.open(io.BytesIO(mp3))
    resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)
    out = io.BytesIO()
    with av.open(out, "w", format="wav") as wav:
        stream = wav.add_stream("pcm_s16le", rate=48000, layout="mono")
        for frame in container.decode(audio=0):
            for res in resampler.resample(frame):
                for packet in stream.encode(res):
                    wav.mux(packet)
        for res in resampler.resample(None):
            for packet in stream.encode(res):
                wav.mux(packet)
        for packet in stream.encode(None):
            wav.mux(packet)
    return out.getvalue()


def main():
    mp3 = asyncio.run(synth_mp3(TEXT))
    wav = to_wav_48k_mono(mp3)
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(wav)
    with open(os.path.splitext(OUT)[0] + ".txt", "w", encoding="utf-8") as f:
        f.write(TEXT)
    print(f"[fixture] {TEXT} -> {OUT} ({len(wav)/1024:.0f}KB, 48k mono)")
    return OUT


if __name__ == "__main__":
    main()
