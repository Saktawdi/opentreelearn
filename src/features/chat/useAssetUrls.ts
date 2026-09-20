import { useEffect, useMemo, useState } from 'react'
import { getRepositories } from '@/data'
import type { Id } from '@/domain/models'
import { loadAssetUrls } from '@/services/images'

export function useAssetUrls(idsKey: string): Record<Id, string> {
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])
  const [urls, setUrls] = useState<Record<Id, string>>({})

  useEffect(() => {
    if (ids.length === 0) return
    let active = true

    void loadAssetUrls(getRepositories().assets, ids).then((map) => {
      if (!active) return
      setUrls((previous) => ({ ...previous, ...Object.fromEntries(map) }))
    })

    return () => {
      active = false
    }
  }, [ids])

  return urls
}