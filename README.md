# AMADEUS // TERRA · 新约能天使

照着 [ai-poet/amadeus-system-new](https://github.com/ai-poet/amadeus-system-new) 的思路做的明日方舟版本：一个网页终端，能打字也能开口跟「新约能天使」说话，她会用官方语音回应（中配蔡书瑾、日配石見舞菜香，随时切），信赖涨到一定程度会换精二立绘。舞台默认是官方立绘，放一个 3D 模型进来就换成能转动的模型。

立绘、配音、台词、档案数据都是官方的；代码和界面是本项目写的。非官方同人作品。

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

结果：38 个网格、74.7 万三角形、18.54 MB。贴图分两档——身体衣物压到 512，脸和眼睛留 4096（观众只看这一块，其余可以压狠一点；1024/2048 那版是 25.25 MB）。

手臂也放下来了。这份模型是 Auto-Rig Pro 骨架，**FK 控制骨的权重是 0、IK 是 1**（试过：转 FK 控制骨，形变骨一动不动），所以只能挪 IK 的手部目标 `c_hand_ik.l/r`；挪法用世界坐标算，不猜欧拉轴向：

```bash
# 默认就会把手放下（--no-pose 可关）。数值是「向内收多少 / 向下移多少」
--arm-offset 0.24,0.24
```

`anims=0`：这份 `.blend` 里一条动作都没有。脚本留了 `--animate` 的路径（导出 skin + 呼吸关键帧，实测能出 4 段动画 / 30.13 MB），但配件网格 `chibang.002`（挂在「骨架」上，静止姿势和作者摆的姿势不一样）会变成头顶一团红色弧形，所以**没启用**。台上的她现在是静态站姿，靠运行时的呼吸起伏、微摆和轮廓光活着。

`fetch-model.mjs` 会校验 GLB 文件头、记 SHA-256 到 `src/data/model.json`；模型文件本身落在 `public/assets/model/`，不入库。上台时会归一化到 1.7 高、脚踩 `y=0`、水平居中，取景距离按高度算，所以模型原来多大、原点在哪都不用管；GLB 里带的第一条动画会自动播，拖动可转视角，点一下算「戳一下」。

three.js 是动态 import 的，没有模型文件时三件事一起省掉：那几百 KB 不下载、`ModelStage` 被摇树摇掉、连 chunk 都不会生成。所以 `npm run dev` 下放好模型刷新就行，部署 `dist` 的话得重新 `npm run build`（模型记录是构建期内联的）。加载失败或浏览器给不出 WebGL 时退回立绘，原因打在控制台。

模型出处：[模之屋 · 新约能天使 v2 版分享](https://www.aplaybox.com/details/model/62ZSh6wZ3Alg)（作者用 Blender 做的，身体 arp、面部 faceit、rigify 绑骨）。要按原作者的条款使用，别拿去商用或二次配布。

## 对话之外

信赖度是唯一的进度尺，每说一句涨 3 点，上限 200。台词库按游戏里的解锁条件上锁：信赖 40/100/200 与精英阶段 1/2 都换算到这条尺子上，锁着的台词点不动。信赖到 120（精英阶段 2）时台上的立绘换成精二插画。

情绪标签由回复文本的用词算出来，驱动立绘的色调与名牌上的说明，不额外请求一次模型。对话记录和个人设置存在 localStorage，换机器就没了。

## 目录

```
src/App.tsx            对话流程：流入、打字机、播报、闲置主动说话
src/components/        登录遮罩、2D 立绘舞台、3D 舞台、HUD、对话框、工具栏、三个抽屉面板
src/lib/               operator(档案与立绘地址) / trust(解锁) / emotion / audio / offlinePersona / api / store
src/data/voice-lines.json   38 条官方台词（tools/build-voice-data.mjs 生成）
src/data/model.json    3D 模型记录（file 为 null 表示用立绘）
service/server.mjs     OpenAI 兼容端点 → SSE，兼静态托管 dist
tools/fetch-assets.mjs 取立绘与配音并核对 SHA-256
tools/fetch-model.mjs  接本地 3D 模型（校验 + 记录）
tools/blender-export-glb.py  .blend → GLB：挑对象、压平 toon 材质、降采样贴图
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

无头 Edge + CDP 真跑一遍，桌面 1360×900 与窄屏 390×780 各一遍，外加禁用脚本的一遍。有模型文件时 103 项；没有模型时 3D 那组会明确标成 PASS 并写明「跳过」的原因，总数随之减少（移动端自动播放被拦时另会多出两条分支断言，数目不固定）。它自己会起一个强制离线的 `service/`，所以 `.env` 里有真 key 也不影响结果。

断言里比较关键的是这几条：立绘真的解码出像素（`naturalWidth > 0`），官方语音真的播过（`audio.played` 走到了非零秒），界面显示的台词与 `voice-lines.json` 逐字一致（中配日配各验一遍，并验音频文件真的换到了 `/voice/jp/`），锁定台词条数与信赖度算出来的期望值一致，GLB 真被解析（`data-height` 是从几何算的 1.86）且 WebGL 真光栅化了 74.7 万个三角形，3D→2D→3D 来回切不留多余 canvas，两个视口都没有横向溢出，控制台没有未捕获异常。

## 素材与版权

立绘、语音、台词文本、干员档案数据著作权归上海鹰角网络科技有限公司所有，本项目仅作个人学习用途。仓库里只放地址和 SHA-256（`assets.manifest.json`），文件靠脚本现取现核对，不随代码分发；中配与日配都来自 PRTS 的官方资源目录。

3D 模型是模之屋上作者分享的同人作品，著作权归原作者；原始 `.blend`（301 MB）和导出的 GLB（25 MB）都不入库，`.gitignore` 已挡住 `mod/`、`*.blend`、`*.glb`。要用请看原发布页的条款。

换素材时 `node tools/fetch-assets.mjs --force`，校验值对不上会打警告。

## 已知限制

2D 舞台是静态立绘加呼吸和光影，没有 Live2D 或 Spine 骨架；游戏里也没有平面骨骼可以白拿。

3D 舞台只认 glTF（`.glb`，VRM 也行）。台上是**静态站姿**：手臂已经从 A-pose 放下，但没有骨骼动画、没有表情 morph、不按口型开合——`--animate` 那条路还没解决配件骨架的静止姿势问题。运行时只有整体的呼吸起伏、微摆与轮廓光变化。

18.54 MB 的 GLB，首屏要等一两秒（本机测 2.2 秒到 ready），低端机或冷加载会更久。想更瘦可以 `--max-tex 256`，或给导出加 Draco 压缩（要配 DRACOLoader，没做）。

语音识别用浏览器的 Web Speech API，Chrome 与 Edge 可用，Firefox 不行，此时输入框照常打字。

没有 Electron 外壳，也没接「寻翼之歌」那套活动语音（`voice_cn/char_1041_angel2_iteration__6/`）。

自检脚本需要 Node 22 以上（用的是内置 WebSocket），跑页面的部分只需要 Node 20 以上。
