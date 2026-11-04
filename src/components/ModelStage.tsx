import { useEffect, useRef, useState } from 'react'
import { createAliveRig } from '../lib/alive'
import type { Emotion } from '../lib/emotion'

type Props = {
  url: string
  emotion: Emotion
  speaking: boolean
  onTap: () => void
  /** 模型加载失败或浏览器没有 WebGL：交回 2D 立绘，别留一块黑 */
  onFail: (reason: string) => void
}

/** 情绪 → 轮廓光颜色与强度（浅色主题下要克制，暗红硬光会让模型显假） */
const RIM: Record<Emotion, [number, number]> = {
  neutral: [0xffffff, 0.55],
  joy: [0xffe9b8, 0.7],
  smile1: [0xfff2d8, 0.6],
  smile2: [0xffe4b0, 0.62],
  shy: [0xffd6dd, 0.6],
  anger: [0xd8645e, 0.8],
  sadness: [0xb9c8e0, 0.45],
  unhappy: [0xc9c2dd, 0.5],
}

/**
 * 3D 舞台：加载 GLB（VRM 也是 GLB，GLTFLoader 能吃）。
 * three 是动态 import 的——没有模型时这段代码根本不会下载。
 */
export default function ModelStage({ url, emotion, speaking, onTap, onFail }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [meta, setMeta] = useState({ height: 0, anims: 0 })
  const live = useRef({ emotion, speaking })
  live.current = { emotion, speaking }
  const tap = useRef(onTap)
  tap.current = onTap
  const fail = useRef(onFail)
  fail.current = onFail

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let raf = 0
    let teardown: (() => void) | undefined

    void (async () => {
      try {
        const THREE = await import('three')
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
        if (disposed) return

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5))
        renderer.setSize(host.clientWidth || 1, host.clientHeight || 1)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        // 中性色调映射：高光滚降但不像 ACES 那样把红色压灰（她的头发最怕这个）
        const ToneMap = (THREE as unknown as { NeutralToneMapping?: number }).NeutralToneMapping
        if (ToneMap !== undefined) {
          renderer.toneMapping = ToneMap as unknown as typeof renderer.toneMapping
          renderer.toneMappingExposure = 1.05
        }
        renderer.domElement.setAttribute('aria-label', '3D 人物模型')
        host.appendChild(renderer.domElement)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(30, (host.clientWidth || 1) / (host.clientHeight || 1), 0.05, 100)
        // 平光为主：暗环境 + 硬轮廓光会把风格化模型照出「伪人感」；
        // 但强度不能再叠了——几盏灯相加很容易过曝（实测 6.0 的总强度把她照成一片白）
        scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d5cf, 1.15))
        const key = new THREE.DirectionalLight(0xffffff, 2.1)
        key.position.set(1.6, 3.2, 2.8)
        scene.add(key)
        const fill = new THREE.DirectionalLight(0xffffff, 0.62)
        fill.position.set(-2.0, 1.2, 2.2)
        scene.add(fill)
        const rim = new THREE.DirectionalLight(0xffffff, 0.45)
        rim.position.set(-1.2, 1.8, -2.6)
        scene.add(rim)
        // 面部补光：从正前方偏上打一小盏，专门把脸从阴影里提出来
        const faceLight = new THREE.DirectionalLight(0xfff6ec, 0.55)
        faceLight.position.set(0.15, 2.0, 3.0)
        faceLight.target.position.set(0, 1.45, 0)
        scene.add(faceLight)
        scene.add(faceLight.target)

        const pivot = new THREE.Group()
        scene.add(pivot)

        const gltf = await new GLTFLoader().loadAsync(url)
        if (disposed) {
          renderer.dispose()
          return
        }

        // 归一到 1.7 高、脚落在 y=0、水平居中：不管模型原来多大、原点在哪都能站正
        const TARGET_H = 1.7
        const model = gltf.scene
        // 翅膀/光环的材质没有贴图（chibang），原本是浅米色，在亮背景上会被冲成纯白；
        // 按参考图给它上金，顺便压一点高光
        model.traverse((obj) => {
          const mesh = obj as unknown as {
            isMesh?: boolean
            material?: {
              name?: string
              map?: unknown
              color?: { setHex: (h: number) => void }
              roughness?: number
              metalness?: number
              emissive?: { setHex: (h: number) => void }
              emissiveIntensity?: number
            }
          }
          const mat = mesh.material
          if (!mesh.isMesh || !mat || mat.map || !/chibang/i.test(mat.name ?? '')) return
          mat.color?.setHex(0xe8b94a)
          mat.roughness = 0.5
          mat.metalness = 0.15
          mat.emissive?.setHex(0x4a3408)
          mat.emissiveIntensity = 0.5
        })
        const raw = new THREE.Box3().setFromObject(model)
        const rawSize = raw.getSize(new THREE.Vector3())
        const rawHeight = rawSize.y || 1
        model.scale.setScalar(TARGET_H / rawHeight)
        const box = new THREE.Box3().setFromObject(model)
        model.position.y -= box.min.y
        model.position.x -= (box.min.x + box.max.x) / 2
        model.position.z -= (box.min.z + box.max.z) / 2
        pivot.add(model)

        // 半身构图：只框头顶到髋部，像助理一样与你面对面（全身像会把她推得太远）
        const fov = 32
        const bustTop = TARGET_H * 1.07
        const bustBottom = TARGET_H * 0.40
        const visible = bustTop - bustBottom
        const centerY = (bustTop + bustBottom) / 2
        const dist = (visible * 1.04) / (2 * Math.tan((fov * Math.PI) / 360))
        camera.fov = fov
        camera.position.set(0, centerY + 0.015, dist)
        camera.lookAt(0, centerY, 0)
        camera.updateProjectionMatrix()

        const anims = gltf.animations ?? []
        const mixer = anims.length ? new THREE.AnimationMixer(model) : null
        // 活人感：idle/talk 两段动作 + 24 个形态键（眨眼、眼球扫视、口型、表情）+ 头部跟随
        const alive = mixer ? createAliveRig(THREE, model, mixer, anims) : null
        if (alive) alive.attachAudio(document.getElementById('official-voice') as HTMLAudioElement | null)

        // 自检用：蒙皮网格数量、动画时钟、某根骨的世界高度——证明动画真在驱动骨架
        type BoneLike = { getWorldPosition: (v: unknown) => void }
        let skinnedMesh: { skeleton?: { bones: unknown[] } } | null = null
        let skins = 0
        model.traverse((obj) => {
          const m = obj as unknown as { isSkinnedMesh?: boolean; skeleton?: { bones: unknown[] } }
          if (m.isSkinnedMesh) {
            skins += 1
            if (!skinnedMesh) skinnedMesh = m
          }
        })
        host.dataset.skins = String(skins)
        const boneVec = new THREE.Vector3()
        const sampleBone = () => {
          const bones = skinnedMesh?.skeleton?.bones as BoneLike[] | undefined
          if (!bones?.length) return
          bones[Math.min(6, bones.length - 1)].getWorldPosition(boneVec)
          host.dataset.boneY = boneVec.y.toFixed(5)
        }

        // 各向异性过滤：俯视/斜视时贴图不糊（脸和衣服的细节主要靠它）
        const maxAniso = renderer.capabilities.getMaxAnisotropy()
        model.traverse((obj) => {
          const mesh = obj as unknown as { isMesh?: boolean; material?: Record<string, unknown> }
          const mat = mesh.material
          if (!mesh.isMesh || !mat) return
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
            const tex = mat[key] as { anisotropy?: number; needsUpdate?: boolean } | undefined
            if (tex) {
              tex.anisotropy = maxAniso
              tex.needsUpdate = true
            }
          }
        })
        setMeta({ height: Number(rawHeight.toFixed(2)), anims: anims.length })
        setStatus('ready')
        // 开发环境下把场景挂到 window，方便排查「哪个网格位置不对」（生产构建里没有）
        if (import.meta.env.DEV) {
          ;(window as unknown as Record<string, unknown>).__AMADEUS_MODEL = { scene, model, camera, renderer, THREE }
        }

        // 拖动转视角；移动很小就算「戳一下」
        let dragging = false
        let lastX = 0
        let moved = 0
        let spin = 0
        const down = (e: PointerEvent) => {
          dragging = true
          lastX = e.clientX
          moved = 0
        }
        const move = (e: PointerEvent) => {
          if (!dragging) return
          spin += (e.clientX - lastX) * 0.006
          moved += Math.abs(e.clientX - lastX)
          lastX = e.clientX
        }
        const up = () => {
          if (dragging && moved < 5) tap.current()
          dragging = false
        }
        renderer.domElement.addEventListener('pointerdown', down)
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)

        const clock = new THREE.Clock()
        let frames = 0
        const loop = () => {
          const dt = clock.getDelta()
          const t = clock.elapsedTime
          if (mixer) mixer.update(dt)
          // 骨骼动画之后再叠活人感（形态键、眨眼、头部跟随都要在 mixer 之后改）
          if (alive) alive.update(dt, { speaking: live.current.speaking, emotion: live.current.emotion })
          const talking = live.current.speaking
          pivot.rotation.y = spin + Math.sin(t * 0.35) * 0.05
          pivot.position.y = Math.sin(t * (talking ? 2.6 : 0.9)) * (talking ? 0.012 : 0.006)
          const [color, intensity] = RIM[live.current.emotion]
          rim.color.setHex(color)
          rim.intensity = intensity + (talking ? 0.6 : 0)
          renderer.render(scene, camera)
          // 真的光栅化出来的三角形数量：WebGL 没跑起来这里是 0，自检靠这个分辨
          if (++frames === 4) host.dataset.tris = String(renderer.info.render.triangles)
          // 无头环境里 rAF 会被节流到很低，所以每帧都写（每帧一次 getWorldPosition 可以忽略）
          if (mixer) {
            host.dataset.animT = mixer.time.toFixed(3)
            sampleBone()
          }
          if (alive) {
            const st = alive.stats()
            host.dataset.clips = st.clips.join(',')
            host.dataset.morphs = String(st.morphTargets)
            host.dataset.blinks = String(st.blinks)
            host.dataset.jaw = st.jaw.toFixed(3)
            host.dataset.look = st.look
            host.dataset.headFollow = st.headFollow ? '1' : '0'
          }
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)

        const ro = new ResizeObserver(() => {
          const w = host.clientWidth || 1
          const h = host.clientHeight || 1
          renderer.setSize(w, h)
          camera.aspect = w / h
          camera.updateProjectionMatrix()
        })
        ro.observe(host)

        teardown = () => {
          cancelAnimationFrame(raf)
          ro.disconnect()
          renderer.domElement.removeEventListener('pointerdown', down)
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          scene.traverse((obj) => {
            const mesh = obj as { geometry?: { dispose: () => void }; material?: unknown }
            mesh.geometry?.dispose()
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            for (const m of mats) {
              const mat = m as { map?: { dispose: () => void }; dispose?: () => void } | undefined
              mat?.map?.dispose()
              mat?.dispose?.()
            }
          })
          renderer.dispose()
          renderer.domElement.remove()
        }
      } catch (err) {
        setStatus('failed')
        fail.current(String((err as Error)?.message ?? err).slice(0, 120))
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      teardown?.()
    }
  }, [url])

  return (
    <div
      ref={hostRef}
      data-model={status}
      data-height={meta.height}
      data-anims={meta.anims}
      className="isolate absolute inset-x-0 bottom-[16vh] top-[8vh] mx-auto w-[min(90vw,560px)] cursor-grab active:cursor-grabbing"
    >
      {/* 贴纸白：角色背后一小块柔和白底，模仿官方那张的白边（别做太大，会把她吞掉） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[18%] bottom-[8%] top-[6%] -z-10 rounded-[48%] blur-2xl"
        style={{
          background:
            'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.9), rgba(255,255,255,0.45) 52%, rgba(255,255,255,0) 76%)',
        }}
      />
      {status === 'loading' && (
        <p className="absolute inset-x-0 top-1/2 text-center font-hud text-[11px] tracking-[0.28em] text-[var(--po-muted)]">
          LOADING MODEL…
        </p>
      )}
    </div>
  )
}
