"""把构建好的单文件程序发到 GitHub Release（含 SHA256SUMS）。

凭据用 `git credential fill` 现取现用，不落盘、不打印 token。
    python _ref/release.py [标签] [标题]
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "ZYAONS/amadeus-exusiai"
TAG = sys.argv[1] if len(sys.argv) > 1 else "v0.1.0"
TITLE = sys.argv[2] if len(sys.argv) > 2 else "v0.1.0 · 第一个可下载版本"
EXE = os.path.join("build", "amadeus-exusiai.exe")


def creds():
    out = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
    ).stdout
    kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    return kv["username"], kv["password"]


user, token = creds()
AUTH = "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode()


def api(path, method="GET", body=None, raw=None, ctype="application/json", host="api.github.com"):
    data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode() if body else None)
    req = urllib.request.Request(
        f"https://{host}{path}",
        method=method,
        data=data,
        headers={
            "Authorization": AUTH,
            "User-Agent": "dsh-release",
            "Accept": "application/vnd.github+json",
            "Content-Type": ctype,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        try:
            return e.code, json.loads(body_txt or "{}")
        except json.JSONDecodeError:
            return e.code, {"raw": body_txt[:400]}


with open(EXE, "rb") as f:
    blob = f.read()
sha = hashlib.sha256(blob).hexdigest()
name = os.path.basename(EXE)
size_mb = len(blob) / 1024 / 1024
print(f"产物 {name} {size_mb:.1f} MB  sha256={sha}")

# 已有同名 release 先清掉（gh release create 不幂等，同名会撞）
status, existing = api(f"/repos/{REPO}/releases/tags/{TAG}")
if status == 200:
    print(f"已存在 release {TAG}，先删除")
    api(f"/repos/{REPO}/releases/{existing['id']}", method="DELETE")

body = f"""单文件可执行程序：下载后双击即可，它会起一个本地端口并用默认浏览器打开。

## 这是什么
《明日方舟》新约能天使的 Amadeus 风格 AI 助理终端。程序里内联了前端（约 960 KB），
官方立绘/语音/3D 模型不在程序内（著作权不属于本项目），程序会回落到 PRTS 的在线地址；
想用 3D 舞台，把 GLB 放到程序同目录的 `assets/model/character.glb` 即可。

## 校验
```
sha256  {sha}
大小    {size_mb:.1f} MB
```
下载后建议先核对（PowerShell：`Get-FileHash {name} -Algorithm SHA256`）。

## 已知边界
- 不含 LLM 代理与 WebRTC 语音服务：对话会退到本地人格引擎，电话按钮不可用。
  要完整功能请用仓库里的 `npm run dev` + `npm run dev:api`。
- 只发布了 Windows x64 产物。

构建与自检由 `tools/build-exe.mjs` 完成，产物在构建脚本里被真实运行过
（`--self-test` + 起服务器抓首页 + 取内联 js + `/api/health`）。
"""

status, rel = api(
    f"/repos/{REPO}/releases",
    method="POST",
    body={
        "tag_name": TAG,
        "target_commitish": "main",
        "name": TITLE,
        "body": body,
        "draft": False,
        "prerelease": False,
    },
)
if status not in (200, 201):
    sys.exit(f"建 release 失败：{status} {rel}")
print(f"release 已建：{rel['html_url']}")

# 上传产物
status, asset = api(
    f"/repos/{REPO}/releases/{rel['id']}/assets?name={name}",
    method="POST",
    raw=blob,
    ctype="application/octet-stream",
    host="uploads.github.com",
)
if status not in (200, 201):
    sys.exit(f"上传产物失败：{status} {asset}")
print(f"产物已上传：{asset['browser_download_url']}（{asset['size']/1024/1024:.1f} MB）")

# 上传校验和
sums = f"{sha}  {name}\n".encode()
status, asset2 = api(
    f"/repos/{REPO}/releases/{rel['id']}/assets?name=SHA256SUMS.txt",
    method="POST",
    raw=sums,
    ctype="text/plain",
    host="uploads.github.com",
)
print(f"校验和已上传：{asset2.get('browser_download_url')}")
print("下载地址（latest）：" + f"https://github.com/{REPO}/releases/latest/download/{name}")
