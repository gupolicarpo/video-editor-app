import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { loadSettings } from '../settings'
import { generateSeedanceV2, type SeedanceMode } from './seedance'

export interface GeneratePayload {
  provider: 'seedance' | 'veo'
  mode?: SeedanceMode
  prompt: string
  model?: string
  durationSec?: number
  aspectRatio?: string // '16:9' | '9:16' | '1:1' ...
  resolution?: string // '480p' | '720p' | '1080p' | '4k'
  generateAudio?: boolean
  watermark?: boolean
  returnLastFrame?: boolean
  priority?: number
  imagePath?: string // legacy single image (Veo first frame)
  imagePaths?: string[] // reference images (Seedance 2.0, up to 9)
  imageRefs?: Array<{ path: string; role: 'reference_image' | 'first_frame' | 'last_frame' }>
  videoReferences?: Array<{ path: string; inPoint?: number; duration?: number }>
  audioPaths?: string[]
  // for 'edit' mode: source video clip + trim to use as the reference video
  videoPath?: string
  videoIn?: number
  videoDur?: number
}

export interface GenerateResult {
  ok: boolean
  mediaPath?: string
  lastFramePath?: string
  error?: string
}

type StatusFn = (s: { stage: string; message: string }) => void

function mediaDir(): string {
  const s = loadSettings()
  const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function generateVideo(payload: GeneratePayload, onStatus: StatusFn): Promise<GenerateResult> {
  try {
    if (payload.provider === 'seedance') return await generateSeedanceV2(payload, onStatus)
    return await generateVeo(payload, onStatus)
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

// ---- DeepSeek prompt enhancer ---------------------------------------------
export async function enhancePrompt(input: {
  prompt: string
  mode: 'generate' | 'edit'
}): Promise<{ ok: boolean; prompt?: string; error?: string }> {
  try {
    const s = loadSettings()
    if (!s.deepseekApiKey) return { ok: false, error: 'Configure a API key do DeepSeek em Configurações.' }
    const base = s.deepseekBaseUrl.replace(/\/$/, '')
    const model = s.deepseekModel || 'deepseek-chat'

    const sys =
      input.mode === 'edit'
        ? 'Você é um especialista em prompts para EDIÇÃO de vídeo por IA (Seedance 2.0, vídeo-para-vídeo). ' +
          'Reescreva a ideia do usuário em UM prompt claro e específico, no mesmo idioma do usuário. ' +
          'Sempre deixe explícito O QUE MUDAR e O QUE MANTER (preserve o sujeito, o movimento e a câmera originais quando fizer sentido). ' +
          'Seja concreto sobre cores, posição, iluminação e estilo. Responda APENAS com o prompt final, sem aspas, sem explicações.'
        : 'Você é um especialista em prompts para GERAÇÃO de vídeo por IA (Seedance 2.0). ' +
          'Reescreva a ideia do usuário em UM prompt cinematográfico, vívido e específico, no mesmo idioma do usuário. ' +
          'Inclua detalhes de cena, movimento de câmera, iluminação e atmosfera. Responda APENAS com o prompt final, sem aspas, sem explicações.'

    const res = await fetchJson(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.deepseekApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: input.prompt }
        ],
        temperature: 0.7,
        stream: false
      })
    })
    const text = res.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('Resposta vazia do DeepSeek.')
    return { ok: true, prompt: text.replace(/^["']|["']$/g, '') }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

// ---- Veo (Google Gemini API) ----------------------------------------------
async function generateVeo(payload: GeneratePayload, onStatus: StatusFn): Promise<GenerateResult> {
  const s = loadSettings()
  if (!s.veoApiKey) return { ok: false, error: 'Configure a API key do Veo (Google) em Configurações.' }
  const base = s.veoBaseUrl.replace(/\/$/, '')
  const model = payload.model || 'veo-3.0-generate-001'
  const key = s.veoApiKey

  const instance: any = { prompt: payload.prompt }
  if (payload.imagePath) {
    instance.image = { bytesBase64Encoded: readFileSync(payload.imagePath).toString('base64'), mimeType: mimeFor(payload.imagePath) }
  }
  const parameters: any = {}
  if (payload.aspectRatio) parameters.aspectRatio = payload.aspectRatio
  if (payload.durationSec) parameters.durationSeconds = Math.round(payload.durationSec)

  onStatus({ stage: 'submit', message: 'Enviando tarefa para o Veo…' })
  const op = await fetchJson(`${base}/v1beta/models/${model}:predictLongRunning?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [instance], parameters })
  })
  const opName = op.name
  if (!opName) throw new Error('Resposta inesperada do Veo: ' + JSON.stringify(op).slice(0, 300))

  for (let i = 0; i < 120; i++) {
    await sleep(5000)
    const status = await fetchJson(`${base}/v1beta/${opName}?key=${key}`, {})
    onStatus({ stage: 'poll', message: `Veo: gerando… (${(i + 1) * 5}s)` })
    if (status.done) {
      if (status.error) throw new Error('Veo falhou: ' + JSON.stringify(status.error).slice(0, 300))
      const uri = extractVeoUri(status.response)
      if (!uri) throw new Error('Veo concluiu mas não retornou URI de vídeo.')
      const dlUrl = uri.includes('key=') ? uri : `${uri}${uri.includes('?') ? '&' : '?'}key=${key}`
      return await download(dlUrl, 'veo', onStatus)
    }
  }
  throw new Error('Veo: tempo limite excedido (10 min).')
}

function extractVeoUri(response: any): string | undefined {
  if (!response) return undefined
  const samples =
    response.generateVideoResponse?.generatedSamples ||
    response.generatedSamples ||
    response.videos ||
    []
  return samples[0]?.video?.uri || samples[0]?.uri || response.video?.uri
}

// ---- shared ---------------------------------------------------------------
async function download(url: string, prefix: string, onStatus: StatusFn): Promise<GenerateResult> {
  onStatus({ stage: 'download', message: 'Baixando vídeo gerado…' })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download falhou: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = `${prefix}-${Date.now()}.mp4`
  const out = join(mediaDir(), name)
  writeFileSync(out, buf)
  onStatus({ stage: 'done', message: 'Pronto! Vídeo adicionado à biblioteca.' })
  return { ok: true, mediaPath: out }
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init)
  const text = await res.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 300)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  return json
}

function mimeFor(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}
