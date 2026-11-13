// 把 Pages 构建产物搬进 docs/（只搬应用本体：index.html + assets/*.js|*.css）。
// 素材（立绘/语音/模型）不搬也不入库：立绘与语音走 PRTS 远端，模型走素材仓库的 raw 地址。
//   node tools/stage-pages.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'build/pages'
const OUT = 'docs'

if (!existsSync(join(SRC, 'index.html'))) {
  throw new Error('先构建：npx vite build --base=/amadeus-exusiai/ --outDir build/pages')
}

// 清掉上一次搬进去的应用文件（保留 docs/github-workflows 这类手写内容）
rmSync(join(OUT, 'index.html'), { force: true })
rmSync(join(OUT, 'assets'), { recursive: true, force: true })
mkdirSync(join(OUT, 'assets'), { recursive: true })

let bytes = 0
let n = 0
copyFileSync(join(SRC, 'index.html'), join(OUT, 'index.html'))
bytes += statSync(join(OUT, 'index.html')).size
n++
for (const name of readdirSync(join(SRC, 'assets'))) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (ext !== '.js' && ext !== '.css') continue
  copyFileSync(join(SRC, 'assets', name), join(OUT, 'assets', name))
  bytes += statSync(join(OUT, 'assets', name)).size
  n++
}
console.log(`搬进 docs/: ${n} 个文件, ${(bytes / 1024).toFixed(1)} KB`)
