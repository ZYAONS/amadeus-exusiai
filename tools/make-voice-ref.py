"""从官方语音里挑一段干净录音做成克隆用的参考音（XTTS/零样本都不需要训练）。

    python tools/make-voice-ref.py            # 自动挑最长的一条中文台词
    python tools/make-voice-ref.py 7          # 指定 voice-lines.json 里的编号

输出：
    service/clone/ref/zh_reference.wav   24kHz 单声道
    service/clone/ref/zh_reference.txt   这段音频对应的逐字文本（克隆要用）
说明：参考音来自官方配音（著作权归鹰角网络 / 配音演员），只在本机做音色参考，
不要分发、不要商用。
"""

import json
import os
import subprocess
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "service", "clone", "ref")
LINES = os.path.join(ROOT, "src", "data", "voice-lines.json")
SR = 24000


def decode(path):
    """用 PyAV 解成 float32 单声道（webrtc 那个 venv 里已经有 av）"""
    import av

    with av.open(path) as c:
        stream = c.streams.audio[0]
        res = av.AudioResampler(format="fltp", layout="mono", rate=SR)
        chunks = []
        for frame in c.decode(stream):
            for f in res.resample(frame):
                chunks.append(f.to_ndarray().reshape(-1))
        for f in res.resample(None):
            chunks.append(f.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32)


def trim(x, thresh_db=-40.0, pad=0.08):
    if x.size == 0:
        return x
    env = np.abs(x)
    thr = 10 ** (thresh_db / 20.0) * max(1e-6, float(env.max()))
    idx = np.where(env > thr)[0]
    if idx.size == 0:
        return x
    a = max(0, idx[0] - int(pad * SR))
    b = min(x.size, idx[-1] + int(pad * SR))
    return x[a:b]


def main():
    with open(LINES, encoding="utf-8") as f:
        data = json.load(f)
    lines = data["lines"]
    voice_dir = os.path.join(ROOT, "public", "assets", "voice", "zh")

    want = int(sys.argv[1]) if len(sys.argv) > 1 else None
    picked = None
    if want is not None:
        picked = next((l for l in lines if int(l["no"]) == want), None)
        if picked is None:
            raise SystemExit(f"没有编号 {want} 的台词")
    else:
        best = -1.0
        for l in lines:
            p = os.path.join(voice_dir, l["file"])
            if not os.path.exists(p):
                continue
            x = decode(p)
            d = x.size / SR
            # 8~14 秒最好：太短参考不足，太长容易带上多余停顿
            score = -abs(d - 11.0)
            if score > best:
                best, picked = score, l
        if picked is None:
            raise SystemExit("没找到官方语音文件，先跑 npm run setup")

    src = os.path.join(voice_dir, picked["file"])
    x = trim(decode(src))
    os.makedirs(OUT, exist_ok=True)
    wav_path = os.path.join(OUT, "zh_reference.wav")
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    txt_path = os.path.join(OUT, "zh_reference.txt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(picked["zh"].strip() + "\n")

    print(f"参考音: {wav_path}")
    print(f"  来源台词 #{picked['no']} {picked['title']}（{picked['file']}）")
    print(f"  时长 {x.size / SR:.2f}s  采样率 {SR}  峰值 {float(np.abs(x).max()):.2f}")
    print(f"  对应文本: {picked['zh'][:40]}…")
    print(f"文本文件: {txt_path}")


if __name__ == "__main__":
    main()
