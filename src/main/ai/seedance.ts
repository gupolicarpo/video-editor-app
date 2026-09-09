import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractSegment, probeMedia } from '../ffmpeg'
import { loadSettings } from '../settings'
import {
  buildSeedanceRequest,
  isSeedanceVideoUrl,
  seedancePromptForMode,
  type SeedanceImageRole
} from './seedanceRequest'
import { uploadTemporarySeedanceVideo, type TemporaryTosObject } from './tosUpload'

export type SeedanceMode = 'generate' | 'motion' | 'edit' | 'extend' | 'connect'

export interface SeedanceGeneratePayload {
  mode?: SeedanceMode
  prompt: string
  model?: string
  durationSec?: number
  aspectRatio?: string
  resolution?: string
  generateAudio?: boolean
  watermark?: boolean
  returnLastFrame?: boolean
  priority?: number
  imagePath?: string
  imagePaths?: string[]
  imageRefs?: Array<{ path: string; role: SeedanceImageRole }>
  videoReferences?: Array<{ path: string; inPoint?: number; duration?: number }>
  audioPaths?: string[]
  videoPath?: string
  videoIn?: number
  videoDur?: number
}

export interface SeedanceGenerateResult {
  ok: boolean
  mediaPath?: string
  lastFramePath?: string
  error?: string
}

type StatusFn = (status: { stage: string; message: string }) => void

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let generationRunning = false
let cancelRequested = false
let activeTask: { id: string; base: string; apiKey: string } | null = null

export async function cancelSeedanceGeneration(): Promise<boolean> {
  if (!generationRunning) return false
  cancelRequested = true
  if (activeTask) {
    try {
      await fetch(`${activeTask.base}/contents/generations/tasks/${activeTask.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${activeTask.apiKey}` }
      })
    } catch {
      /* The polling loop will still stop locally. */
    }
  }
  return true
}

