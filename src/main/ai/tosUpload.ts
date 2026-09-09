import { randomUUID } from 'crypto'
import { extname } from 'path'
import { TosClient } from '@volcengine/tos-sdk'

export interface SeedanceTosConfig {
  region: string
  endpoint: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
}

export interface TemporaryTosObject {
  url: string
  remove: () => Promise<void>
}

function contentType(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  return 'video/mp4'
}

export function hasSeedanceTosConfig(config: SeedanceTosConfig): boolean {
  return !!(
    config.region.trim() &&
    config.endpoint.trim() &&
    config.bucket.trim() &&
    config.accessKeyId.trim() &&
    config.accessKeySecret.trim()
  )
}

export async function uploadTemporarySeedanceVideo(
  config: SeedanceTosConfig,
  filePath: string,
  onProgress?: (percent: number) => void
): Promise<TemporaryTosObject> {
  if (!hasSeedanceTosConfig(config)) {
    throw new Error(
      'Para usar um vídeo local como referência, configure o bucket TOS da Volcengine em Configurações → Seedance.'
    )
  }

  const endpoint = config.endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const bucket = config.bucket.trim()
  const key = `video-editor/seedance/${Date.now()}-${randomUUID()}${extname(filePath).toLowerCase() || '.mp4'}`
  const client = new TosClient({
    accessKeyId: config.accessKeyId.trim(),
    accessKeySecret: config.accessKeySecret.trim(),
    region: config.region.trim(),
    endpoint
  })

  await client.putObjectFromFile({
    bucket,
    key,
    filePath,
    contentType: contentType(filePath),
    progress: (fraction) => onProgress?.(Math.round(fraction * 100))
  })

  const url = client.getPreSignedUrl({
    bucket,
    key,
    method: 'GET',
    expires: 7200
  })

  return {
    url,
    remove: async () => {
      await client.deleteObject({ bucket, key })
    }
  }
}
