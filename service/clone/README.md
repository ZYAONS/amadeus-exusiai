# 本地音色克隆（零样本，不训练）

用**她自己的官方配音**当参考音，让 XTTS-v2 用她的音色念任意文本。
不是训练：参考音只是 `service/clone/ref/*.wav`（从 38 条官方语音里挑的一段），
模型权重一个字没动。

## 一次性准备

```bash
# 1. 环境（要 torch，和语音服务的 venv 分开，避免把 2.8 GB 的 torch 拖进 WebRTC 服务）
python -m venv service/clone/.venv
service/clone/.venv/Scripts/python.exe -m pip install coqui-tts torch torchaudio torchcodec six pypinyin cutlet unidic-lite
#    CUDA 版 torch（本机 RTX 5070，cu128）：
#    service/clone/.venv/Scripts/python.exe -m pip install --index-url https://download.pytorch.org/whl/cu128 torch torchaudio

# 2. 模型（1.79 GB，Coqui XTTS-v2，许可是 CPML——仅限非商业）
service/clone/.venv/Scripts/python.exe tools/fetch-xtts.py

# 3. 参考音（从官方语音里挑最长的一条，转 24k 单声道，并写出对应文本）
service/webrtc/.venv/Scripts/python.exe tools/make-voice-ref.py
```

## 跑起来

```bash
node tools/run-clone.mjs        # 或 npm run voice:clone，默认 127.0.0.1:8100
```

模型加载约 20~26 秒（一次性），之后每句推理 **约 2.3~3.4 秒**（GPU）。
`service/webrtc/tts.py` 会探测这个服务，探到就把 `mode` 报成 `clone` 并优先用它；
没起服务就按 SiliconFlow → edge-tts → stub 的顺序回退（`CLONE_TTS=0` 可显式关掉）。

## 为什么听起来不一样了（客观数据）

用 `tools/voice-similarity.py` 比 f0 中位数与频谱重心，参考是她的官方录音：

| | f0 中位 | 频谱重心 | 相对她 |
| --- | --- | --- | --- |
| 官方录音（她本人） | 307.7 Hz | 1796 Hz | — |
| 克隆（中配参考） | 285.7 Hz | 1825 Hz | f0 −7.1%、重心 +29 Hz（接近） |
| edge-tts 晓晓（旧行为） | 266.7 Hz | 1316 Hz | f0 −13.3%、重心 **−479 Hz**（明显不同） |
| 官方录音（日配） | 250.0 Hz | 1626 Hz | — |
| 克隆（日配参考） | 258.1 Hz | 1417 Hz | f0 +3.2%、重心 −210 Hz（接近） |

那 479 Hz 的重心差就是「听起来不像她」的量化来源：晓晓的音色比她的暗很多。

## 许可与边界

- XTTS-v2 模型是 **CPML**：仅限非商业用途。
- 参考音来自官方配音（著作权归鹰角网络 / 配音演员），只在本机做音色参考：
  不要分发、不要商用、不要拿去冒充官方。
- 参考音与模型都不入库（`.gitignore` 已挡住 `service/clone/ref/`、`models/`、`.venv/`）。
- 音质受参考音限制：只有 10 秒左右的单人干净录音，情绪起伏比真人单一；
  要更稳可以多给几段参考音（`tts_clone.synthesize(speaker_wav=...)` 支持换路径）。
