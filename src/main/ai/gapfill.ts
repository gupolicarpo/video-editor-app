import { join } from 'path'
import { tmpdir } from 'os'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { createHmac } from 'crypto'
import { spawn } from 'child_process'
import { app } from 'electron'
import { loadSettings } from '../settings'

// AI "gap fill" — generate the missing bridge between two cuts using the LAST
// frame of clip A and the FIRST frame of clip B as first/last frames. Provider
// is the user's choice: Kling (real faces OK) or Seedance (blocks real faces).

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
type StatusFn = (s: { stage: string; message: string }) => void
type KlingTaskResponse = {
  data?: {
    task_status?: string
    task_result?: { videos?: Array<{ url?: string }> }
  }
}
type SeedanceTaskResponse = {
  status?: string
  content?: { video_url?: string }
  error?: unknown
}

export interface GapFillPayload {
  aPath: string
  aTime: number // timestamp of clip A's last frame (source time)
  bPath: string
  bTime: number // timestamp of clip B's first frame (source time)
  prompt: string
  provider: 'kling' | 'seedance'
  model?: string
  durationSec?: number
}

function mediaDir(): string {
  const s = loadSettings()
  const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

function extractFrame(src: string, time: number, out: string): Promise<string> {
  const args = ['-y', '-ss', Math.max(0, time).toFixed(3), '-i', src, '-frames:v', '1', '-q:v', '2', out]
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args)
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err.slice(-600)))))
  })
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Kling developer API uses a short-lived HS256 JWT (iss=accessKey) signed with the secret.
function klingJwt(accessKey: string, secretKey: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }))
  const sig = b64url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

async function runKling(
  frameA: string,
  frameB: string,
  payload: GapFillPayload,
  onStatus: StatusFn
): Promise<string> {
  const s = loadSettings()
  if (!s.klingAccessKey || !s.klingSecretKey) throw new Error('Configure Access Key e Secret do Kling em Configurações.')
  const token = klingJwt(s.klingAccessKey, s.klingSecretKey)
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const body = {
    // kling-v2-6 is the newest model that supports image_tail (last frame), in all modes.
    model_name: payload.model || 'kling-v2-6',
    mode: 'pro', // Pro = best quality; image_tail needs Pro on older models, all modes on v2-6.
    duration: (payload.durationSec ?? 5) > 5 ? '10' : '5',
    prompt: payload.prompt || '',
    image: readFileSync(frameA).toString('base64'),
    image_tail: readFileSync(frameB).toString('base64')
  }
  onStatus({ stage: 'submit', message: 'Enviando para o Kling…' })
  const r = await fetch('https://api.klingai.com/v1/videos/image2video', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body)
  })
  const txt = await r.text()
  if (!r.ok) throw new Error(`Kling HTTP ${r.status}: ${txt.slice(0, 400)}`)
  const taskId = JSON.parse(txt)?.data?.task_id
  if (!taskId) throw new Error('Kling sem task_id: ' + txt.slice(0, 200))
  for (let i = 0; i < 180; i++) {
    await sleep(5000)
    const tk = klingJwt(s.klingAccessKey, s.klingSecretKey)
    const st = (await (
      await fetch(`https://api.klingai.com/v1/videos/image2video/${taskId}`, {
        headers: { Authorization: `Bearer ${tk}` }
      })
    ).json()) as KlingTaskResponse
    const status = st?.data?.task_status
    onStatus({ stage: 'poll', message: `Kling: ${status || 'processando'}…` })
    if (status === 'succeed') {
      const url = st?.data?.task_result?.videos?.[0]?.url
      if (!url) throw new Error('Kling concluído sem URL.')
      return url
    }
    if (status === 'failed') throw new Error('Kling falhou: ' + JSON.stringify(st?.data).slice(0, 300))
  }
  throw new Error('Kling: tempo limite excedido.')
}

async function runSeedance(
  frameA: string,
  frameB: string,
  payload: GapFillPayload,
  onStatus: StatusFn
): Promise<string> {
  const s = loadSettings()
  if (!s.seedanceApiKey) throw new Error('Configure a API key do Seedance em Configurações.')
  const base = s.seedanceBaseUrl.replace(/\/$/, '')
  const dataUri = (p: string): string => `data:image/jpeg;base64,${readFileSync(p).toString('base64')}`
  const body = {
    model: payload.model || s.seedanceModel,
    content: [
      { type: 'text', text: payload.prompt || 'Smoothly connect the two shots.' },
      { type: 'image_url', role: 'first_frame', image_url: { url: dataUri(frameA) } },
      { type: 'image_url', role: 'last_frame', image_url: { url: dataUri(frameB) } }
    ],
    duration: payload.durationSec ?? 5,
    resolution: '1080p'
  }
  onStatus({ stage: 'submit', message: 'Enviando para o Seedance…' })
  const r = await fetch(`${base}/contents/generations/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.seedanceApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const txt = await r.text()
  if (!r.ok) throw new Error(`Seedance HTTP ${r.status}: ${txt.slice(0, 400)}`)
  const id = JSON.parse(txt)?.id
  if (!id) throw new Error('Seedance sem id: ' + txt.slice(0, 200))
  for (let i = 0; i < 180; i++) {
    await sleep(5000)
    const st = (await (
      await fetch(`${base}/contents/generations/tasks/${id}`, {
        headers: { Authorization: `Bearer ${s.seedanceApiKey}` }
      })
    ).json()) as SeedanceTaskResponse
    const status = st?.status
    onStatus({ stage: 'poll', message: `Seedance: ${status || 'processando'}…` })
    if (status === 'succeeded') {
      const url = st?.content?.video_url
      if (!url) throw new Error('Seedance concluído sem URL.')
      return url
    }
    if (status === 'failed') throw new Error('Seedance falhou: ' + JSON.stringify(st?.error || st).slice(0, 300))
  }
  throw new Error('Seedance: tempo limite excedido.')
}

export async function gapFill(
  payload: GapFillPayload,
  onStatus: StatusFn
): Promise<{ ok: boolean; mediaPath?: string; error?: string }> {
  const tmp: string[] = []
  try {
    onStatus({ stage: 'prepare', message: 'Extraindo os frames de conexão…' })
    const stamp = Date.now()
    const frameA = join(tmpdir(), `gap-a-${stamp}.jpg`)
    const frameB = join(tmpdir(), `gap-b-${stamp}.jpg`)
    await extractFrame(payload.aPath, payload.aTime, frameA)
    await extractFrame(payload.bPath, payload.bTime, frameB)
    tmp.push(frameA, frameB)

    const url =
      payload.provider === 'seedance'
        ? await runSeedance(frameA, frameB, payload, onStatus)
        : await runKling(frameA, frameB, payload, onStatus)

    onStatus({ stage: 'download', message: 'Baixando o trecho gerado…' })
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    const out = join(mediaDir(), `gapfill-${payload.provider}-${stamp}.mp4`)
    writeFileSync(out, buf)
    return { ok: true, mediaPath: out }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  } finally {
    for (const f of tmp) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
  }
}
