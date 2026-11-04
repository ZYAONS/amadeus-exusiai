// 启动 WebRTC 语音服务：优先用 service/webrtc/.venv 里的 python（本地 Whisper/edge-tts 在那边）
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'service/webrtc')
const venvPython = join(dir, '.venv/Scripts/python.exe')
const systemVenv = existsSync(venvPython) ? venvPython : join(dir, '.venv/bin/python')
const python = existsSync(systemVenv) ? systemVenv : (process.env.AMADEUS_PYTHON ?? 'python')
console.log(`[webrtc] 用 ${python} 启动`)
const child = spawn(python, ['server.py'], { cwd: dir, stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
