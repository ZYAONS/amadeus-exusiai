import type { VoiceLine } from './operator'

/** 一次对话让信赖涨多少；上限 200，与游戏内「信赖至 200%」对齐 */
export const TRUST_PER_TURN = 3
export const TRUST_MAX = 200

/** 单一进度尺：精英阶段换算成信赖门槛，避免两套进度互相打架 */
export function trustNeed(unlock: VoiceLine['unlock']): number {
  if (!unlock) return 0
  if (unlock.kind === 'trust') return unlock.value
  if (unlock.kind === 'elite') return unlock.value === 1 ? 60 : 120
  return 0
}

export function isUnlocked(line: VoiceLine, trust: number): boolean {
  return trust >= trustNeed(line.unlock)
}

export function unlockedLines(lines: VoiceLine[], trust: number): VoiceLine[] {
  return lines.filter((l) => isUnlocked(l, trust))
}

/** 阶段名，给 UI 显示 */
export function rankOf(trust: number): string {
  if (trust >= 200) return '信赖 200%'
  if (trust >= 120) return '精英阶段 2'
  if (trust >= 100) return '信赖 100%'
  if (trust >= 60) return '精英阶段 1'
  if (trust >= 40) return '信赖 40%'
  return '未建立信赖'
}

export const lockLabel = (line: VoiceLine): string => {
  if (!line.unlock) return '默认解锁'
  if (line.unlock.kind === 'trust') return `信赖 ${line.unlock.value}%`
  if (line.unlock.kind === 'elite') return `精英阶段 ${line.unlock.value}`
  return '特殊条件'
}
