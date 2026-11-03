import { useEffect, useRef } from 'react'

type P = { x: number; y: number; r: number; vy: number; vx: number; a: number; hue: string }

/** 极简粒子背景：飘上去的光点，够用就行，不做 WebGL */
export default function ParticleField() {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let particles: P[] = []

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round((canvas.clientWidth * canvas.clientHeight) / 42000)
      particles = Array.from({ length: Math.min(90, Math.max(24, n)) }, () => ({
        x: Math.random() * canvas.clientWidth,
        y: Math.random() * canvas.clientHeight,
        r: 0.6 + Math.random() * 1.8,
        vy: -0.08 - Math.random() * 0.28,
        vx: (Math.random() - 0.5) * 0.12,
        a: 0.15 + Math.random() * 0.5,
        hue: Math.random() > 0.55 ? '255,179,71' : '224,57,60',
      }))
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.y < -10) {
          p.y = canvas.clientHeight + 10
          p.x = Math.random() * canvas.clientWidth
        }
        if (p.x < -10) p.x = canvas.clientWidth + 10
        if (p.x > canvas.clientWidth + 10) p.x = -10
        ctx.beginPath()
        ctx.fillStyle = `rgba(${p.hue},${p.a})`
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      raf = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    if (reduce) {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    } else {
      raf = requestAnimationFrame(draw)
    }
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 h-full w-full" />
}
