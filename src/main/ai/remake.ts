import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { spawn } from 'child_process'
import { app } from 'electron'
import { loadSettings } from '../settings'

// "Remake from existing" — the RIGHT method: keep the original audio, and redo
// each scene's ORIGINAL frame via image-to-image using that frame as an image
// reference (faithful upgrade, same composition/context). NOT text-only.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
type StatusFn = (s: { stage: string; message: string }) => void
type LumaImageTaskResponse = {
  state?: string
  output?: Array<{ url?: string }>
  failure_reason?: unknown
}

function remakeDir(): string {
  const s = loadSettings()
  const base = s.mediaDir || join(app.getPath('userData'), 'generated')
  const dir = join(base, 'remake')
  mkdirSync(dir, { recursive: true })
  return dir
}

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args)
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-800)))))
  })
}

function detectCuts(src: string): Promise<number[]> {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-i', src, '-filter:v', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'])
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('close', () => {
      const times = [...err.matchAll(/pts_time:([0-9.]+)/g)].map((m) => parseFloat(m[1]))
      resolve(times)
    })
  })
}

export interface RemakeScene {
  index: number
  start: number
  duration: number
  framePath: string
}
export interface RemakeAnalysis {
  ok: boolean
  error?: string
  width?: number
  height?: number
  duration?: number
  audioPath?: string
  scenes?: RemakeScene[]
}

// Probe → scene cuts → one reference frame per scene → extract audio. No API cost.
export async function remakeAnalyze(sourcePath: string, onStatus: StatusFn): Promise<RemakeAnalysis> {
  try {
    onStatus({ stage: 'probe', message: 'Analisando o vídeo…' })
    const meta = await probe(sourcePath)
    const dir = remakeDir()

    onStatus({ stage: 'scenes', message: 'Detectando cenas…' })
    const cuts = await detectCuts(sourcePath)
    // Build segment boundaries: 0, cuts…, end. Merge cuts closer than 2.5s; cap at 16.
    const bounds = [0, ...cuts.filter((t) => t > 0.5 && t < meta.duration - 0.3), meta.duration]
    const merged: number[] = [0]
    for (let i = 1; i < bounds.length; i++) {
      if (bounds[i] - merged[merged.length - 1] >= 2.5) merged.push(bounds[i])
    }
    if (merged[merged.length - 1] < meta.duration) merged[merged.length - 1] = meta.duration
    // guarantee at least one full-length scene (short clips / no cuts)
    if (merged.length < 2) merged.splice(0, merged.length, 0, meta.duration)
    // cap scene count
    while (merged.length - 1 > 16) {
      // drop the boundary that makes the shortest segment
      let minI = 1
      let minLen = Infinity
      for (let i = 1; i < merged.length - 1; i++) {
        const len = merged[i + 1] - merged[i]
        if (len < minLen) {
          minLen = len
          minI = i
        }
      }
      merged.splice(minI, 1)
    }

    const scenes: RemakeScene[] = []
    for (let i = 0; i < merged.length - 1; i++) {
      const start = merged[i]
      const duration = +(merged[i + 1] - start).toFixed(3)
      const mid = start + duration / 2
      const framePath = join(dir, `frame_${String(i + 1).padStart(2, '0')}.jpg`)
      onStatus({ stage: 'frames', message: `Extraindo frame ${i + 1}/${merged.length - 1}…` })
      await ff(['-y', '-ss', mid.toFixed(3), '-i', sourcePath, '-frames:v', '1', '-q:v', '2', framePath])
      scenes.push({ index: i + 1, start, duration, framePath })
    }

    onStatus({ stage: 'audio', message: 'Extraindo o áudio…' })
    const audioPath = join(dir, `audio_${Date.now()}.m4a`)
    await ff(['-y', '-i', sourcePath, '-vn', '-c:a', 'aac', '-b:a', '192k', audioPath])

    return { ok: true, width: meta.width, height: meta.height, duration: meta.duration, audioPath, scenes }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

// Minimal probe (dims + duration) via ffprobe.
function probe(src: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
    const p = spawn(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      src
    ])
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('error', reject)
    p.on('close', () => {
      try {
        const j = JSON.parse(out)
        resolve({
          width: j.streams?.[0]?.width || 1920,
          height: j.streams?.[0]?.height || 1080,
          duration: parseFloat(j.format?.duration || '0')
        })
      } catch (e) {
        reject(e)
      }
    })
  })
}

