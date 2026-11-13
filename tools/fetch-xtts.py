"""把 XTTS-v2 的模型文件下到本地目录（避开 coqui 那条会交互式询问许可证的自动下载）。

    python tools/fetch-xtts.py

下载到 service/clone/models/xtts_v2/。模型是 Coqui 的 XTTS-v2，许可是 CPML——
**仅限非商业用途**。下载后 tts_server.py 用 model_path/config_path 直接加载，不再询问。
"""

import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "service", "clone", "models", "xtts_v2")
NEED = [
    "config.json",
    "model.pth",
    "vocab.json",
    "speakers_xtts.pth",
    "hash.md5",
]


def main():
    from huggingface_hub import hf_hub_download

    os.makedirs(OUT, exist_ok=True)
    for name in NEED:
        dest = os.path.join(OUT, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            print(f"已有 {name} ({os.path.getsize(dest)/1024/1024:.1f} MB)")
            continue
        print(f"下载 {name} …")
        p = hf_hub_download(
            repo_id="coqui/XTTS-v2",
            filename=name,
            local_dir=OUT,
            local_dir_use_symlinks=False,
        )
        if os.path.abspath(p) != os.path.abspath(dest):
            shutil.copyfile(p, dest)
        print(f"  -> {dest} ({os.path.getsize(dest)/1024/1024:.1f} MB)")
    total = sum(os.path.getsize(os.path.join(OUT, n)) for n in NEED if os.path.exists(os.path.join(OUT, n)))
    print(f"完成：{OUT}（合计 {total/1024/1024:.1f} MB）")


if __name__ == "__main__":
    main()
