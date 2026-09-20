import { useEffect, useState } from 'react'
import { useProjectsStore } from './projects-store'
import { useSettingsStore } from './settings-store'

export function useBootstrap(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await Promise.all([
        useSettingsStore.getState().load(),
        useProjectsStore.getState().load(),
      ])
      if (!cancelled) setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return ready
}