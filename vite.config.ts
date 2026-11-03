import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端 1002（与参考项目一致）；/api 反代到本地 node 服务 3002
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // 默认只听 ::1，127.0.0.1 连不上（自检会卡在导航）
    port: 1002,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true },
    },
    // 编辑器/工具写入时的临时目录会被 watcher 抓到并 EBUSY（真踩过），直接忽略
    watch: { ignored: ['**/.*.tmpdir/**', '**/.*.tmp'] },
  },
})
