// 把 PRTS 语音记录 wikitext 解析成 src/data/voice-lines.json
// 输入是 tools/prts/语音记录.wikitext（由 fetch-assets.mjs 或手工下载）
// 台词文本保留官方原话，一字不改；只做结构化。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, 'prts/语音记录.wikitext')
const out = resolve(here, '../src/data/voice-lines.json')

const raw = readFileSync(src, 'utf8')
const CHAR_ID = (raw.match(/\|语音key=([\w]+)/) || [])[1]
if (!CHAR_ID) throw new Error('找不到 |语音key=，wikitext 结构变了')

// |标题N=… / |台词N={{VoiceData/word|中文|…}}… / |语音N=CN_00X.wav / |触发类型N=… / |条件N=…
const field = (n, key) => {
  const m = raw.match(new RegExp(`\\|${key}${n}=([^\\n]*)`))
  return m ? m[1].trim() : ''
}
const lang = (block, name) => {
  // {{VoiceData/word|中文|文本}} —— 文本里可能含 <i>…</i> 与 }}} 之外的括号，故按语言名定位后取到下一个 }} 为止
  const m = block.match(new RegExp(`\\{\\{VoiceData/word\\|${name}\\|([\\s\\S]*?)\\}\\}(?=\\{\\{VoiceData/word|$)`))
  return m ? m[1].replace(/<\/?i>/g, '').trim() : ''
}

const unlock = (cond) => {
  if (!cond) return null
  if (/精英阶段\s*1/.test(cond)) return { kind: 'elite', value: 1 }
  if (/精英阶段\s*2/.test(cond)) return { kind: 'elite', value: 2 }
  const trust = cond.match(/信赖至\s*(\d+)%/)
  if (trust) return { kind: 'trust', value: Number(trust[1]) }
  return { kind: 'other', value: 0, raw: cond }
}

const nos = [...new Set([...raw.matchAll(/\|标题(\d+)=/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
const lines = nos.map((n) => {
  const block = field(n, '台词')
  const file = field(n, '语音').toLowerCase() // 坑1：URL 里的文件名必须小写
  return {
    no: n,
    title: field(n, '标题'),
    trigger: field(n, '触发类型'),
    file: file.endsWith('.wav') ? file.replace(/\.wav$/, '.mp3') : file,
    zh: lang(block, '中文'),
    jp: lang(block, '日文'),
    en: lang(block, '英文'),
    unlock: unlock(field(n, '条件')),
  }
})

const data = {
  operatorId: CHAR_ID,
  operator: '新约能天使',
  operatorEn: 'Exusiai the New Covenant',
  // 官方语音的日配在 voice/，中文配音在 voice_cn/（坑2）；两条都记下来
  voiceBase: {
    cn: `https://torappu.prts.wiki/assets/audio/voice_cn/${CHAR_ID}/`,
    jp: `https://torappu.prts.wiki/assets/audio/voice/${CHAR_ID}/`,
  },
  source: 'https://prts.wiki/w/新约能天使/语音记录',
  copyright: '台词文本与语音著作权归上海鹰角网络科技有限公司所有，本仓库仅作个人学习用途引用。',
  lines,
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8')

const missing = lines.filter((l) => !l.zh || !l.file)
console.log(`解析 ${lines.length} 条语音 -> ${out}`)
console.log(`编号: ${lines.map((l) => l.no).join(',')}`)
if (missing.length) console.log(`注意，缺字段: ${missing.map((l) => l.no).join(',')}`)
