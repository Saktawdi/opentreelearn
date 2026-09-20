import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import '@xyflow/react/dist/style.css'
import 'katex/dist/katex.min.css'
import '@/styles/index.css'
import { router } from '@/router'

const container = document.getElementById('root')

if (!container) {
  throw new Error('root container missing')
}

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)