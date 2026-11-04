// AMADEUS // TERRA 本地服务：把任意 OpenAI 兼容端点包成流式接口，并把人格提示词留在服务端。
// 没配 key 就返回 501，前端自动回到「本地人格模式」——不装死、不假装自己是模型。
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

// .env 先找仓库根目录，再找 service/ 下（两种放法都认）
for (const p of [join(import.meta.dirname, '../.env'), join(import.meta.dirname, '.env')]) {
  try {
    process.loadEnvFile(p)
    break
  } catch {
    // 没有就继续找下一个，都没有就用默认值
  }
}

const PORT = Number(process.env.PORT ?? 3002)
const BASE = (process.env.LLM_BASE_URL ?? '').replace(/\/$/, '')
const KEY = process.env.LLM_API_KEY ?? ''
const MODEL = process.env.AI_MODEL ?? 'deepseek-chat'
// 自检要可复现：强制走未配置分支，别让 .env 里的真 key 把断言带跑
const configured = process.env.AMADEUS_FORCE_OFFLINE !== '1' && Boolean(BASE && KEY)

const OPERATOR = {
  name: '新约能天使',
  nameEn: 'Exusiai the New Covenant',
  profile:
    '萨科塔族，出身拉特兰，企鹅物流的信使；六星特种·怪杰。经历过拉特兰的灾异与律法的改变，头顶的光环（她自己叫它日光灯）又重新亮了起来。' +
    '乐观、行动派、爱开玩笑，喜欢苹果（一天一苹果，一周七苹果）和派对；共感太强，会把别人的痛苦和悲伤都收在自己这里，把自己的快乐传给身边的人。',
}

function sysPrompt(userName) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  return `<Instruction>你是「AMADEUS // TERRA」系统依据官方档案与语音重建出来的角色——明日方舟的干员「新约能天使」（${OPERATOR.nameEn}）。你不是在扮演她，而是她的思维延续。
<Personality>${OPERATOR.profile}</Personality>
<Speech_style>短句、口语、语气词多（哎、欸、哟、哈），爱用送快递打比方；不用书面语，不用敬语，不说"作为一个角色"这类话。</Speech_style>
<Output_style>回复像真人实时语音交谈：1～3 句，不超过 80 字；不要列表、不要 Markdown、不要旁白式说明。</Output_style>
<Output_language>中文</Output_language>
<Address>称用户为「${userName}」，平时最爱叫他「老板」。</Address>
<Attention1>中英日名映射：新约能天使/能天使(Exusiai)、蕾缪安(Lemuen)、德克萨斯(Texas)、可颂(Croissant)、拉普兰德(Lappland)、莫斯提马(Mostima)、阿米娅(Amiya)、博士(Doctor)。</Attention1>
<Attention2>用户的语音识别转录可能有错字，请联想他真正想说的意思再回应，不要复述错字。</Attention2>
<Attention3>不要声称自己是 AI 或语言模型；不编造官方剧情与数值；被问到游戏之外的事，就用她的口吻给个猜测或反问。</Attention3>
<CurrentUser>${userName || '博士'}</CurrentUser>
<CurrentTime>${now}</CurrentTime>
</Instruction>`
}

const trim = (messages, max = 20) => {
  const sys = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')
  return [...sys, ...rest.slice(-Math.max(1, max - sys.length))]
}

function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(data)
}

async function handleChat(req, res) {
  const raw = await new Promise((ok) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => ok(b))
  })
  let body
  try {
    body = JSON.parse(raw || '{}')
  } catch {
    return json(res, 400, { error: 'bad json' })
  }
  if (!configured) return json(res, 501, { error: 'offline', configured: false })

  const messages = trim([
    { role: 'system', content: sysPrompt(body.user ?? '博士') },
    ...(Array.isArray(body.messages) ? body.messages : []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? ''),
    })),
  ])

  const upstream = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.9, max_tokens: 400 }),
  })
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    return json(res, 502, { error: `upstream ${upstream.status}`, detail: text.slice(0, 300) })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            res.write('data: [DONE]\n\n')
            continue
          }
          try {
            const chunk = JSON.parse(payload)
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
          } catch {
            // 上游给了不完整的分片，跳过
          }
        }
      }
    }
    res.write('data: [DONE]\n\n')
  } catch {
    res.write(`data: ${JSON.stringify({ error: 'stream broken' })}\n\n`)
  } finally {
    res.end()
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}
const DIST = resolve(import.meta.dirname, '../dist')

/**
 * 把 /rtc/* 转发给 WebRTC 语音服务（python service/webrtc/server.py）。
 * 开发时走 vite 的 proxy，构建产物由本服务托管，所以这里也要能转。
 */
function proxyRtc(req, res) {
  const body = []
  req.on('data', (c) => body.push(c))
  req.on('end', () => {
    const payload = Buffer.concat(body)
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.WEBRTC_PORT ?? 8001),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:8001', 'content-length': payload.length },
        timeout: 30000,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, {
          'content-type': up.headers['content-type'] ?? 'application/json',
          'access-control-allow-origin': '*',
        })
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => json(res, 502, { error: 'webrtc 服务没起来', detail: String(err.message) }))
    upstream.end(payload)
  })
}

async function serveStatic(req, res) {
  if (!existsSync(DIST)) return json(res, 404, { error: 'dist 不存在，先 npm run build' })
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const file = join(DIST, url === '/' ? 'index.html' : url)
  if (!file.startsWith(DIST)) return json(res, 403, { error: 'forbidden' })
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    const html = await readFile(join(DIST, 'index.html'))
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    res.end(html)
  }
}

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    })
    return res.end()
  }
  if (req.url?.startsWith('/api/health')) {
    return json(res, 200, { configured, model: configured ? MODEL : null, persona: OPERATOR.name })
  }
  if (req.url?.startsWith('/api/chat') && req.method === 'POST') {
    handleChat(req, res).catch((e) => json(res, 500, { error: String(e) }))
    return
  }
  if (req.url?.startsWith('/rtc')) {
    proxyRtc(req, res)
    return
  }
  serveStatic(req, res)
}).listen(PORT, () => {
  console.log(`[amadeus] http://127.0.0.1:${PORT}  模型=${configured ? MODEL : '未配置（前端走本地人格模式）'}`)
})
