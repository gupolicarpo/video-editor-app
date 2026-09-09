import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { app } from 'electron'
import { loadSettings } from '../settings'

// HeyGen talking-photo / lip-sync (API v2). Animates a still photo of a person
// to "speak" — driven either by the user's own audio (best lip-sync to a real
// voice) or by text + a HeyGen voice. Returns a downloaded MP4 path.

type StatusFn = (s: { stage: string; message: string }) => void
type HeyGenStatusResponse = {
  data?: { status?: string; video_url?: string; error?: unknown }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface HeyGenPayload {
  photoPath: string // a photo of the person (e.g. our Kling studio still)
  audioPath?: string // the user's own voice recording (preferred)
  text?: string // OR text to speak
  voiceId?: string // HeyGen voice id (when using text)
  width?: number
  height?: number
}

function mediaDir(): string {
  const s = loadSettings()
  const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

function mimeForImage(path: string): string {
  return /\.png$/i.test(path) ? 'image/png' : 'image/jpeg'
}
function mimeForAudio(path: string): string {
  if (/\.wav$/i.test(path)) return 'audio/wav'
  if (/\.m4a$/i.test(path)) return 'audio/mp4'
  return 'audio/mpeg'
}

export async function heygenGenerate(
  payload: HeyGenPayload,
  onStatus: StatusFn
): Promise<{ ok: boolean; mediaPath?: string; error?: string }> {
  const s = loadSettings()
  const key = s.heygenApiKey
  if (!key) return { ok: false, error: 'Configure a API key da HeyGen em Configurações.' }
  const H = { 'X-Api-Key': key }
  try {
    // 1) Upload the talking photo → talking_photo_id
    onStatus({ stage: 'upload', message: 'Enviando a foto…' })
    const photoBytes = readFileSync(payload.photoPath)
    const tpRes = await fetch('https://upload.heygen.com/v1/talking_photo', {
      method: 'POST',
      headers: { ...H, 'Content-Type': mimeForImage(payload.photoPath) },
      body: photoBytes
    })
    const tpTxt = await tpRes.text()
    if (!tpRes.ok) throw new Error(`upload foto HTTP ${tpRes.status}: ${tpTxt.slice(0, 300)}`)
    const talkingPhotoId = JSON.parse(tpTxt)?.data?.talking_photo_id
    if (!talkingPhotoId) throw new Error('Sem talking_photo_id: ' + tpTxt.slice(0, 200))

    // 2) Voice — from the user's audio (preferred) or from text
    let voice: Record<string, unknown>
    if (payload.audioPath) {
      onStatus({ stage: 'upload', message: 'Enviando seu áudio…' })
      const audioBytes = readFileSync(payload.audioPath)
      const aRes = await fetch('https://upload.heygen.com/v1/asset', {
        method: 'POST',
        headers: { ...H, 'Content-Type': mimeForAudio(payload.audioPath) },
        body: audioBytes
      })
      const aTxt = await aRes.text()
      if (!aRes.ok) throw new Error(`upload áudio HTTP ${aRes.status}: ${aTxt.slice(0, 300)}`)
      const audioAssetId = JSON.parse(aTxt)?.data?.id
      if (!audioAssetId) throw new Error('Sem audio asset id: ' + aTxt.slice(0, 200))
      voice = { type: 'audio', audio_asset_id: audioAssetId }
    } else {
      if (!payload.text) throw new Error('Forneça um áudio ou um texto para falar.')
      voice = { type: 'text', input_text: payload.text, voice_id: payload.voiceId || '' }
    }

    // 3) Generate
    onStatus({ stage: 'submit', message: 'Gerando o vídeo (HeyGen)…' })
    const body = {
      video_inputs: [
        {
          character: { type: 'talking_photo', talking_photo_id: talkingPhotoId },
          voice
        }
      ],
      dimension: { width: payload.width || 1280, height: payload.height || 720 }
    }
    const genRes = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const genTxt = await genRes.text()
    if (!genRes.ok) throw new Error(`generate HTTP ${genRes.status}: ${genTxt.slice(0, 400)}`)
    const videoId = JSON.parse(genTxt)?.data?.video_id
    if (!videoId) throw new Error('Sem video_id: ' + genTxt.slice(0, 200))

    // 4) Poll
    for (let i = 0; i < 200; i++) {
      await sleep(5000)
      const stRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, { headers: H })
      const st = (await stRes.json()) as HeyGenStatusResponse
      const status = st?.data?.status
      onStatus({ stage: 'poll', message: `HeyGen: ${status || 'processando'}…` })
      if (status === 'completed') {
        const url = st?.data?.video_url
        if (!url) throw new Error('Concluído sem video_url.')
        onStatus({ stage: 'download', message: 'Baixando resultado…' })
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
        const out = join(mediaDir(), `heygen-${Date.now()}.mp4`)
        writeFileSync(out, buf)
        return { ok: true, mediaPath: out }
      }
      if (status === 'failed') throw new Error('HeyGen falhou: ' + JSON.stringify(st?.data?.error || st).slice(0, 300))
    }
    throw new Error('Tempo limite excedido.')
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
