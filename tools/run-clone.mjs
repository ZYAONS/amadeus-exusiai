// 启动本地音色克隆服务（XTTS-v2 + 官方录音当参考音）。
//   node tools/run-clone.mjs            # 默认 8100
//   node tools/run-clone.mjs 8101
// 需要先准备好：python -m pip install（见 service/clone/README.md）与
// python tools/fetch-xtts.py、python tools/make-voice-ref.py
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = process.argv[2] ?? process.env.CLONE_TTS_PORT ?? '8100'

const PY = [
  join(root, 'service/clone/.venv/Scripts/python.exe'),
  join(root, 'service/clone/.venv/bin/python'),
].find((p) => existsSync(p))

if (!PY) {
  console.error('找不到 service/clone/.venv。先按 service/clone/README.md 建环境（要 torch）。')
  process.exit(2)
}
const model = join(root, 'service/clone/models/xtts_v2/model.pth')
if (!existsSync(model)) {
  console.error('模型缺失：先跑 python tools/fetch-xtts.py（约 1.8 GB，CPML 非商业许可）')
  process.exit(2)
}
const refZh = join(root, 'service/clone/ref/zh_reference.wav')
if (!existsSync(refZh)) {
  console.error('参考音缺失：先跑 python tools/make-voice-ref.py（用官方录音当参考）')
  process.exit(2)
}

console.log(`[clone] 启动：${PY} server.py --port ${port}`)
const child = spawn(PY, [join(root, 'service/clone/server.py'), '--port', port], {
  cwd: root,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
