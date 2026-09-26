import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { RouterProvider } from 'react-router-dom'
import '@xyflow/react/dist/style.css'
import 'katex/dist/katex.min.css'
import '@/i18n'
import '@/styles/index.css'
import { router } from '@/router'

const container = document.getElementById('root')

if (!container) {
  throw new Error('root container missing')
}

createRoot(container).render(
  <StrictMode>
    {/* reducedMotion="user"：系统开了「减弱动态」时自动砍掉位移类动画，
        保留 opacity / 颜色过渡 —— 反馈仍然可读，只是不再动。 */}
    <MotionConfig reducedMotion="user">
      <RouterProvider router={router} />
    </MotionConfig>
  </StrictMode>,
)
