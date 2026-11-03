// 取回官方素材：立绘 2 张 + 中文配音 38 条。
// 素材不入库（著作权不是本项目的），仓库只存 地址 + SHA-256，脚本现取现核对。
//   node tools/fetch-assets.mjs           取缺失的
//   node tools/fetch-assets.mjs --force   全部重取
//   node tools/fetch-assets.mjs --check   只核对
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'public/assets')
const MANIFEST = join(root, 'assets.manifest.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const force = process.argv.includes('--force')
const checkOnly = process.argv.includes('--check')

const PORTRAITS = [
  ['立绘_1.png', `https://media.prts.wiki/5/56/${encodeURIComponent('立绘_新约能天使_1.png')}`],
  ['立绘_2.png', `https://media.prts.wiki/0/07/${encodeURIComponent('立绘_新约能天使_2.png')}`],
]

const voiceData = JSON.parse(await readFile(join(root, 'src/data/voice-lines.json'), 'utf8'))
const VOICES = voiceData.lines.map((l) => [
  `voice/${l.file}`,
  `${voiceData.voiceBase.cn}${l.file}`,
  `${voiceData.voiceBase.jp}${l.file}`,
])

const TARGETS = [...PORTRAITS.map(([name, url]) => [name, url, url]), ...VOICES]
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

const loadManifest = async () => {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'))
  } catch {
    return { operator: voiceData.operator, operatorId: voiceData.operatorId, files: {} }
  }
}

async function get(urls) {
  const list = Array.isArray(urls) ? urls : [urls]
  let lastErr
  for (const url of list) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://prts.wiki/' } })
        if (!res.ok) throw new Error(`${res.status} ${url}`)
        return { buf: Buffer.from(await res.arrayBuffer()), url }
      } catch (e) {
        lastErr = e
      }
    }
  }
  throw lastErr
}

const manifest = await loadManifest()
let fetched = 0
let skipped = 0
let bad = 0

for (const [rel, ...urls] of TARGETS) {
  const dest = join(OUT, rel)
  const recorded = manifest.files[rel]?.sha256

  if (existsSync(dest) && !force) {
    const got = sha(await readFile(dest))
    if (recorded && recorded !== got) {
      console.warn(`✗ ${rel} 本地文件与清单校验值不符，删掉后重取（或 --force）`)
      bad++
    } else {
      if (!recorded) manifest.files[rel] = { source: urls[0], sha256: got, bytes: (await readFile(dest)).length }
      skipped++
    }
    continue
  }

  if (checkOnly) {
    console.log(`… ${rel} 缺失`)
    bad++
    continue
  }

  try {
    const { buf, url } = await get(urls)
    const got = sha(buf)
    if (recorded && recorded !== got) {
      console.warn(`! ${rel} 上游内容变了（${recorded.slice(0, 12)} → ${got.slice(0, 12)}），已按新内容记录`)
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    manifest.files[rel] = { source: url, sha256: got, bytes: buf.length }
    fetched++
    process.stdout.write(`✓ ${rel} ${(buf.length / 1024).toFixed(0)}KB\n`)
  } catch (e) {
    console.error(`✗ ${rel} 取不到：${e.message}`)
    bad++
  }
}

manifest.note = '素材著作权归上海鹰角网络科技有限公司所有；本清单只记录来源地址与校验值，文件本身不入库。'
manifest.fetchedAt = new Date().toISOString()
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log(`\n新取 ${fetched} 个，已有 ${skipped} 个，失败 ${bad} 个 -> ${OUT}`)
if (bad) process.exitCode = 1
