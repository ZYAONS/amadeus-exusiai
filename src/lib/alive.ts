/**
 * 「活人感」的运行时层。
 *
 * 模型自带的 24 个 ARKit 形态键 + 两段骨骼动作（idle / talk）在这里被驱动起来：
 *   呼吸与重心微移 → idle clip 循环
 *   说话           → crossfade 到 talk clip，同时口型跟着真实音量开合（WebAudio 分析器）
 *   眨眼 / 眼球扫视 → 形态键，随机节律
 *   情绪           → 形态键（笑 / 皱眉 / 眯眼）
 *   头部跟随       → 骨骼，跟着鼠标小幅转头
 */
import type { Emotion } from './emotion'

type ThreeAny = any

export type AliveState = { speaking: boolean; emotion: Emotion }

export type AliveStats = {
  clips: string[]
  morphTargets: number
  blinks: number
  jaw: number
  look: string
  headFollow: boolean
}

const EMOTION_MORPHS: Record<Emotion, Record<string, number>> = {
  neutral: {},
  joy: { mouthSmileLeft: 0.5, mouthSmileRight: 0.5, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },
  smile1: { mouthSmileLeft: 0.35, mouthSmileRight: 0.35 },
  smile2: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, cheekSquintLeft: 0.2, cheekSquintRight: 0.2 },
  shy: { mouthSmileLeft: 0.25, mouthSmileRight: 0.25, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, browInnerUp: 0.15 },
  anger: { browDownLeft: 0.55, browDownRight: 0.55, mouthFrownLeft: 0.25, mouthFrownRight: 0.25 },
  sadness: { mouthFrownLeft: 0.3, mouthFrownRight: 0.3, browInnerUp: 0.35 },
  unhappy: { mouthFrownLeft: 0.25, mouthFrownRight: 0.25, browDownLeft: 0.2, browDownRight: 0.2 },
}