export async function generateSeedanceV2(
  payload: SeedanceGeneratePayload,
  onStatus: StatusFn
): Promise<SeedanceGenerateResult> {
  const settings = loadSettings()
  if (!settings.seedanceApiKey) {
    return { ok: false, error: 'Configure a API key da Seedance em Configurações.' }
  }
  if (generationRunning) return { ok: false, error: 'Já existe uma geração Seedance em andamento.' }

  const base = settings.seedanceBaseUrl.replace(/\/$/, '')
  const model = payload.model || settings.seedanceModel || 'dreamina-seedance-2-0-260128'
  const tempFiles: string[] = []
  const uploaded: TemporaryTosObject[] = []
  generationRunning = true
  cancelRequested = false

  try {
    const legacyImages = payload.imagePaths || (payload.imagePath ? [payload.imagePath] : [])
    const imageInputs =
      payload.imageRefs || legacyImages.map((path) => ({ path, role: 'reference_image' as const }))
    const images = imageInputs.map((image) => ({
      role: image.role,
      url: referenceUrl(image.path)
    }))

    const videoInputs =
      payload.videoReferences ||
      (payload.videoPath
        ? [{ path: payload.videoPath, inPoint: payload.videoIn, duration: payload.videoDur }]
        : [])
    const videos: string[] = []
    let localVideoSeconds = 0
    const localVideoCount = videoInputs.filter((video) => !isSeedanceVideoUrl(video.path)).length
    let localVideoIndex = 0

    for (const [index, video] of videoInputs.entries()) {
      if (isSeedanceVideoUrl(video.path)) {
        videos.push(video.path)
        continue
      }

      onStatus({
        stage: 'prepare',
        message: `Preparando vídeo de referência ${index + 1}/${videoInputs.length}…`
      })
      const meta = await probeMedia(video.path)
      const start = Math.max(0, video.inPoint ?? 0)
      const available = Math.max(0, meta.duration - start)
      const remainingLocalVideos = localVideoCount - localVideoIndex - 1
      const maxForThisVideo = 15 - localVideoSeconds - remainingLocalVideos * 2
      const duration = Math.min(video.duration ?? available, available, 15, maxForThisVideo)
      if (duration < 2) throw new Error('Cada vídeo de referência precisa ter pelo menos 2 segundos.')
      localVideoSeconds += duration
      localVideoIndex++

      const segment = join(tmpdir(), `vedit-seedance-ref-${Date.now()}-${index}.mp4`)
      tempFiles.push(segment)
      await extractSegment(video.path, start, duration, segment)

      const remote = await uploadTemporarySeedanceVideo(
        {
          region: settings.seedanceTosRegion,
          endpoint: settings.seedanceTosEndpoint,
          bucket: settings.seedanceTosBucket,
          accessKeyId: settings.seedanceTosAccessKey,
          accessKeySecret: settings.seedanceTosSecretKey
        },
        segment,
        (percent) =>
          onStatus({
            stage: 'upload',
            message: `Enviando vídeo de referência ${index + 1}/${videoInputs.length}… ${percent}%`
          })
      )
      uploaded.push(remote)
      videos.push(remote.url)
      if (cancelRequested) throw new Error('Geração cancelada.')
    }

    const audios: string[] = []
    let localAudioSeconds = 0
    for (const audio of payload.audioPaths || []) {
      if (/^(?:https?:\/\/|asset:\/\/|data:)/i.test(audio)) {
        audios.push(audio)
        continue
      }
      if (!/\.(?:wav|mp3)$/i.test(audio)) {
        throw new Error('Áudio local de referência precisa estar em WAV ou MP3.')
      }
      if (statSync(audio).size > 15 * 1024 * 1024) {
        throw new Error('Cada áudio de referência pode ter no máximo 15 MB.')
      }
      const meta = await probeMedia(audio)
      if (meta.duration < 2 || meta.duration > 15) {
        throw new Error('Cada áudio de referência precisa ter entre 2 e 15 segundos.')
      }
      localAudioSeconds += meta.duration
      if (localAudioSeconds > 15) {
        throw new Error('A soma dos áudios de referência locais não pode passar de 15 segundos.')
      }
      audios.push(referenceUrl(audio))
    }
    if (cancelRequested) throw new Error('Geração cancelada.')

    const body = buildSeedanceRequest({
      model,
      prompt: seedancePromptForMode(payload.mode, payload.prompt),
      images,
      videos,
      audios,
      resolution: payload.resolution,
      ratio: payload.aspectRatio,
      duration: payload.durationSec === undefined ? undefined : Math.round(payload.durationSec),
      generateAudio: payload.generateAudio ?? true,
      watermark: payload.watermark ?? false,
      returnLastFrame: payload.returnLastFrame,
      priority: payload.priority
    })

    onStatus({ stage: 'submit', message: 'Enviando tarefa para a Seedance 2.0…' })
    const submit = await fetchJson(`${base}/contents/generations/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.seedanceApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const taskId = submit.id || submit.task_id
    if (!taskId) throw new Error('Resposta inesperada da Seedance: ' + JSON.stringify(submit).slice(0, 300))
    activeTask = { id: taskId, base, apiKey: settings.seedanceApiKey }

    for (let index = 0; index < 150; index++) {
      if (cancelRequested) throw new Error('Geração cancelada.')
      await sleep(index < 6 ? 5000 : 8000)
      const task = await fetchJson(`${base}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${settings.seedanceApiKey}` }
      })
      const status = task.status
      onStatus({ stage: 'poll', message: `Seedance: ${status || 'processando'}…` })

      if (status === 'succeeded') {
        const videoUrl = asUrl(task.content?.video_url || task.content?.[0]?.video_url)
        if (!videoUrl) throw new Error('Tarefa concluída mas sem video_url.')
        const prefix =
          payload.mode && payload.mode !== 'generate' ? `seedance-${payload.mode}` : 'seedance'
        const mediaPath = await downloadFile(videoUrl, prefix, '.mp4', 'Baixando vídeo gerado…', onStatus)
        const result: SeedanceGenerateResult = { ok: true, mediaPath }

        const lastFrameUrl = asUrl(
          task.content?.last_frame_url || task.content?.[0]?.last_frame_url
        )
        if (payload.returnLastFrame && lastFrameUrl) {
          result.lastFramePath = await downloadFile(
            lastFrameUrl,
            'seedance-last-frame',
            '.jpg',
            'Baixando último quadro…',
            onStatus
          )
        }
        onStatus({ stage: 'done', message: 'Pronto! Resultado adicionado à biblioteca.' })
        return result
      }
      if (status === 'failed' || status === 'canceled' || status === 'expired') {
        throw new Error('Seedance falhou: ' + (task.error?.message || status))
      }
    }
    throw new Error('Seedance: tempo limite excedido.')
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) }
  } finally {
    generationRunning = false
    activeTask = null
    for (const object of uploaded) {
      try {
        await object.remove()
      } catch {
        /* A URL assinada expira mesmo se a limpeza remota falhar. */
      }
    }
    for (const file of tempFiles) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
  }
}

function outputDir(): string {
  const settings = loadSettings()
  const dir = settings.mediaDir || join(app.getPath('userData'), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

function referenceUrl(path: string): string {
  if (/^(?:https?:\/\/|asset:\/\/|data:)/i.test(path)) return path
  if (/\.(?:png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i.test(path) && statSync(path).size >= 30 * 1024 * 1024) {
    throw new Error('Cada imagem de referência precisa ter menos de 30 MB.')
  }
  return `data:${mimeFor(path)};base64,${readFileSync(path).toString('base64')}`
}

function mimeFor(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff'
  if (ext === 'heic') return 'image/heic'
  if (ext === 'heif') return 'image/heif'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'aac') return 'audio/aac'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'flac') return 'audio/flac'
  return 'image/jpeg'
}

function asUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'url' in value) {
    const url = (value as { url?: unknown }).url
    return typeof url === 'string' ? url : undefined
  }
  return undefined
}

async function downloadFile(
  url: string,
  prefix: string,
  extension: string,
  message: string,
  onStatus: StatusFn
): Promise<string> {
  onStatus({ stage: 'download', message })
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download falhou: HTTP ${response.status}`)
  const out = join(outputDir(), `${prefix}-${Date.now()}${extension}`)
  writeFileSync(out, Buffer.from(await response.arrayBuffer()))
  return out
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  const text = await response.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    const message = json?.error?.message || json?.message || text.slice(0, 300)
    throw new Error(`HTTP ${response.status}: ${message}`)
  }
  return json
}
