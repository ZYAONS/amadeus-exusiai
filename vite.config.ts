import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端 1002（与参考项目一致）；/api 反代到本地 node 服务 3002
//
// 部署到 GitHub Pages 时站点在 /<仓库名>/ 下面，构建要带前缀：
//   npx vite build --base=/amadeus-exusiai/
// 这里不用 process.env 读它——本项目没装 @types/node，`tsc --noEmit` 会因为
// "Cannot find name 'process'" 直接把构建打挂（真踩过），所以前缀走命令行参数。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // 默认只听 ::1，127.0.0.1 连不上（自检会卡在导航）
    port: 1002,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true },
      // WebRTC 语音服务的信令（aiortc，python service/webrtc/server.py）
      '/rtc': { target: 'http://127.0.0.1:8001', changeOrigin: true },
    },
    // 编辑器/工具写入时的临时目录会被 watcher 抓到并 EBUSY（真踩过）；
    // public/assets 是静态素材，几十 MB 的模型文件一放进去就能把 watcher 顶死，一律不监视。
    // _ref 是导出/实验的中间产物（.glb、.bvh、.blend、日志），Blender 还在写就会被 EBUSY 打断。
    watch: { ignored: ['**/.*.tmpdir/**', '**/.*.tmp', '**/public/assets/**', '**/_ref/**'] },
  },
})