export function createAliveRig(THREE: ThreeAny, model: ThreeAny, mixer: ThreeAny, clips: ThreeAny[]) {
  // ── 形态键网格
  let morphMesh: ThreeAny = null
  let dict: Record<string, number> = {}
  model.traverse((obj: ThreeAny) => {
    if (!morphMesh && obj.isMesh && obj.morphTargetDictionary && Object.keys(obj.morphTargetDictionary).length) {
      morphMesh = obj
      dict = obj.morphTargetDictionary
    }
  })
  const morphTargets = Object.keys(dict).length
  const current: Record<string, number> = {}
  const target: Record<string, number> = {}
  const setTarget = (name: string, value: number) => {
    if (name in dict) target[name] = value
  }

  // ── 骨骼动作：idle 常驻，说话时叠到 talk
  const actions: Record<string, ThreeAny> = {}
  for (const clip of clips) {
    const a = mixer.clipAction(clip)
    a.play()
    a.enabled = true
    actions[clip.name] = a
  }
  const idle = actions.idle ?? Object.values(actions)[0]
  const talk = actions.talk ?? null
  if (idle) idle.setEffectiveWeight(1)
  if (talk) talk.setEffectiveWeight(0)

  // ── 头部/颈部骨骼（跟随鼠标）
  const bones: Record<string, ThreeAny> = {}
  model.traverse((obj: ThreeAny) => {
    if (obj.isBone) {
      if (/^head/i.test(obj.name) && !bones.head) bones.head = obj
      if (/^neck/i.test(obj.name) && !bones.neck) bones.neck = obj
    }
  })
  const headFollow = Boolean(bones.head || bones.neck)
  const pointer = { x: 0, y: 0 }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', (e) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1
    })
  }
  const tmpQ = new THREE.Quaternion()
  const lookEuler = new THREE.Euler()

  // ── 口型：优先用真实音量，拿不到分析器就退回合成包络
  let analyser: AnalyserNode | null = null
  let audioData: Uint8Array<ArrayBuffer> | null = null
  const attachAudio = (el: HTMLAudioElement | null) => {
    if (!el || analyser) return
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const src = ctx.createMediaElementSource(el)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      analyser.connect(ctx.destination)
      audioData = new Uint8Array(analyser.fftSize)
      void ctx.resume().catch(() => {})
    } catch {
      analyser = null // 被 CORS 或自动播放策略挡住的元素，退回合成包络
    }
  }

  let blinks = 0
  let nextBlink = 1.5
  let blinkT = -1
  let nextSaccade = 1.2
  let lookX = 0
  let lookY = 0
  let lookTX = 0
  let lookTY = 0
  let time = 0

  const stats = (): AliveStats => ({
    clips: Object.keys(actions),
    morphTargets,
    blinks,
    jaw: Number((current.jawOpen ?? 0).toFixed(3)),
    look: `${lookX.toFixed(2)},${lookY.toFixed(2)}`,
    headFollow,
  })

  function update(dt: number, state: AliveState) {
    time += dt

    // idle ↔ talk 交叉淡入
    if (idle && talk) {
      const wantTalk = state.speaking ? 1 : 0
      const cur = talk.getEffectiveWeight()
      const next = cur + Math.sign(wantTalk - cur) * Math.min(Math.abs(wantTalk - cur), dt * 2.2)
      talk.setEffectiveWeight(next)
      idle.setEffectiveWeight(1 - next)
    }

    // 每帧重置「主动驱动」的形态键目标，再由各模块设置
    for (const k of Object.keys(target)) delete target[k]
    Object.assign(target, EMOTION_MORPHS[state.emotion] ?? {})

    // 眨眼
    if (blinkT >= 0) {
      blinkT += dt
      const dur = 0.13
      const p = blinkT / dur
      const v = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2)
      setTarget('eyeBlinkLeft', v)
      setTarget('eyeBlinkRight', v)
      if (p >= 1) {
        blinkT = -1
        blinks += 1
        nextBlink = time + 2.4 + Math.random() * 3.6
      }
    } else if (time >= nextBlink) {
      blinkT = 0
    }

    // 眼球扫视
    if (time >= nextSaccade) {
      nextSaccade = time + 1.2 + Math.random() * 2.4
      lookTX = (Math.random() * 2 - 1) * 0.8
      lookTY = (Math.random() * 2 - 1) * 0.5
    }
    lookX += (lookTX - lookX) * Math.min(1, dt * 9)
    lookY += (lookTY - lookY) * Math.min(1, dt * 9)
    if (lookX > 0) {
      setTarget('eyeLookOutLeft', lookX)
      setTarget('eyeLookInRight', lookX)
    } else {
      setTarget('eyeLookInLeft', -lookX)
      setTarget('eyeLookOutRight', -lookX)
    }
    if (lookY > 0) {
      setTarget('eyeLookDownLeft', lookY)
      setTarget('eyeLookDownRight', lookY)
    } else {
      setTarget('eyeLookUpLeft', -lookY)
      setTarget('eyeLookUpRight', -lookY)
    }

    // 口型
    if (state.speaking) {
      let amp: number
      if (analyser && audioData) {
        analyser.getByteTimeDomainData(audioData)
        let sum = 0
        for (let i = 0; i < audioData.length; i++) {
          const v = (audioData[i] - 128) / 128
          sum += v * v
        }
        amp = Math.min(1, Math.sqrt(sum / audioData.length) * 6)
      } else {
        // 没有分析器时的合成包络：至少别让嘴一直闭着
        amp = 0.15 + 0.35 * Math.abs(Math.sin(time * 8.3)) * (0.6 + 0.4 * Math.sin(time * 2.1))
      }
      setTarget('jawOpen', 0.12 + amp * 0.5)
      setTarget('mouthFunnel', amp * 0.15)
    } else {
      setTarget('jawOpen', 0)
    }

    // 形态键平滑逼近目标
    if (morphMesh) {
      const inf: number[] = morphMesh.morphTargetInfluences
      for (const [name, idx] of Object.entries(dict)) {
        const want = target[name] ?? 0
        const now = current[name] ?? 0
        const next = now + (want - now) * Math.min(1, dt * 12)
        current[name] = next
        inf[idx] = next
      }
    }

    // 头部跟随鼠标（在动画之后叠加，不然会被 clip 覆盖）
    const yaw = pointer.x * 0.16
    const pitch = pointer.y * 0.10
    for (const [name, bone] of Object.entries(bones)) {
      const scale = name === 'head' ? 1 : 0.45
      lookEuler.set(pitch * scale, yaw * scale * -1, 0, 'XYZ')
      tmpQ.setFromEuler(lookEuler)
      bone.quaternion.multiply(tmpQ)
    }
  }

  return { update, stats, attachAudio, hasMorph: morphTargets > 0 }
}
