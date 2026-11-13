import raw from '../data/voice-lines.json'

export type Unlock = { kind: 'elite' | 'trust' | 'other'; value: number } | null

export type VoiceLine = {
  no: number
  title: string
  trigger: string
  file: string
  zh: string
  jp: string
  en: string
  unlock: Unlock
}

export const VOICE = raw as unknown as {
  operatorId: string
  operator: string
  operatorEn: string
  voiceBase: { cn: string; jp: string }
  source: string
  copyright: string
  lines: VoiceLine[]
}

export const LINES = VOICE.lines

export const lineByNo = (no: number): VoiceLine | undefined => LINES.find((l) => l.no === no)

export type VoiceLang = 'zh' | 'jp'

export const VOICE_LANG_LABEL: Record<VoiceLang, string> = { zh: '中文配音', jp: '日语配音' }

/** 同一句台词的两种文本；日配取 `jp`，缺了就退回中文原文 */
export function lineText(line: VoiceLine, lang: VoiceLang): string {
  return (lang === 'jp' ? line.jp : line.zh) || line.zh
}

/** 官方档案（PRTS 干员页原字段，未改写） */
export const OPERATOR = {
  id: VOICE.operatorId,
  name: '新约能天使',
  nameEn: 'Exusiai the New Covenant',
  stars: 6,
  klass: '特种',
  branch: '怪杰',
  tags: ['输出', '支援'],
  race: '萨科塔',
  origin: '拉特兰',
  faction: '炎-龙门 · 企鹅物流',
  artist: '幻象黑兔',
  cv: '蔡书瑾',
  cvJp: '石见舞菜香',
  trait: '自身生命会不断流失',
  talent: '火力电台：在场时，每当有友方干员的弹药被消耗就会回复自身生命值，并有概率立即对该干员攻击范围的敌人召唤一次轰炸。',
  skills: ['使命必达！', '天空大扫除', '开火成瘾症'],
  /** 她在语音里对玩家的称呼 */
  address: '老板',
} as const

// 素材地址的顺序按「这个页面跑在哪」决定：
//   本机（dev / 单文件 exe）→ 本地文件优先，缺了再回源；
//   托管站（GitHub Pages 之类）→ 远端优先，因为本地那一份压根不在仓库里，
//   先试本地只会在控制台留一串 404（实测线上 6 条），纯噪声。
// 两张图都是官方立绘：E0/E1 是全身站姿（默认用这张，人物大、看得清），
// 精二那张是爆炸式插画，信赖到精英阶段 2 才换上——进度有视觉回报。
const REMOTE = 'https://media.prts.wiki'
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/
/** 这个页面是否跑在「素材就在旁边」的本机环境 */
export const hasLocalAssets =
  typeof location !== 'undefined' && LOCAL_HOSTS.test(location.hostname)

/** 本地与远端两个地址，按部署环境排序 */
function preferLocal(localPath: string, remoteUrl: string): string[] {
  return hasLocalAssets ? [localPath, remoteUrl] : [remoteUrl, localPath]
}

export const PORTRAIT_E1 = preferLocal(
  '/assets/立绘_1.png',
  `${REMOTE}/5/56/${encodeURIComponent('立绘_新约能天使_1.png')}`
)
export const PORTRAIT_E2 = [
  ...preferLocal(
    '/assets/立绘_2.png',
    `${REMOTE}/0/07/${encodeURIComponent('立绘_新约能天使_2.png')}`
  ),
  ...PORTRAIT_E1,
]

export function voiceCandidates(file: string, lang: VoiceLang): string[] {
  // voice_cn/ 是中文配音，voice/ 才是日配；文件名两边一样，只有目录不同
  const remote = lang === 'jp' ? VOICE.voiceBase.jp : VOICE.voiceBase.cn
  return preferLocal(`/assets/voice/${lang}/${file}`, `${remote}${file}`)
}

/** 台词分组：给「台词库」面板与闲置主动说话用 */
const byTrigger = (...triggers: string[]) => LINES.filter((l) => triggers.includes(l.trigger))
export const IDLE_POOL = byTrigger('HOME_SHOW', 'HOME_WAIT', 'HOME_PLACE')
export const TOUCH_POOL = byTrigger('BUILDING_TOUCHING', 'BUILDING_FAVOR_BUBBLE')
export const GREETING_POOL = byTrigger('GREETING', 'GACHA', 'HOME_PLACE')
