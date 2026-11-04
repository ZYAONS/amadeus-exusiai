// 生成一个占位 GLB（几个方盒子拼的人形），用来验证 3D 舞台这条链路真的能跑。
// 不依赖任何第三方素材：顶点数据在这个脚本里算出来，二进制自己写。
//   node tools/make-demo-model.mjs            写到 public/assets/model/
// 真人模型放进来之后，用 tools/fetch-model.mjs 换成真的。
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'public/assets/model')

/** 六个面：按「从外面看逆时针」排列，法线朝外 */
function box(cx, cy, cz, sx, sy, sz) {
  const [hx, hy, hz] = [sx / 2, sy / 2, sz / 2]
  const faces = [
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ]
  const pos = []
  const nrm = []
  const idx = []
  for (const f of faces) {
    const base = pos.length / 3
    for (const [x, y, z] of f.v) {
      pos.push(x + cx, y + cy, z + cz)
      nrm.push(...f.n)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return { pos, nrm, idx }
}

const parts = [
  box(0, 1.52, 0, 0.23, 0.26, 0.22), // 头
  box(0, 1.05, 0, 0.36, 0.66, 0.2), // 躯干
  box(0.26, 1.05, 0, 0.1, 0.5, 0.12), // 右臂
  box(-0.26, 1.05, 0, 0.1, 0.5, 0.12), // 左臂
  box(0.11, 0.36, 0, 0.14, 0.72, 0.16), // 右腿
  box(-0.11, 0.36, 0, 0.14, 0.72, 0.16), // 左腿
]

const pos = []
const nrm = []
const idx = []
for (const p of parts) {
  const offset = pos.length / 3
  pos.push(...p.pos)
  nrm.push(...p.nrm)
  for (const i of p.idx) idx.push(i + offset)
}

const min = [Infinity, Infinity, Infinity]
const max = [-Infinity, -Infinity, -Infinity]
for (let i = 0; i < pos.length; i += 3) {
  for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], pos[i + a])
    max[a] = Math.max(max[a], pos[i + a])
  }
}

const posBuf = Buffer.from(new Float32Array(pos).buffer)
const nrmBuf = Buffer.from(new Float32Array(nrm).buffer)
const idxBuf = Buffer.from(new Uint16Array(idx).buffer)
const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf)

const bin = Buffer.concat([pad4(posBuf), pad4(nrmBuf), pad4(idxBuf)])
const gltf = {
  asset: { version: '2.0', generator: 'amadeus-exusiai/tools/make-demo-model.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'PlaceholderOperator' }],
  meshes: [
    {
      name: 'PlaceholderOperator',
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 },
      ],
    },
  ],
  materials: [
    {
      name: 'CrimsonPlaceholder',
      pbrMetallicRoughness: { baseColorFactor: [0.62, 0.16, 0.18, 1], metallicFactor: 0, roughnessFactor: 0.65 },
    },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length + nrmBuf.length, byteLength: idxBuf.length, target: 34963 },
  ],
  buffers: [{ byteLength: bin.length }],
}

const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'))
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0) // 'glTF'
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8)
const jsonHeader = Buffer.alloc(8)
jsonHeader.writeUInt32LE(jsonBuf.length, 0)
jsonHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
const binHeader = Buffer.alloc(8)
binHeader.writeUInt32LE(bin.length, 0)
binHeader.writeUInt32LE(0x004e4942, 4) // 'BIN'
const glb = Buffer.concat([header, jsonHeader, jsonBuf, binHeader, bin])

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'demo-placeholder.glb'), glb)

const manifest = {
  file: 'demo-placeholder.glb',
  sha256: createHash('sha256').update(glb).digest('hex'),
  bytes: glb.length,
  height: Number((max[1] - min[1]).toFixed(3)),
  demo: true,
  source: 'tools/make-demo-model.mjs 生成的占位模型（不是真人模型，只用来验证 3D 链路）',
  note: '把真模型用 node tools/fetch-model.mjs 你的文件.glb 换掉，这条记录会被覆盖。',
}
await writeFile(join(root, 'src/data/model.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log(`占位模型 ${glb.length} 字节，包围盒高度 ${(max[1] - min[1]).toFixed(2)} -> public/assets/model/`)
console.log('已写入 src/data/model.json（demo: true），刷新页面看 3D 舞台')
