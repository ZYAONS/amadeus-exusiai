import { createRoot } from 'react-dom/client'
import App from './App'
import { StoreProvider } from './lib/store'
import './index.css'

// 不开 StrictMode：开发环境下的双次挂载会让开场问候和闲置计时器各跑一遍
createRoot(document.getElementById('root')!).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
)
