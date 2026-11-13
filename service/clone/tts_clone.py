"""零样本音色克隆合成：用官方录音当参考音，让 XTTS-v2 用「她的音色」念任意文本。

不需要训练：参考音就是官方配音里的一段（service/clone/ref/zh_reference.wav）。

    python service/clone/tts_clone.py "老板，今天有我的快递吗" out.wav
    python service/clone/tts_clone.py --lang ja "リーダー、お届け物でーす" out_ja.wav

许可提醒：XTTS-v2 的模型许可是 CPML（仅限非商业用途）；参考音来自官方配音
（著作权归鹰角网络 / 配音演员），只在本机做音色参考，不要分发、不要商用。
"""

import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models", "xtts_v2")
REF = {
    "zh": os.path.join(HERE, "ref", "zh_reference.wav"),
    "ja": os.path.join(HERE, "ref", "ja_reference.wav"),
}
LANG_ALIAS = {"zh": "zh-cn", "cn": "zh-cn", "jp": "ja", "ja": "ja"}

_tts = None


def available() -> tuple[bool, str]:
    """返回 (可用, 说明)。没装好就明确说清缺什么。"""
    if not os.path.exists(os.path.join(MODELS, "model.pth")):
        return False, "模型文件缺失（先跑 python tools/fetch-xtts.py）"
    try:
        import torch  # noqa: F401
        import TTS  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return False, f"依赖没装好：{type(e).__name__}: {e}"
    return True, "ok"


def _patch_audio_loading():
    """XTTS 用 torchaudio.load 读参考音，而 torch>=2.9 把它转给了 torchcodec，
    后者要 FFmpeg 的共享库——本机没有，于是报 libtorchcodec_core4.dll 加载失败。
    参考音是 WAV，用 soundfile 读完全够，直接把那个函数换掉。"""
    import soundfile as sf
    import torch
    import torchaudio
    import TTS.tts.models.xtts as xtts_mod

    if getattr(xtts_mod, "_amadeus_patched", False):
        return

    def load_audio(path, sampling_rate):
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        audio = torch.from_numpy(data.T.copy())
        if audio.size(0) != 1:
            audio = torch.mean(audio, dim=0, keepdim=True)
        if sr != sampling_rate:
            audio = torchaudio.functional.resample(audio, sr, sampling_rate)
        return audio.clip(-1, 1)

    xtts_mod.load_audio = load_audio
    xtts_mod._amadeus_patched = True


def _load():
    global _tts
    if _tts is not None:
        return _tts
    import torch
    from TTS.api import TTS

    _patch_audio_loading()
    torch.set_grad_enabled(False)
    t0 = time.time()
    # 直接用本地 model_path/config_path 加载：避开 coqui 那条会交互式确认许可证的自动下载
    _tts = TTS(
        model_path=os.path.join(MODELS, "model.pth"),
        config_path=os.path.join(MODELS, "config.json"),
        progress_bar=False,
        gpu=torch.cuda.is_available(),
    )
    print(f"[clone] 模型加载完成 {time.time() - t0:.1f}s（gpu={torch.cuda.is_available()}）", file=sys.stderr)
    return _tts


def synthesize(text: str, lang: str = "zh", speaker_wav: str | None = None) -> tuple[np.ndarray, int]:
    """返回 (float32 单声道, 采样率)"""
    key = "zh" if lang in ("zh", "cn") else "ja"
    ref = speaker_wav or REF[key]
    if not os.path.exists(ref):
        raise FileNotFoundError(f"参考音缺失：{ref}（先跑 python tools/make-voice-ref.py）")
    tts = _load()
    wav = tts.tts(
        text=text,
        language=LANG_ALIAS.get(lang, "zh-cn"),
        speaker_wav=ref,
        split_sentences=True,
    )
    sr = getattr(tts.synthesizer, "output_sample_rate", 24000)
    return np.asarray(wav, dtype=np.float32), int(sr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text")
    ap.add_argument("out", nargs="?", default="out.wav")
    ap.add_argument("--lang", default="zh", choices=["zh", "cn", "ja", "jp"])
    ap.add_argument("--ref", default=None, help="自定义参考音路径")
    args = ap.parse_args()

    ok, why = available()
    if not ok:
        raise SystemExit(f"克隆合成不可用：{why}")

    t0 = time.time()
    wav, sr = synthesize(args.text, args.lang, args.ref)
    dt = time.time() - t0
    # 不要引入额外依赖：用标准库写 16bit wav
    import wave

    pcm = (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"写出 {args.out}  时长 {wav.size / sr:.2f}s  采样率 {sr}  耗时 {dt:.2f}s")
    print(f"  （文本 {len(args.text)} 字 → {len(args.text) / max(dt, 1e-6):.1f} 字/秒）")


if __name__ == "__main__":
    main()
