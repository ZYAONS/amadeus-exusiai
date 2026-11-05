// 取开源动作源（用于 rearget 到本模型骨架），只记地址与 SHA-256，文件不入库。
//   node tools/fetch-motion.mjs
// 默认取 three.js 仓库里那份 Soldiers 的 Idle（Mixamo 骨架，含手指骨）。
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '_ref/motion')
const MANIFEST = join(root, 'assets.manifest.json')

const SOURCES = [
  {
    file: 'Soldier.glb',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb',
    note: 'three.js 示例资源；骨架是 Mixamo 命名（含手指骨），动作有 Idle/Run/Walk/TPose。只当动作源用，不随仓库分发。',
  },
  {
    file: '77_01.bvh',
    url: 'https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data/077/77_01.bvh',
    note:
      'CMU Graphics Lab Motion Capture Database（subject 77，站姿环顾/手势）。' +
      '官方声明可自由用于任何用途；这里是 BVH 转码副本，髋部/腿部在此项目里不参与重定向。' +
      '120fps 原始采样，导入时按文件头的 Frame Time 定帧率，避免被压成快放。',
  },
]

await mkdir(OUT, { recursive: true })
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8').catch(() => '{}'))
manifest.motion = manifest.motion ?? {}

for (const src of SOURCES) {
  const dest = join(OUT, src.file)
  try {
    const res = await fetch(src.url, { headers: { 'User-Agent': 'amadeus-exusiai/motion-fetch' } })
    if (!res.ok) throw new Error(`${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buf)
    manifest.motion[src.file] = {
      url: src.url,
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
      note: src.note,
    }
    console.log(`✓ ${src.file} ${(buf.length / 1024 / 1024).toFixed(2)}MB`)
  } catch (err) {
    console.error(`✗ ${src.file}: ${err.message}`)
  }
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('已写入 assets.manifest.json 的 motion 段')
