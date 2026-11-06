// 把前端构建产物做成**单文件 exe**（Node SEA）。
//   node tools/build-exe.mjs [--skip-web-build]
//
// 只内联应用本体（index.html + assets/*.js|*.css，约 1MB）；官方立绘/语音/3D 模型
// 不内联（35MB，且是别人的版权素材），由用户放在 exe 同目录的 assets/ 下。
//
// 产物必须自证：脚本最后会**运行 exe 本身**做自检（--self-test），
// 并真的启动一次服务器抓首页，确认页面标记在。注入失败就当场失败，不产出可发布的东西。
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(root, 'dist')
const BUILD = join(root, 'build')
const WEB = join(BUILD, 'web')
const skipWebBuild = process.argv.includes('--skip-web-build')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// 页面标记：自检用它确认 index.html 真的被内联进来了
const MARKER = '<title>'

function log(msg) {
  console.log(msg)
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}

// ── 1. 前端产物
if (!existsSync(join(DIST, 'index.html'))) {
  if (skipWebBuild) throw new Error('dist/index.html 不存在，去掉 --skip-web-build 让我先构建')
  log('[1/6] 构建前端（npm run build）')
  run(process.platform === 'win32' ? 'cmd' : 'npm', process.platform === 'win32' ? ['/c', 'npm run build'] : ['run', 'build'])
} else {
  log('[1/6] 复用已有的 dist/')
}

// ── 2. 挑出「应用本体」：index.html + assets 下的 js/css，跳过图片/语音/模型
rmSync(WEB, { recursive: true, force: true })
mkdirSync(join(WEB, 'assets'), { recursive: true })
const files = []
copyFileSync(join(DIST, 'index.html'), join(WEB, 'index.html'))
files.push('index.html')
const distAssets = join(DIST, 'assets')
let skipped = 0
for (const name of readdirSync(distAssets)) {
  const ext = extname(name).toLowerCase()
  if (ext === '.js' || ext === '.css') {
    copyFileSync(join(distAssets, name), join(WEB, 'assets', name))
    files.push(`assets/${name}`)
  } else {
    skipped++
  }
}
const webBytes = files.reduce((n, f) => n + statSync(join(WEB, f)).size, 0)
log(`[2/6] 应用本体 ${files.length} 个文件 / ${(webBytes / 1024).toFixed(1)} KB；跳过素材 ${skipped} 个`)

// ── 3. 主线（CJS）+ 版本号/标记内联，放进 build/
const mainSrc = readFileSync(join(root, 'desktop', 'main.cjs'), 'utf8')
const mainStaged = mainSrc
  .replace('__VERSION__', pkg.version)
  .replace('__MARKER__', MARKER)
writeFileSync(join(BUILD, 'main.cjs'), mainStaged, 'utf8')
writeFileSync(
  join(WEB, 'manifest.json'),
  JSON.stringify({ version: pkg.version, files }, null, 2) + '\n',
  'utf8'
)
files.push('manifest.json')

// ── 4. SEA：生成 blob（assets 一起内联）
const assets = {}
for (const f of files) assets[f] = join(WEB, f)
const seaConfig = join(BUILD, 'sea-config.json')
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: join(BUILD, 'main.cjs'),
      output: join(BUILD, 'app.blob'),
      assets,
      disableExperimentalSEAWarning: true,
    },
    null,
    2
  ) + '\n',
  'utf8'
)
log('[3/6] 生成 SEA blob')
run(process.execPath, ['--experimental-sea-config', seaConfig])

// ── 5. 注入：复制运行时当外壳 + postject
const outName = process.platform === 'win32' ? 'amadeus-exusiai.exe' : 'amadeus-exusiai'
const outPath = join(BUILD, outName)
copyFileSync(process.execPath, outPath)
// ESM 里不能用 require.resolve（和顶层 await 混用会报 ERR_AMBIGUOUS_MODULE_SYNTAX）
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js')
if (!existsSync(postject)) throw new Error('没装 postject：npm i -D postject')
const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const args = [postject, outPath, 'NODE_SEA_BLOB', join(BUILD, 'app.blob'), '--sentinel-fuse', sentinel]
if (process.platform === 'darwin') {
  // macOS 必须有这一段，否则注入等于没做（表现为打印 Node 自己的版本号）
  args.push('--macho-segment-name', 'NODE_SEA')
}
log('[4/6] 注入 blob（postject）')
run(process.execPath, args)

// ── 6. 产物自证：跑 --self-test，再真启动一次服务器抓首页
log('[5/6] 产物自检 --self-test')
const selfOut = execFileSync(outPath, ['--self-test'], { encoding: 'utf8' })
process.stdout.write(selfOut)
if (!selfOut.startsWith(`amadeus-exusiai ${pkg.version}`)) {
  throw new Error(`自检第一行不是本程序版本号（很可能是注入失败、跑的是裸 node）：\n${selfOut}`)
}

log('[6/6] 真启动一次，抓首页')
const port = 17891
const child = spawn(outPath, ['--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
let started = false
child.stdout.on('data', (b) => {
  if (String(b).includes('已启动')) started = true
})
await new Promise((r) => setTimeout(r, 1500))
let pageOk = false
let html = ''
try {
  const res = await fetch(`http://127.0.0.1:${port}/`)
  html = await res.text()
  pageOk = res.status === 200 && html.includes(MARKER)
} catch (e) {
  console.error('抓首页失败：', e.message)
}
// 顺便验一下内联的 js 能取到、素材缺失时是 404 而不是崩
let jsOk = false
const jsName = files.find((f) => f.endsWith('.js'))
if (jsName) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/${jsName}`)
    jsOk = r.status === 200
  } catch {
    jsOk = false
  }
}
let apiOk = false
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/health`)
  const j = await r.json()
  apiOk = r.status === 200 && j.configured === false
} catch {
  apiOk = false
}
child.kill()

const sha = createHash('sha256').update(readFileSync(outPath)).digest('hex')
const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1)
log('')
log(`服务器启动: ${started ? 'PASS' : 'FAIL'}`)
log(`首页可访问且含页面标记: ${pageOk ? 'PASS' : 'FAIL'}`)
log(`内联 js 可取: ${jsOk ? 'PASS' : 'FAIL'}`)
log(`/api/health 回未配置（前端会退到离线人格）: ${apiOk ? 'PASS' : 'FAIL'}`)
log(`产物: ${outName} ${mb} MB`)
log(`SHA-256 ${sha}`)
if (!started || !pageOk || !jsOk || !apiOk) {
  throw new Error('产物自检有失败项，不发布')
}
log('全部自检通过。')
