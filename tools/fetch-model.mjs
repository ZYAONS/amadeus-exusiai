// 把本地下载到的模型接进项目：校验 → 落位 → 记 SHA-256。
//   node tools/fetch-model.mjs D:\下载\新约能天使.glb
//   node tools/fetch-model.mjs D:\下载\model.vrm --name character.glb
// 只接受 web 能直接加载的 .glb / .gltf。.blend、.pmx、.zip 需要先在 Blender 里导出。
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'public/assets/model')

const args = process.argv.slice(2)
const nameFlag = args.indexOf('--name')
const outName = nameFlag >= 0 ? args[nameFlag + 1] : null
// 没有 --name 时 nameFlag 是 -1，别拿它 +1 去当跳过下标（踩过：路径被当成参数名吃掉）
const valueIdx = nameFlag >= 0 ? nameFlag + 1 : -1
const src = args.find((a, i) => !a.startsWith('--') && i !== valueIdx)

if (!src) {
  console.error('用法: node tools/fetch-model.mjs <模型文件.glb|.gltf> [--name 输出名.glb]')
  process.exit(2)
}

const ext = extname(src).toLowerCase()
if (!['.glb', '.gltf', '.vrm'].includes(ext)) {
  console.error(`这个格式（${ext}）浏览器加载不了。`)
  console.error('请在 Blender 里打开它，导出为 glTF 2.0（.glb，单文件），再拿导出的文件跑本脚本。')
  console.error('参考路径：Blender → File → Export → glTF 2.0 (.glb/.gltf) → Format: glTF Binary (.glb)')
  process.exit(2)
}

const buf = await readFile(src)

// 校验：GLB 看文件头，.gltf 看能不能解析出 asset.version
let height = null
if (ext === '.gltf') {
  const json = JSON.parse(buf.toString('utf8'))
  if (!json.asset?.version) throw new Error('.gltf 缺少 asset.version，不是 glTF 2.0 文件')
  height = null
} else {
  const magic = buf.readUInt32LE(0)
  const version = buf.readUInt32LE(4)
  const declared = buf.readUInt32LE(8)
  if (magic !== 0x46546c67) throw new Error('不是 GLB（魔数不是 glTF）')
  if (version !== 2) throw new Error(`GLB 版本是 ${version}，只支持 2`)
  if (declared !== buf.length) throw new Error(`GLB 头声明 ${declared} 字节，实际 ${buf.length} 字节，文件可能没下完整`)
  // 从 JSON chunk 里把所有 POSITION accessor 的 min/max 并起来，能估出模型总高度
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION]
      if (!acc?.min || !acc?.max) continue
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], acc.min[i])
        max[i] = Math.max(max[i], acc.max[i])
      }
    }
  }
  // 各网格的局部包围盒并集，没算节点变换，所以是「约」——只是给人看个量级
  if (Number.isFinite(min[1]) && Number.isFinite(max[1])) {
    height = Number((max[1] - min[1]).toFixed(3))
  }
}

const fileName = outName ?? (ext === '.gltf' ? 'character.gltf' : 'character.glb')
if (ext === '.gltf') {
  console.warn('! .gltf 是外挂 bin/贴图的多文件格式，本项目只会拷这一个文件；建议导出成 .glb')
}
await mkdir(OUT, { recursive: true })
const dest = join(OUT, fileName)
await copyFile(src, dest)

const manifest = {
  file: fileName,
  sha256: createHash('sha256').update(buf).digest('hex'),
  bytes: buf.length,
  source: basename(src),
  addedAt: new Date().toISOString(),
  note: '模型著作权归原作者所有，请遵守原发布页的使用条款；本仓库不收录模型文件。舞台上的归一化与取景都在运行时按实际包围盒算，所以这里不记尺寸。',
}
// 唯一记录在 src/data/model.json（会入库），模型文件本身在 public/assets/model/（不入库）
await writeFile(join(root, 'src/data/model.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const size = (await stat(dest)).size
console.log(`✓ ${basename(src)} -> public/assets/model/${fileName} (${(size / 1024 / 1024).toFixed(2)} MB)`)
console.log(`  SHA-256 ${manifest.sha256.slice(0, 16)}…（已写入 src/data/model.json）`)
console.log('  模型记录是构建期内联的：npm run dev 下刷新即可；dist 部署的话要重新 npm run build。')
