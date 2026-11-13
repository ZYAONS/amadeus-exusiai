"""客观比对两段语音的音色特征：基频（f0）分布 + 频谱重心。

    python tools/voice-similarity.py 参考.wav 候选1.wav [候选2.wav ...]

为什么要有它：合成出来「像不像她」最终得靠耳朵，但「换没换成她的音色」可以用数字看：
f0 的中位数/四分位与频谱重心如果能落到官方录音的同一区间，至少说明不是另一个音色在念。
这不是听感的替代品，只是把它变成可核对的东西。
"""

import os
import sys
import wave

import numpy as np

SR = 16000
FRAME = 1024
HOP = 256
F0_MIN = 70.0
F0_MAX = 400.0


def load(path):
    """返回 float32 单声道 16k；wav 直接用 wave，其余交给 av"""
    if path.lower().endswith(".wav"):
        try:
            with wave.open(path, "rb") as w:
                sr = w.getframerate()
                n = w.getnchannels()
                raw = w.readframes(w.getnframes())
            x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            if n > 1:
                x = x.reshape(-1, n).mean(axis=1)
            if sr != SR:
                x = resample(x, sr, SR)
            return x
        except Exception:
            pass
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
    return np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(0, dtype=np.float32)


def resample(x, sr, target):
    # 简易线性重采样，够用来算统计量
    n = int(round(x.size * target / sr))
    if n <= 1:
        return x
    idx = np.linspace(0, x.size - 1, n)
    return np.interp(idx, np.arange(x.size), x).astype(np.float32)


def f0_track(x):
    """自相关法估基频（逐帧），返回有声音的 f0 序列"""
    if x.size < FRAME:
        return np.zeros(0, dtype=np.float32)
    win = np.hanning(FRAME).astype(np.float32)
    lo = int(SR / F0_MAX)
    hi = int(SR / F0_MIN)
    out = []
    for i in range(0, x.size - FRAME, HOP):
        seg = x[i : i + FRAME]
        if float(np.sqrt(np.mean(seg**2))) < 0.01:  # 静音帧丢掉
            continue
        seg = (seg - seg.mean()) * win
        ac = np.correlate(seg, seg, mode="full")[FRAME - 1 :]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        seg_lo = min(hi, ac.size - 1)
        if seg_lo <= lo:
            continue
        k = lo + int(np.argmax(ac[lo:seg_lo]))
        if ac[k] < 0.3:
            continue
        out.append(SR / k)
    return np.asarray(out, dtype=np.float32)


def centroid(x):
    """频谱重心（Hz）的一个粗略中位数，反映明亮度"""
    if x.size < FRAME:
        return 0.0
    vals = []
    for i in range(0, x.size - FRAME, HOP * 4):
        seg = x[i : i + FRAME]
        if float(np.sqrt(np.mean(seg**2))) < 0.01:
            continue
        spec = np.abs(np.fft.rfft(seg * np.hanning(FRAME)))
        freqs = np.fft.rfftfreq(FRAME, 1 / SR)
        s = spec.sum()
        if s <= 0:
            continue
        vals.append(float((spec * freqs).sum() / s))
    return float(np.median(vals)) if vals else 0.0


def report(path):
    x = load(path)
    f0 = f0_track(x)
    if f0.size == 0:
        return {"file": os.path.basename(path), "dur": x.size / SR, "f0": None}
    return {
        "file": os.path.basename(path),
        "dur": x.size / SR,
        "f0": f0,
        "med": float(np.median(f0)),
        "p10": float(np.percentile(f0, 10)),
        "p90": float(np.percentile(f0, 90)),
        "cent": centroid(x),
    }


def main():
    paths = sys.argv[1:]
    if len(paths) < 2:
        raise SystemExit("用法: python tools/voice-similarity.py 参考.wav 候选.wav [...]")
    rows = [report(p) for p in paths]
    print(f"{'文件':28s} {'时长':>6s} {'f0中位':>7s} {'f0 p10':>7s} {'f0 p90':>7s} {'重心Hz':>8s}")
    for r in rows:
        if r["f0"] is None:
            print(f"{r['file'][:28]:28s} {r['dur']:6.2f}  f0 估不出来")
            continue
        print(
            f"{r['file'][:28]:28s} {r['dur']:6.2f} {r['med']:7.1f} {r['p10']:7.1f} "
            f"{r['p90']:7.1f} {r['cent']:8.0f}"
        )
    ref = rows[0]
    if ref["f0"] is None:
        return
    print()
    for r in rows[1:]:
        if r["f0"] is None:
            continue
        d_med = r["med"] - ref["med"]
        # f0 分布的差别用两个中位数相对差表示；<10% 通常听感上已经很接近
        rel = abs(d_med) / max(1.0, ref["med"]) * 100
        verdict = "接近" if rel < 10 else ("有差距" if rel < 25 else "明显不同")
        print(
            f"{r['file'][:28]:28s} 与参考比: f0 中位差 {d_med:+.1f} Hz（{rel:.1f}%）"
            f"  重心差 {r['cent'] - ref['cent']:+.0f} Hz  → {verdict}"
        )


if __name__ == "__main__":
    main()
