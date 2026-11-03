import { LINES, type VoiceLine } from './operator'
import { TRUST_MAX, unlockedLines } from './trust'

// 没有大模型时的应答：只引用官方台词库（原文一字不改），外加少量系统模板。
// 不编造她说的话——编的台词比配错色糟得多，颜色没人拿去对照出处，台词每个读者都会。
export type OfflineReply = { text: string; line?: VoiceLine; template?: boolean }

const RULES: { re: RegExp; nos: number[] }[] = [
  { re: /(你好|您好|在吗|早上好|晚上好|嗨|hi|hello|老板在)/i, nos: [42, 1, 11] },
  { re: /(苹果|吃|饿|派|甜|零食)/, nos: [36, 28, 9] },
  { re: /(作战|战斗|上班|任务|出发|打工|值班)/, nos: [19, 20, 17, 18] },
  { re: /(光环|灯|照明|亮|黑|夜)/, nos: [19, 8] },
  { re: /(姐姐|老姐|家人|妹妹|蕾缪安)/, nos: [2] },
  { re: /(拉特兰|主|萨科塔|天使|律法|信仰)/, nos: [6, 8] },
  { re: /(生日|蛋糕|庆生)/, nos: [43] },
  { re: /(朋友|派对|一起|同伴|孤单|寂寞)/, nos: [3, 44] },
  { re: /(冰淇淋|新口味|甜品)/, nos: [4] },
  { re: /(快递|包裹|物流|送货|签收|胶带)/, nos: [1, 33, 11] },
  { re: /(累|休息|睡|闲|摸鱼)/, nos: [10, 9] },
  { re: /(厉害|帅|强|夸|喜欢)/, nos: [12, 13, 21] },
  { re: /(再见|拜拜|走了|下班)/, nos: [31, 32, 30] },
]

const TEMPLATES: ((name: string, trust: number) => string)[] = [
  (name) =>
    `（本地人格模式）${name}，这条我答不上来——现在我手里只有官方语音库那几句原话。给我接上大模型，我就能好好跟你聊了。`,
  (name, trust) =>
    `（本地人格模式）${name}，剧情、设定之类的问题我先跳过。顺便说一句，信赖已经到 ${trust}% 了，解锁的台词刚好可以翻着听。`,
]

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

export function offlineReply(input: string, name: string, trust: number, recentNos: number[]): OfflineReply {
  const pool = unlockedLines(LINES, Math.min(trust, TRUST_MAX))
  const rule = RULES.find((r) => r.re.test(input))
  if (rule) {
    const hit = rule.nos
      .map((no) => pool.find((l) => l.no === no))
      .filter((l): l is VoiceLine => Boolean(l))
      .find((l) => !recentNos.includes(l.no))
    if (hit) return { text: hit.zh, line: hit }
  }
  // 兜底：从解锁的交谈类台词里挑一句没刚说过的
  const chatty = pool.filter((l) => /HOME_SHOW|HOME_PLACE/.test(l.trigger) && !recentNos.includes(l.no))
  if (chatty.length) {
    const line = pick(chatty)
    return { text: line.zh, line }
  }
  return { text: pick(TEMPLATES)(name, trust), template: true }
}
