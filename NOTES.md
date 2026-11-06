# AMADEUS // TERRA · 新约能天使 —— 实现笔记

这份文件是逐项的实现记录与踩坑结论：材质与取景、mocap 重定向、语音链路、自检、版权。
面向使用者的一句话介绍和启动命令在 [README.md](README.md)。

照着 [ai-poet/amadeus-system-new](https://github.com/ai-poet/amadeus-system-new) 的思路做的明日方舟版本：一个网页终端，能打字也能开口跟「新约能天使」说话，她会用官方语音回应（中配蔡书瑾、日配石見舞菜香，随时切），信赖涨到一定程度会换精二立绘。舞台默认是官方立绘，放一个 3D 模型进来就换成能转动的模型。

立绘、配音、台词、档案数据都是官方的；代码和界面是本项目写的。非官方同人作品。

## 下载就能跑（单文件 exe）

不想装 Node 的话，直接拿 [Release](https://github.com/ZYAONS/amadeus-exusiai/releases/latest) 里的 `amadeus-exusiai.exe`（Windows x64，89.6 MB）：双击启动，它会占一个本地端口（默认 17800，被占用自动往后找）并用默认浏览器打开。

程序里**只内联前端**（`index.html` + 4 个 js/css，共 960 KB）。官方立绘、语音、3D 模型不打包进去——它们 35 MB 且著作权不是本项目的。运行时会这样退：

- 立绘、语音 → 回落到 PRTS 的在线地址（`media.prts.wiki` / `torappu.prts.wiki`），能直接显示、能播
- 3D 舞台 → 把 GLB 放进程序同目录的 `assets/model/character.glb` 就能用；没有就退回立绘
- 对话 → 没有 LLM 代理，`/api/health` 返回 `configured: false`，前端退到本地人格引擎（这是 `src/lib/api.ts` 里本来就写好的行为）
- 实时语音通话 → 不可用（要 Python 的 aiortc 服务），`/rtc/*` 返回 501

重新构建：

```bash
npm run build                          # 先出 dist/
node tools/build-exe.mjs               # 打包 + 注入 + 产物自检
```

`tools/build-exe.mjs` 用 Node SEA：把前端资源作为 SEA assets 一起内联，复制当前 node 当外壳，再 postject 注入 blob。**最后一步是运行产物**：`--self-test` 检查内联资源齐全且 `index.html` 里有页面标记，然后真的启动服务器抓首页、取一个内联 js、打一次 `/api/health`。任何一项不过就直接报错，不产出可发布的东西（`--self-test` 第一行打印的必须是本程序版本号——如果打印的是 Node 版本号，说明注入失败）。

两个 Node SEA 的坑：入口必须能被当 CJS 加载（`desktop/main.cjs` 是零依赖纯 CJS）；**`getAsset(name, "buffer")` 在 Node 24 上直接抛 `ERR_ENCODING_NOT_SUPPORTED`**，二进制要用 `getRawAsset`。

发版：`npm run release`（`tools/release-exe.py` 按 `git credential fill` 现取 token，建 tag/release 并上传 exe + `SHA256SUMS.txt`）。产物不进仓库（`build/`、`*.exe`、`*.blob` 都在 `.gitignore` 里）。

## GitHub Pages 发不了（实测）

静态站本身能构建（`npx tsc --noEmit && npx vite build --base=/<仓库名>/`，前缀不能省），`.github/workflows/pages.yml` 也写好了。但**私有仓库 + 免费账号不能发布 Pages**，API 直接回：

```
422 Your current plan does not support GitHub Pages for this repository.
```

要发 Pages 得把仓库设为公开，或升级 Pro。所以主推 exe + Release。

还有一个坑：当前这个 PAT 没有 `workflow` 权限，**推不动 `.github/workflows/` 下的文件**（`refusing to allow a Personal Access Token to create or update workflow`）。所以那两个工作流目前只在本机，要进仓库得重新签发带 `workflow` scope 的 token，或在网页 UI 里直接添加。

## 先跑起来

```bash
npm install
npm run setup     # 取回两张立绘 + 38 条台词的中配与日配，约 13 MB，需要联网
npm run dev       # http://127.0.0.1:1002
```

`npm run setup` 会把素材落到 `public/assets/`（已在 `.gitignore` 里）。没跑这一步也能起，立绘会回源 PRTS 加载，语音取不到就走浏览器 TTS 或干脆不出声，台词和对话逻辑不受影响。

想让她真的会聊天，再起一个本地服务：

```bash
cp .env.example .env    # 填 LLM_BASE_URL / LLM_API_KEY / AI_MODEL
npm run dev:api         # http://127.0.0.1:3002，vite 的 /api 已反代过去
```

## 两种模式

没有模型可用时进入**本地人格模式**：回复只从官方台词库里按关键词挑一句，界面左上角那枚角标会写明当前模式。挑不到合适的就明说挑不到。不编台词是刻意的——颜色配错了没人拿去对出处，台词编错了每个读者都会发现。

配好 `.env` 之后走大模型流式对话，人格提示词在 `service/server.mjs` 里，没有下发到浏览器。

## 她为什么会说话

同一句台词存了中文与日文两份文本，音频也各有一份（PRTS 上 `voice_cn/` 是中配、`voice/` 是日配，文件名一模一样）。对话框右上角那枚按钮切语种，设置里也能改，切换后当前这句会用新语种重说一遍，不让文字和声音对不上。

播放走三级候选地址：本地 `public/assets/voice/{zh,jp}/` → 对应语种的 PRTS 目录。前一个失败才换下一个，都试完才认定这条不行并记住。移动端浏览器在用户点击前会拒掉播放，这时屏幕上会出现一条「点一下开启语音」，点击后补播刚才那句。

官方音频取不到时用浏览器 TTS 读文本，按当前语种挑系统语音包，不用它冒充配音。

## 3D 舞台

舞台默认用官方立绘。把一个 GLB 接进来就换成 3D 模型，设置里的「舞台人物」可以随时切回去。

```bash
node tools/fetch-model.mjs D:\下载\新约能天使.glb   # 手头已经有 .glb / .vrm
npm run model:demo                                # 只想看看 3D 链路通不通（生成一个方盒子，不是她）
```

手头是 `.blend` 的话用现成的导出脚本（这台机器上 Blender 在 `D:\Blender\4.2\blender.exe`，4.2.9 LTS）。现在台上这位就是这么来的：

```bash
"D:\Blender\4.2\blender.exe" -b "mod\新约阿能v2分享.blend" --python tools/blender-export-glb.py -- "_ref\exusiai.glb" --max-tex 1024
node tools/fetch-model.mjs "_ref\exusiai.glb"
```

原始 `.blend` 是 301 MB、著作权不在本项目，`mod/` 已在 `.gitignore` 里。导出脚本在这份模型上踩到三件事，换成别的 MMD 风模型同样会遇到：

**一、rigify 的控制器会被一起导出。** `use_selection=False` 会把三个 `WGTS_*` 集合里 100 个控制器网格、13 盏灯、相机全带上，体积翻几倍。脚本改成只挑「可见且名字不以 `WGT-` 开头」的对象。

**二、脸和眼睛没有 Principled BSDF。** 它们是 MMD/toon 节点（`TEX_IMAGE → HUE_SAT → 自定义节点组 → 输出`），glTF 导出器只认 Principled，于是整张脸导出去是一片没有五官的皮肤色。脚本从输出节点的 Surface 顺着链接往回追，找到真正喂颜色的那张图再压成 Principled。别按「节点树里最大的图」猜——那会把身体材质猜成脸的贴图（第一次就这么错的）。

**三、压平之后 alpha 怎么设，导出器说了算。** 脸是好几层重叠贴片，用半透明混合会互相透成鬼影；但 Blender 4.2 的导出器不读 `blend_method` 也不读 `surface_render_method`，它认的是节点形状——Alpha 前面挂一个 `Math: GREATER_THAN(0.5)` 才导出 `alphaMode=MASK`（源码里的 `detect_alpha_clip`）。眼睛高光那片单独走 BLEND，否则会变成一块白斑。

结果：38 个网格（44 个 primitive）、37.3 万三角形、22.86 MB，带一段 4 秒的 idle 动画。贴图分两档——身体衣物压到 512，脸和眼睛留 4096（观众只看这一块，其余可以压狠一点）。

手臂也放下来了，但这件事比看上去麻烦：**这份 `.blend` 里 ARP 的 FK 开关是死的**。`rotFK / locFK / scaleFK` 三个约束的 influence 被一条**变量未绑定**的驱动器锁在 0（文件里的 `RIG-骨架_ui.py` 被禁用，ARP 重绑那条链没跑），手写 `influence = 1.0` 会在下一次求值被改回 0——实测把 `arm_fk.l` 转 90°，可见骨动 **0.00°**。反过来把 IK 关掉更糟：IK 解算一撤销，手臂就从「垂在身侧」（`arm_stretch` 垂度 0.99 / 侧展 0.15）退回作者 A-pose（垂度 0.71 / 侧展 0.70）。之前每一版都是这么悄悄变回 A-pose 的，`switch_limbs_to_fk` 现在默认不再调用。

网格实际蒙皮在 `*arm_stretch` / `*forearm_twist` 上，它们跟的是 IK 链，所以手臂只有一条通路：挪 IK 的手部目标 `c_hand_ik.l/r`（用世界坐标算，不猜欧拉轴向）：

```bash
# 默认就会把手放下（--no-pose 可关）。数值是「向内收多少 / 向下移多少」
--arm-offset 0.12,0.24
```

0.24 会把手压得太贴身体（袖子挤进外套，实测手臂侧展 0.15）；0.12 让手臂离身体一点，手套和手指在画面里看得见（侧展 0.33~0.43）。

`anims=1`：这份 `.blend` 原本一条动作都没有，动画是脚本从开源 mocap 重定向出来再导出 NLA 的（见下一节）。配件网格 `chibang`、头发、光环用**骨骼父子**刚性跟随，否则头一动它们会留在原地（表现为光头 + 头顶飘着发饰）。

`fetch-model.mjs` 会校验 GLB 文件头、记 SHA-256 到 `src/data/model.json`；模型文件本身落在 `public/assets/model/`，不入库。上台时会归一化到 1.7 高、脚踩 `y=0`、水平居中，取景距离按高度算，所以模型原来多大、原点在哪都不用管；GLB 里带的第一条动画会自动播，拖动可转视角，点一下算「戳一下」。

three.js 是动态 import 的，没有模型文件时三件事一起省掉：那几百 KB 不下载、`ModelStage` 被摇树摇掉、连 chunk 都不会生成。所以 `npm run dev` 下放好模型刷新就行，部署 `dist` 的话得重新 `npm run build`（模型记录是构建期内联的）。加载失败或浏览器给不出 WebGL 时退回立绘，原因打在控制台。

模型出处：[模之屋 · 新约能天使 v2 版分享](https://www.aplaybox.com/details/model/62ZSh6wZ3Alg)（作者用 Blender 做的，身体 arp、面部 faceit、rigify 绑骨）。要按原作者的条款使用，别拿去商用或二次配布。

## 实时语音通话（WebRTC + Whisper + TTS）

工具栏那个电话按钮是一条完整的实时语音链路，跟参考项目同一个架构，服务端用 aiortc：

```
浏览器麦克风 ──Opus/WebRTC──▶ service/webrtc（python + aiortc）
                                   │  VAD 断句（20ms 帧能量；用户在说话时会打断她 = barge-in）
                                   │  Whisper 转写        ← 耳朵（本地 faster-whisper，不需要 key）
                                   │  Node 人格服务 /api/chat  ← 脑子（流式）
                                   │  edge-tts 或 SiliconFlow  ← 嘴（edge-tts 不需要 key）
浏览器播放 ◀──PCM 48k/WebRTC──────┘   转写与回复文本走 data channel
```

```bash
npm run voice:setup    # 建 service/webrtc/.venv 并装依赖（aiortc/faster-whisper/edge-tts）
npm run dev            # 前端 1002
npm run dev:api        # 人格服务 3002
npm run dev:webrtc     # 语音服务 8001（自动用 venv 里的 python）
```

**不需要任何 key 就是真识别、真合成。** 依次回落，`/health` 会如实报当前档位：

- 转写：`WHISPER_API_KEY` → Whisper API；否则本地 `faster-whisper`（默认 tiny，模型自动下载）；都没有才 stub
- 合成：`SILICONFLOW_API_KEY` → SiliconFlow（可用自定义音色）；否则 `edge-tts`；都没有才提示音

**验证方式是闭环的，不是「有个字符串回来了」。** 自检用 `edge-tts` 合成一句已知的话（`npm run voice:fixture`），通过 Chrome 的 `--use-file-for-fake-audio-capture` 把它当成麦克风输入，然后断言：

- 服务端 `frames_in` / `segments` / `transcripts` / `replies` / `tts_bytes` / `frames_out` 都是真数字
- **本地 Whisper 的转写与说的那句字符重合度 ≥ 0.6**（只差标点也算过）
- 浏览器侧远端音轨 `currentTime` 在走，转写与回复进了对话记录
- 挂断后状态清除

不经浏览器也能验：把素材按 20ms 帧直接喂进 pipeline，实测输出——

```
原文:        老板，今天有我的快递吗
Whisper 转写: 老板,今天有我的快递吗?
她回复:      老板，有急件！          ← 没配大模型时只引用官方台词库
tts_bytes:   12096（edge-tts 真合成）| 待播音频帧: 85
```

**为什么用 venv。** 系统里的 Python 3.9 上，CTranslate2（faster-whisper 的内核）一加载模型就 `0xC0000005` 崩掉（int8/float32 都一样，换了 OpenMP 相关的环境变量也没用）；换成 3.11 的独立 venv 后 1 秒内正常加载。所以语音服务固定跑在 `service/webrtc/.venv` 里。

**barge-in 已做。** 她还在说话时你一开口，服务端会清空待播音频队列（`interrupts` 计数器会加一），不用等她说完。

## 动作：接开源数据，不自己编

上一版的两段循环是我手写的正弦曲线，看得出「机器感」。现在台上这段 idle 来自 **CMU Graphics Lab Motion Capture Database**（subject 77 的站姿环顾片段，官方声明可用于任何用途），120fps 的 BVH 原采样：

```bash
node tools/fetch-motion.mjs      # 取动作源（CMU 77_01.bvh；另备 three.js 的 Soldier.glb）
"D:\Blender\4.2\blender.exe" -b "mod\新约阿能v2分享.blend" --python tools/blender-export-glb.py -- ^
  "_ref\exusiai.glb" --max-tex 512 --face-tex 4096 --alive --arm-offset 0.12,0.24 ^
  --mocap "_ref\motion\77_01.bvh" --mocap-window 3.5:7.5 --mocap-scale 0.22 ^
  --mocap-smooth 0.35 --mocap-loop 0.8 --mocap-arms-ik 0.25
node tools/fetch-model.mjs "_ref\exusiai.glb"
```

素材本身是 9.08 秒的**表演动作**（手臂 0.5 秒内甩 20~87°、头转 109°），不是 idle。所以脚本留了四个旋钮把它压成站姿该有的活气：取 3.5~7.5 秒这段、幅度 0.22、0.35 秒滑动平均、结尾 0.8 秒回归首帧。产出 96 帧 @ 24fps，正好 4 秒闭环。

映射表按骨架家族分开（`MAPS`，`detect_family` 认命名）：Mixamo 用 `mixamorig:` 前缀，CMU 用 `Hips / LowerBack / Spine / Spine1 / Neck / Neck1 / Head`。CMU 的颈是三节、ARP 只有两节，所以把 `Neck1 + Head` 的增量复合到 `c_head.x`，不丢动作。

量化对比——把导出的 GLB 重新导回 Blender，逐帧量（脚本 `tools/verify-clip.py`，96 帧全量）：

| | 上一版（Mixamo Soldier） | 现在（CMU 77_01） |
|---|---|---|
| 头水平朝向跨度 | 1.64° | **8.50°** |
| 头相对首帧总偏角 | 3.27° | **19.24°** |
| 累计漂移斜率 | 0.358°/秒 | 0.498°/秒（阈值 1） |
| 首末帧差（循环闭合） | 0.02° | **0.00°** |
| 单帧最大跳变 | 0.26° | 0.70° |
| 手臂侧展 `arm_stretch` | 0.70（A-pose，恒定） | 0.33~0.43（跟手部 IK 摆） |

「累计漂移斜率」就是当初「头一直自己转」那个 bug 的量化指标：出问题时约 **+8°/秒**，现在 0.5，且首末帧严格闭合。

五件踩出来的事：

**按时间采样，不能按帧数。** CMU 原数据是 120fps。第一版沿用固定 48 帧均分，等于把这 9 秒塞进 2 秒——播出来是 4 倍速的抽风。现在按文件头的 `Frame Time` 定帧率，按秒数换算输出帧数。顺带：`bpy.ops.import_anim.bvh` 没有 `fps` 参数，得先把场景帧率设成素材帧率再按帧号 1:1 导入。

**取旋转要跟通道无关。** BVH 导入的骨架是 **euler** 驱动的。我原来读 `rotation_quaternion`，拿到的是一条不随时间变化的常量，于是只有头不动、其他都对——直到把源骨全量打印出来才发现三个颈骨的角度「16.0~16.0」恒等。改成从「父级相对矩阵」取旋转，euler 与四元数驱动都吃得住。

**局部增量，不用世界旋转校正。** 两侧静止姿势不同时，`corr = R_target_rest · R_source_rest⁻¹` 这种世界校正在 BVH 上直接失效：BVH 的静止姿势不是规范的 T-pose，骨骼 roll 也是导入器按偏移算的，这个 `corr` 没有物理意义——实测把手臂映射成平举、甚至举过头顶。改成 `q_target = q_target_rest · (q_src_rest⁻¹ · q_src_frame)`，只搬运动作的**变化量**。同样的坑之前也踩过：对脊柱用世界校正会把上身拧成驼背。

**配件必须刚性跟随。** 头发和光圈原本是烘成静态几何的（它们的骨架静止姿势和作者摆的姿势不同），头一动就留在原地——表现为**光头 + 头顶飘着发饰**。先试过「补顶点组 + 骨架修改器」，结果头发被压成一个点（size 0.00）；改成**骨骼父子**（对象挂到 `head.x` / `c_spine_03.x`）才正确。

**头部跟随不能用累积旋转。** 头部跟随原来写的是 `bone.quaternion.multiply(增量)`——没人复位，每帧叠一点，实测**每秒多转 8°**，鼠标停在窗口右边时头会一直自己滚（-8° → -24° → -40° → … → -64°）。现在的写法是自适应：运行时探测这根骨有没有被片段驱动，被驱动就在 mixer 写好的姿态上叠增量，没被驱动就用「基准四元数 × 增量」的绝对量，两种情况都不会累积。片段现在自己会驱动头，所以走的是「叠加」那条。

手臂走的是另一条路：FK 在这里是死的（见上一节），只能把源素材**手腕相对肩的位置**按臂长比归一后落到 IK 手部目标 `c_hand_ik.l/r` 上，`--mocap-arms-ik 0.25` 是位移系数。实测手臂侧展 0.33~0.43、单帧最大 0.62°，是「跟着呼吸轻轻晃」的量级，不是挥手。

## 配色与构图

配色不是凭感觉调的，是从官方那张版式里**采样**出来的：纸白 `#EEEEEA`、墨黑 `#17181A`、她的红 `#B02A2A`、金 `#E8B94A`、青 `#12A7BD`（Laterano 水印色）。角色背后垫一块柔和的白色底板（贴纸白边），背景撒几行青色 `LATERANO` 水印。

舞台上她只露出**半身**（头顶到髋部）：助理该有的距离感，也避开全身像里呆板的腿和手。3D 用的是相机取景窗口（`bustTop/bustBottom` 按身高比例算），2D 立绘用 `overflow-hidden` 的窗口加 192% 放大的图钉在顶部。

翅膀和光环在模型里没有贴图（材质名 `chibang`，浅米色），在亮背景上会被冲成纯白，所以运行时给它上金。

**这里有一个只能靠测量发现的坑**：加完浅色主题后她整片发灰，肉眼以为是灯光过曝，反复调灯都没用。用脚本采样头发像素才看清——平均 `#F3EAEA`、饱和度 3.7%（参考值 53.9% 才对）。真因是那块白色底板：它是 `position: absolute`，而 `<canvas>` 是 `position: static`，**定位元素永远盖在非定位元素之上**，所以那层白是糊在她身上的。给宿主加 `isolate`、底板加 `-z-10` 之后，同一处头发变成 `#CC5C65` / 饱和度 54.9%。

## 对话之外

信赖度是唯一的进度尺，每说一句涨 3 点，上限 200。台词库按游戏里的解锁条件上锁：信赖 40/100/200 与精英阶段 1/2 都换算到这条尺子上，锁着的台词点不动。信赖到 120（精英阶段 2）时台上的立绘换成精二插画。

情绪标签由回复文本的用词算出来，驱动立绘的色调与名牌上的说明，不额外请求一次模型。对话记录和个人设置存在 localStorage，换机器就没了。

## 目录

```
src/App.tsx            对话流程：流入、打字机、播报、闲置主动说话、语音通话接入
src/components/        登录遮罩、2D 立绘舞台、3D 舞台、HUD、对话框、工具栏、三个抽屉面板
src/lib/               operator(档案与立绘地址) / trust(解锁) / emotion / audio / offlinePersona / api / rtc / store
src/data/voice-lines.json   38 条官方台词（tools/build-voice-data.mjs 生成）
src/data/model.json    3D 模型记录（file 为 null 表示用立绘）
service/server.mjs     OpenAI 兼容端点 → SSE，兼静态托管 dist 与 /rtc 反代
service/webrtc/        aiortc 语音服务：server.py（SDP/音轨）+ pipeline.py（VAD/编排）+ asr.py + tts.py
tools/fetch-assets.mjs 取立绘与配音并核对 SHA-256
tools/fetch-model.mjs  接本地 3D 模型（校验 + 记录）
tools/blender-export-glb.py  .blend → GLB：挑对象、压平 toon 材质、降采样贴图、摆站姿、mocap 重定向
tools/fetch-motion.mjs  取开源动作源（CMU BVH / Mixamo GLB）并记 SHA-256
tools/verify-clip.py    把导出的 GLB 导回 Blender，逐帧量动作幅度、漂移与循环闭合
tools/make-demo-model.mjs  自造占位 GLB，用来验证 3D 链路
tools/check.mjs        无头浏览器自检
tools/prts/            干员页与语音记录的原始 wikitext（数据从它解析出来的）
assets.manifest.json   素材来源地址与校验值（文件本身不入库）
```

## 自检

```bash
npm run check                                        # 测开发服务器
npm run check -- http://127.0.0.1:3002/              # 测构建产物
```

无头 Edge + CDP 真跑一遍，桌面 1360×900 与窄屏 390×780 各一遍，外加禁用脚本的一遍；语音那条链路另有一组不经浏览器的自检。全量 **136 项**（有模型、有本地 Whisper 时）。缺哪一块，对应那组会明确标成 PASS 并写明「跳过」的原因，总数随之减少。

它自己会起：一个强制离线的 `service/`（所以 `.env` 里有真 key 也不影响结果——语音那套反而**故意**跑真实的本地 Whisper + edge-tts，因为那才是要验证的东西）。

断言里比较关键的是这几条：立绘真的解码出像素（`naturalWidth > 0`），官方语音真的播过（`audio.played` 走到了非零秒），界面显示的台词与 `voice-lines.json` 逐字一致（中配日配各验一遍，并验音频文件真的换到了 `/voice/jp/`），锁定台词条数与信赖度算出来的期望值一致，GLB 真被解析（`data-height` 是从几何算的 1.89）且 WebGL 真的光栅化了三角形（`data-tris` 取自 `renderer.info.render.triangles`，是**渲染统计**：含阴影 pass、随视口裁剪浮动，实测 66.0~69.2 万；模型几何本身是 37.3 万），3D→2D→3D 来回切不留多余 canvas，两个视口都没有横向溢出，控制台没有未捕获异常。

导出**不是字节确定的**：这份 `.blend` 的翅膀骨有依赖环（日志里满屏 `Dependency cycle detected`），求值顺序一变，导出的 GLB 就不一样——同一份代码跑两遍，SHA-256 也不同，而逐帧姿态指标完全一致。所以回归要比指标，不能比哈希。

它验不了「动作好不好看」，也验不了循环会不会跳：`data-boneY` 只能证明骨骼在动，分不出「8.5° 的环顾」和「每秒转 8° 的自转」。那部分由 `tools/verify-clip.py` 逐帧量朝向（幅度 / 漂移斜率 / 首末帧差），数字在上面的动作那节。

## 素材与版权

立绘、语音、台词文本、干员档案数据著作权归上海鹰角网络科技有限公司所有，本项目仅作个人学习用途。仓库里只放地址和 SHA-256（`assets.manifest.json`），文件靠脚本现取现核对，不随代码分发；中配与日配都来自 PRTS 的官方资源目录。

动作数据来自 CMU Graphics Lab Motion Capture Database（官方声明可用于任何用途），只记地址与 SHA-256，BVH 文件不入库；重定向后烘进自己的 GLB，不再随附原文件。

3D 模型是模之屋上作者分享的同人作品，著作权归原作者；原始 `.blend`（301 MB）和导出的 GLB（22.86 MB）都不入库，`.gitignore` 已挡住 `mod/`、`*.blend`、`*.glb`。要用请看原发布页的条款。

换素材时 `node tools/fetch-assets.mjs --force`，校验值对不上会打警告。

## 已知限制

2D 舞台是静态立绘加呼吸和光影，没有 Live2D 或 Spine 骨架；游戏里也没有平面骨骼可以白拿。

3D 舞台只认 glTF（`.glb`，VRM 也行）。台上的动作来自**开源 mocap 重定向**（CMU 的躯干 + 颈 + 头，手部位移走 IK 目标），加上眨眼、眼球扫视、口型跟真实音量、情绪表情、头部跟随鼠标。

**手指已经有动作了，裙摆还是静态的。** `rig` 里有 38 根手指变形骨、48 根裙摆变形骨（`c_kilt_0X_0Y.l/r`），都在顶点组里、也都导进了 GLB（388 个节点里能查到）。CMU 那套骨架只有三个粗略手指骨，所以手指单独取另一份开源素材——three.js 的 `Soldier.glb`，它 Idle 里逐关节弯曲是真数据：食指 8°+16°、中指 17°+22°、无名指 34°+32°、小指 39°+40°、拇指 11°+1°，正是「放松的手」。

四个坑，都记下来省得重踩：

- **驱动哪根骨**：`c_*_rot` 那套控制骨既受约束覆盖（`c_index2_rot.l` 上挂着 COPY_ROTATION 且影响 1.0，打进去的关键帧当场被盖掉），又因为 `export_def_bones=True` 根本不会被导出。必须直接驱动**变形骨** `{指}1.{侧}` / `c_{指}2.{侧}` / `c_{指}3.{侧}`。
- **弯曲轴要量**：绕 `c_index1_rot.l` 的局部 Z 负向转 −20°，指尖位移 0.0208 里有 0.0198 沿掌法线朝掌心，绕 Y 几乎不动（扭转轴）。把它换算到每根骨自己的局部空间，之后每帧设**绝对** basis 旋转——逐帧叠加会累积，实测指尖甩出 118mm。
- **action 要显式挂**：glTF 导入会生成多个 action（`Idle_Character` / `Idle_<某骨>` / `Walk_Character` …），选中后不挂上去采样到的就是别的动作。另外 `retarget_mocap` 结束时会把手上的 action 卸下塞进静音 NLA 轨，写手指关键帧前必须临时挂回去，否则 keyframe 会新建一个空 action。
- **验收要验通道值，不要验几何代理**：我先用「指尖到指根的距离」当指标，结论是「没动」；实际解出 GLB 里的 basis 角发现完全正确（`pinky1.l` 39.1°、`c_pinky2.l` 39.7°、`ring1.l` 34.4°、`index1.l` 7.9°、`thumb1.l` 11.4°，与素材逐项吻合）——是那个几何代理不敏感（手指多关节弯曲时弦长缩得很少），把我骗了两轮。

裙摆还是静态：ARP 的 wiggle（布料二级动力学）靠 addon 的 handler，这份 `.blend` 里脚本被禁用了。要飘起来得放开脚本或自己写弹簧骨解算，不是「搬开源动作」能解决的。

**虹膜按官图校准过一轮。** 用 `tools/closeup.mjs` 拍 dpr=3 的脸部特写（整屏截图里眼睛只有几个像素，判断不了色偏），再和官图脸用同一套色相阈值量：

| | 深（最饱和） | 中调 | 平均饱和度 |
|---|---|---|---|
| 官图（立绘_1 脸部） | `#BE5000` | `#CC7A43` | 0.62 |
| 校准前 | `#A55421` | `#CC9F68` | 0.49 |
| 校准后 | `#A5531A` | `#C69360` | 0.51 |

做法是只动 `eyes` 那张 1024² 贴图上「琥珀色且饱和 ≥0.20」的像素（命中 29.7 万），按「离亮度拉开」的方式加饱和、轻微压明度；脸、眼白、高光贴图都不碰。贴图本身的中调从 `#AA794F` 变到 `#B87033`，是往官图方向走的。

剩下那截差距不在贴图饱和度上，而在**着色方式**：官图的虹膜是手绘渐变，3D 这边是平光 toon 加一块偏大的高光叠片。继续压只能靠重画虹膜贴图，那不属于「调材质」，所以停在这里。

实时通话那边：Whisper 与 SiliconFlow 没配 key 时是 stub（固定转写 + 提示音）。打断（barge-in）是做了的，`interrupts` 计数器会加一。

22.86 MB 的 GLB，首屏要等一两秒（本机测 2.2 秒到 ready），低端机或冷加载会更久。想更瘦可以 `--max-tex 256`，或给导出加 Draco 压缩（要配 DRACOLoader，没做）。

语音识别用浏览器的 Web Speech API，Chrome 与 Edge 可用，Firefox 不行，此时输入框照常打字。

没有 Electron 外壳，也没接「寻翼之歌」那套活动语音（`voice_cn/char_1041_angel2_iteration__6/`）。

自检脚本需要 Node 22 以上（用的是内置 WebSocket），跑页面的部分只需要 Node 20 以上。
