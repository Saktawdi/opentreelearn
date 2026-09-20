import { lazy } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { ProjectsPage } from '@/features/projects/ProjectsPage'

const CanvasPage = lazy(() =>
  import('@/features/canvas/CanvasPage').then((module) => ({ default: module.CanvasPage })),
)

const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((module) => ({
    default: module.SettingsPage,
  })),
)

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: 'p/:projectId', element: <CanvasPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])