"""常驻的克隆 TTS 服务：模型只加载一次，之后按需合成。

    python service/clone/server.py [--port 8100]

接口：
    GET  /health              → 模型/设备/加载耗时/是否预热
    POST /tts  {text, lang}   → audio/wav 二进制
    POST /say  {text, lang}   → 同 /tts（别名）

为什么要常驻：单次进程序列化加载 XTTS 要 ~20s，加上推理一次 50s 以上，
对话里根本没法用；常驻之后只剩推理时间。

许可提醒：XTTS-v2 是 CPML（非商业）；参考音来自官方配音，仅本机音色参考用。
"""

import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

import tts_clone  # noqa: E402

STATE = {
    "ready": False,
    "device": "?",
    "load_seconds": 0.0,
    "warmup_seconds": 0.0,
    "calls": 0,
    "last_seconds": 0.0,
    "tts": None,
}
LOCK = threading.Lock()


def boot(preload=True):
    import torch

    t0 = time.time()
    if preload:
        STATE["tts"] = tts_clone._load()
        STATE["load_seconds"] = round(time.time() - t0, 2)
        STATE["device"] = "cuda" if torch.cuda.is_available() else "cpu"
        # 预热：第一句总是慢的（kernel 编译/cache），提前吃掉
        t1 = time.time()
        try:
            tts_clone.synthesize("嗯。", "zh")
        except Exception as e:  # noqa: BLE001
            print(f"[clone] 预热失败（不影响后续）：{type(e).__name__}: {e}", file=sys.stderr)
        STATE["warmup_seconds"] = round(time.time() - t1, 2)
        STATE["ready"] = True
        print(
            f"[clone] 就绪：device={STATE['device']} 加载 {STATE['load_seconds']}s "
            f"预热 {STATE['warmup_seconds']}s",
            file=sys.stderr,
            flush=True,
        )


def wav_bytes(wav, sr):
    pcm = (np.clip(wav, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 少打点日志
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(
                200,
                {
                    "ok": STATE["ready"],
                    "engine": "xtts-v2-clone",
                    "device": STATE["device"],
                    "load_seconds": STATE["load_seconds"],
                    "warmup_seconds": STATE["warmup_seconds"],
                    "calls": STATE["calls"],
                    "last_seconds": STATE["last_seconds"],
                    "ref": {k: os.path.exists(v) for k, v in tts_clone.REF.items()},
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not (self.path.startswith("/tts") or self.path.startswith("/say")):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            text = (payload.get("text") or "").strip()
            lang = payload.get("lang") or "zh"
            if not text:
                self._json(400, {"error": "text 为空"})
                return
            t0 = time.time()
            with LOCK:
                wav, sr = tts_clone.synthesize(text, lang)
            dt = time.time() - t0
            STATE["calls"] += 1
            STATE["last_seconds"] = round(dt, 2)
            data = wav_bytes(wav, sr)
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(data)))
            self.send_header("x-synth-seconds", f"{dt:.2f}")
            self.send_header("x-sample-rate", str(sr))
            self.end_headers()
            self.wfile.write(data)
            print(f"[clone] {len(text)} 字 / {lang} → {wav.size / sr:.2f}s 音频，耗时 {dt:.2f}s",
                  file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.getenv("CLONE_TTS_PORT", "8100")))
    ap.add_argument("--no-preload", action="store_true", help="先不加载模型（调试用）")
    args = ap.parse_args()
    boot(preload=not args.no_preload)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[clone] 监听 http://127.0.0.1:{args.port}", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
