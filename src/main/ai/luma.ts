import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { app } from 'electron'
import { loadSettings } from '../settings'
import { extractSegment } from '../ffmpeg'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

// Mux the original audio (from `audioSrc`) onto a silent video (`videoSrc`).
// Luma returns video-only; the original performance audio lines up because the
// edit preserves timing and motion. Falls back to the silent video on failure.
function muxAudio(videoSrc: string, audioSrc: string, out: string): Promise<string> {
  const args = [
    '-y',
    '-i', videoSrc,
    '-i', audioSrc,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-shortest',
    out
  ]
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args)
    proc.on('error', () => resolve(videoSrc))
    proc.on('close', (code) => resolve(code === 0 && existsSync(out) ? out : videoSrc))
  })
}

export interface LumaPayload {
  videoPath: string
  videoIn: number
  videoDur: number
  prompt: string
  resolution?: string // '540p' | '720p' | '1080p'
}

type StatusFn = (s: { stage: string; message: string }) => void
type LumaTaskResponse = {
  state?: string
  output?: Array<{ url?: string }>
  assets?: { video?: string }
  video?: string
  failure_reason?: unknown
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mediaDir(): string {
  const s = loadSettings()
  const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

// Reference-guided video-to-video edit (relight / restyle) via Luma Ray 3.2.
export async function lumaModify(
  payload: LumaPayload,
  onStatus: StatusFn
): Promise<{ ok: boolean; mediaPath?: string; error?: string }> {
  const s = loadSettings()
  if (!s.lumaApiKey) return { ok: false, error: 'Configure a API key da Luma em Configurações.' }
  const base = s.lumaBaseUrl.replace(/\/$/, '')
  const model = s.lumaModel || 'ray-3.2'
  const tempFiles: string[] = []
  try {
    onStatus({ stage: 'prepare', message: 'Preparando o trecho do vídeo…' })
    const dur = Math.min(10, Math.max(1, payload.videoDur))
    const seg = join(tmpdir(), `vedit-luma-${Date.now()}.mp4`)
    await extractSegment(payload.videoPath, payload.videoIn, dur, seg)
    tempFiles.push(seg)
    const b64 = readFileSync(seg).toString('base64')

    const body: any = {
      type: 'video_edit',
      model,
      prompt: payload.prompt,
      aspect_ratio: '16:9',
      source: { data: b64, media_type: 'video/mp4' },
      video: { resolution: payload.resolution || '720p', duration: `${Math.round(dur)}s` }
    }

    onStatus({ stage: 'submit', message: 'Enviando para a Luma (Ray 3.2)…' })
    const r = await fetch(`${base}/v1/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.lumaApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const txt = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 400)}`)
    const sub = JSON.parse(txt)
    const id = sub.id || sub.generation_id
    if (!id) throw new Error('Resposta inesperada: ' + txt.slice(0, 200))

    for (let i = 0; i < 150; i++) {
      await sleep(6000)
      const t = (await (
        await fetch(`${base}/v1/generations/${id}`, { headers: { Authorization: `Bearer ${s.lumaApiKey}` } })
      ).json()) as LumaTaskResponse
      onStatus({ stage: 'poll', message: `Luma: ${t.state || 'processando'}…` })
      if (t.state === 'completed') {
        const url = t.output?.[0]?.url || t.assets?.video || t.video
        if (!url) throw new Error('Concluído sem URL de vídeo.')
        onStatus({ stage: 'download', message: 'Baixando resultado…' })
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
        const stamp = Date.now()
        const silent = join(tmpdir(), `vedit-luma-out-${stamp}.mp4`)
        writeFileSync(silent, buf)
        tempFiles.push(silent)
        // Re-attach the original audio (Luma output is silent).
        onStatus({ stage: 'audio', message: 'Reaplicando o áudio original…' })
        const out = join(mediaDir(), `luma-edit-${stamp}.mp4`)
        const muxed = await muxAudio(silent, seg, out)
        if (muxed !== out) writeFileSync(out, buf) // mux failed → keep silent video
        return { ok: true, mediaPath: out }
      }
      if (t.state === 'failed') throw new Error('Luma falhou: ' + JSON.stringify(t.failure_reason || t).slice(0, 300))
    }
    throw new Error('Tempo limite excedido.')
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  } finally {
    for (const f of tempFiles) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
  }
}