// Redo one frame via IMAGE REFERENCE (image-to-image). provider 'luma' now; 'openai' later.
export async function remakeRefine(
  payload: { framePath: string; prompt: string; provider: 'luma' | 'openai'; model?: string; size?: string },
  onStatus: StatusFn
): Promise<{ ok: boolean; imagePath?: string; error?: string }> {
  const s = loadSettings()
  try {
    const b64 = readFileSync(payload.framePath).toString('base64')
    const outPath = payload.framePath.replace(/\.jpg$/i, `_up_${Date.now()}.png`)
    if (payload.provider === 'openai') {
      // gpt-image-2 image edit: the original frame is the input; the prompt asks
      // for an upgrade while keeping composition (faithful reference remake).
      if (!s.openaiApiKey) return { ok: false, error: 'Configure a API key da OpenAI em Configurações.' }
      const form = new FormData()
      form.append('model', payload.model || 'gpt-image-2')
      form.append('prompt', payload.prompt || 'Upgrade this image to higher quality; keep the exact same composition and content.')
      form.append('size', payload.size || 'auto')
      form.append('quality', 'high')
      form.append('image', new Blob([readFileSync(payload.framePath)], { type: 'image/jpeg' }), 'frame.jpg')
      onStatus({ stage: 'submit', message: 'Refazendo o frame (gpt-image-2)…' })
      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.openaiApiKey}` },
        body: form
      })
      const txt = await r.text()
      if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${txt.slice(0, 400)}`)
      const b64out = JSON.parse(txt)?.data?.[0]?.b64_json
      if (!b64out) throw new Error('OpenAI sem imagem: ' + txt.slice(0, 200))
      writeFileSync(outPath, Buffer.from(b64out, 'base64'))
      return { ok: true, imagePath: outPath }
    }
    // Luma agents image_edit — edits the source frame while keeping unmentioned parts.
    if (!s.lumaApiKey) return { ok: false, error: 'Configure a API key da Luma.' }
    const base = s.lumaBaseUrl.replace(/\/$/, '')
    const body = {
      type: 'image_edit',
      model: payload.model || 'uni-1-max',
      prompt:
        payload.prompt ||
        'Recreate this exact shot as a higher-quality, fresher cinematic version. Keep the same composition, subject, framing, lighting mood and color palette. Upgrade detail and realism only; do not change the content or context.',
      source: { data: b64, media_type: 'image/jpeg' }
    }
    onStatus({ stage: 'submit', message: 'Refazendo o frame (Luma image_edit)…' })
    const r = await fetch(`${base}/v1/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.lumaApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const txt = await r.text()
    if (!r.ok) throw new Error(`Luma HTTP ${r.status}: ${txt.slice(0, 300)}`)
    const id = JSON.parse(txt)?.id
    if (!id) throw new Error('Luma sem id: ' + txt.slice(0, 200))
    for (let i = 0; i < 100; i++) {
      await sleep(5000)
      const t = (await (
        await fetch(`${base}/v1/generations/${id}`, { headers: { Authorization: `Bearer ${s.lumaApiKey}` } })
      ).json()) as LumaImageTaskResponse
      onStatus({ stage: 'poll', message: `Luma: ${t.state || 'processando'}…` })
      if (t.state === 'completed') {
        const url = t.output?.[0]?.url
        if (!url) throw new Error('Luma concluído sem URL.')
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
        writeFileSync(outPath, buf)
        return { ok: true, imagePath: outPath }
      }
      if (t.state === 'failed') throw new Error('Luma falhou: ' + JSON.stringify(t.failure_reason || t).slice(0, 200))
    }
    throw new Error('Luma: tempo limite.')
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
