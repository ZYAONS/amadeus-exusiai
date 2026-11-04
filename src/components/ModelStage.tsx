import { useEffect, useRef, useState } from 'react'
import type { Emotion } from '../lib/emotion'

type Props = {
  url: string
  emotion: Emotion
  speaking: boolean
  onTap: () => void
  /** 模型加载失败或浏览器没有 WebGL：交回 2D 立绘，别留一块黑 */
  onFail: (reason: string) => void
}

/** 情绪 → 轮廓光颜色与强度 */
const RIM: Record<Emotion, [number, number]> = {
  neutral: [0xffd98a, 1.4],
  joy: [0xffc24b, 2.0],
  smile1: [0xffd98a, 1.6],
  smile2: [0xffb347, 1.6],
  shy: [0xff8fa0, 1.5],
  anger: [0xe0393c, 2.4],
  sadness: [0x6f86b8, 1.1],
  unhappy: [0x8c7fb8, 1.2],
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
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(host.clientWidth || 1, host.clientHeight || 1)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.domElement.setAttribute('aria-label', '3D 人物模型')
        host.appendChild(renderer.domElement)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(30, (host.clientWidth || 1) / (host.clientHeight || 1), 0.05, 100)
        scene.add(new THREE.HemisphereLight(0xffe6c4, 0x101018, 1.2))
        const key = new THREE.DirectionalLight(0xfff2e0, 2.3)
        key.position.set(2.2, 3.4, 2.6)
        scene.add(key)
        const rim = new THREE.DirectionalLight(0xe0393c, 1.6)
        rim.position.set(-2.4, 2.2, -2.8)
        scene.add(rim)
        const fill = new THREE.DirectionalLight(0xffb347, 0.6)
        fill.position.set(-1.6, 1.0, 2.6)
        scene.add(fill)

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
        const raw = new THREE.Box3().setFromObject(model)
        const rawSize = raw.getSize(new THREE.Vector3())
        const rawHeight = rawSize.y || 1
        model.scale.setScalar(TARGET_H / rawHeight)
        const box = new THREE.Box3().setFromObject(model)
        model.position.y -= box.min.y
        model.position.x -= (box.min.x + box.max.x) / 2
        model.position.z -= (box.min.z + box.max.z) / 2
        pivot.add(model)

        // 取景按比例算，不写死距离：换任何模型都拍得全，留 12% 余量
        const fov = 32
        const dist = (TARGET_H * 1.12) / (2 * Math.tan((fov * Math.PI) / 360))
        camera.fov = fov
        camera.position.set(0, TARGET_H * 0.55, dist)
        camera.lookAt(0, TARGET_H * 0.5, 0)
        camera.updateProjectionMatrix()

        const anims = gltf.animations ?? []
        const mixer = anims.length ? new THREE.AnimationMixer(model) : null
        // 一条 GLB 里可能有多段动画（身体呼吸、配件静止姿势各一段），全部播上，
        // 只播 animations[0] 会丢配件的那段（症状是光环飘走、头发错位）
        if (mixer) for (const clip of anims) mixer.clipAction(clip).play()

        setMeta({ height: Number(rawHeight.toFixed(2)), anims: anims.length })
        setStatus('ready')

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
          const talking = live.current.speaking
          pivot.rotation.y = spin + Math.sin(t * 0.35) * 0.05
          pivot.position.y = Math.sin(t * (talking ? 2.6 : 0.9)) * (talking ? 0.012 : 0.006)
          const [color, intensity] = RIM[live.current.emotion]
          rim.color.setHex(color)
          rim.intensity = intensity + (talking ? 0.6 : 0)
          renderer.render(scene, camera)
          // 真的光栅化出来的三角形数量：WebGL 没跑起来这里是 0，自检靠这个分辨
          if (++frames === 4) host.dataset.tris = String(renderer.info.render.triangles)
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
      className="absolute inset-x-0 bottom-[20vh] top-[10vh] mx-auto w-[min(92vw,760px)] cursor-grab active:cursor-grabbing"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[46vmin] rounded-full blur-3xl"
        style={{
          background: 'radial-gradient(circle, rgba(255,179,71,0.22), rgba(224,57,60,0.14) 45%, rgba(8,8,11,0) 72%)',
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
