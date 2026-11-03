# AMADEUS // TERRA · 新约能天使

照着 [ai-poet/amadeus-system-new](https://github.com/ai-poet/amadeus-system-new) 的思路做的明日方舟版本：一个网页终端，能打字也能开口跟「新约能天使」说话，她会用官方语音回应（中配蔡书瑾、日配石見舞菜香，随时切），信赖涨到一定程度会换精二立绘。

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

## 对话之外

信赖度是唯一的进度尺，每说一句涨 3 点，上限 200。台词库按游戏里的解锁条件上锁：信赖 40/100/200 与精英阶段 1/2 都换算到这条尺子上，锁着的台词点不动。信赖到 120（精英阶段 2）时台上的立绘换成精二插画。

情绪标签由回复文本的用词算出来，驱动立绘的色调与名牌上的说明，不额外请求一次模型。对话记录和个人设置存在 localStorage，换机器就没了。

## 目录

```
src/App.tsx            对话流程：流入、打字机、播报、闲置主动说话
src/components/        登录遮罩、舞台、对话框、工具栏、三个抽屉面板
src/lib/               operator(档案与立绘地址) / trust(解锁) / emotion / audio / offlinePersona / api / store
src/data/voice-lines.json   38 条官方台词（tools/build-voice-data.mjs 生成）
service/server.mjs     OpenAI 兼容端点 → SSE，兼静态托管 dist
tools/fetch-assets.mjs 取素材并核对 SHA-256
tools/check.mjs        无头浏览器自检
tools/prts/            干员页与语音记录的原始 wikitext（数据从它解析出来的）
assets.manifest.json   素材来源地址与校验值（文件本身不入库）
```

## 自检

```bash
npm run check                                        # 测开发服务器
npm run check -- http://127.0.0.1:3002/              # 测构建产物
```

无头 Edge + CDP 真跑一遍，桌面 1360×900 与窄屏 390×780 各一遍，外加禁用脚本的一遍，合计 80 多项断言（移动端自动播放被拦时会多出两条分支断言，数目不固定）。它自己会起一个强制离线的 `service/`，所以 `.env` 里有真 key 也不影响结果。

断言里比较关键的是这几条：立绘真的解码出像素（`naturalWidth > 0`），官方语音真的播过（`audio.played` 走到了非零秒），界面显示的台词与 `voice-lines.json` 逐字一致（中配日配各验一遍，并验音频文件真的换到了 `/voice/jp/`），锁定台词条数与信赖度算出来的期望值一致，两个视口都没有横向溢出，控制台没有未捕获异常。

## 素材与版权

立绘、语音、台词文本、干员档案数据著作权归上海鹰角网络科技有限公司所有，本项目仅作个人学习用途。仓库里只放地址和 SHA-256（`assets.manifest.json`），文件靠脚本现取现核对，不随代码分发；中配与日配都来自 PRTS 的官方资源目录。

换素材时 `node tools/fetch-assets.mjs --force`，校验值对不上会打警告。

## 已知限制

台面上是静态立绘加呼吸和光影，没有 Live2D 或 Spine 骨架；游戏里也没有平面骨骼可以白拿。

语音识别用浏览器的 Web Speech API，Chrome 与 Edge 可用，Firefox 不行，此时输入框照常打字。

没有 Electron 外壳，也没接「寻翼之歌」那套活动语音（`voice_cn/char_1041_angel2_iteration__6/`）。

自检脚本需要 Node 22 以上（用的是内置 WebSocket），跑页面的部分只需要 Node 20 以上。
