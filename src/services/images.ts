import type { AssetRepository } from '@/data/repository'
import type { Asset, Id } from '@/domain/models'
import { newId } from '@/lib/id'

export const MAX_IMAGE_EDGE = 1600
const DATA_URL_CACHE_LIMIT = 24

const dataUrlCache = new Map<Id, string>()

function rememberDataUrl(id: Id, dataUrl: string): void {
  if (dataUrlCache.size >= DATA_URL_CACHE_LIMIT) {
    const oldest = dataUrlCache.keys().next().value
    if (oldest) dataUrlCache.delete(oldest)
  }
  dataUrlCache.set(id, dataUrl)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

async function loadSource(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // fall through to the <img> path
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法解析该图片'))
    }
    image.src = url
  })
}

function scaleToFit(width: number, height: number, maxEdge: number) {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) {
    return { width, height }
  }
  const ratio = maxEdge / longest
  return {
    width: Math.max(Math.round(width * ratio), 1),
    height: Math.max(Math.round(height * ratio), 1),
  }
}

function pickOutputType(sourceType: string): string {
  if (sourceType === 'image/jpeg' || sourceType === 'image/webp' || sourceType === 'image/png') {
    return sourceType
  }
  return 'image/png'
}

export async function createImageAsset(file: File, projectId: Id): Promise<Asset> {
  const source = await loadSource(file)
  const sourceWidth = 'naturalWidth' in source ? source.naturalWidth : source.width
  const sourceHeight = 'naturalHeight' in source ? source.naturalHeight : source.height
  const target = scaleToFit(sourceWidth, sourceHeight, MAX_IMAGE_EDGE)

  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height

  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器不支持画布绘制')

  context.drawImage(source, 0, 0, target.width, target.height)
  if ('close' in source && typeof source.close === 'function') source.close()

  const outputType = pickOutputType(file.type)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputType, outputType === 'image/jpeg' ? 0.86 : undefined),
  )

  if (!blob) throw new Error('图片压缩失败')

  return {
    id: newId(),
    projectId,
    kind: 'image',
    mime: blob.type || outputType,
    name: file.name,
    width: target.width,
    height: target.height,
    createdAt: Date.now(),
    blob,
  }
}

export async function assetToDataUrl(asset: Asset): Promise<string> {
  const cached = dataUrlCache.get(asset.id)
  if (cached) return cached
  const dataUrl = await blobToDataUrl(asset.blob)
  rememberDataUrl(asset.id, dataUrl)
  return dataUrl
}

export async function loadAssetUrls(
  assets: AssetRepository,
  ids: Id[],
): Promise<Map<Id, string>> {
  const unique = [...new Set(ids)]
  const entries = await Promise.all(
    unique.map(async (id): Promise<[Id, string] | null> => {
      const asset = await assets.get(id)
      if (!asset) return null
      return [id, await assetToDataUrl(asset)]
    }),
  )

  return new Map(entries.filter((entry): entry is [Id, string] => entry !== null))
}

export function imagesFromClipboard(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items
  if (!items) return []

  const files: File[] = []
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

export function imagesFromDataTransfer(transfer: DataTransfer): File[] {
  const files: File[] = []
  for (const file of transfer.files) {
    if (file.type.startsWith('image/')) files.push(file)
  }
  return files
}