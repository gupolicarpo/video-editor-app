import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createHmac } from 'crypto'
import { app } from 'electron'
import { loadSettings } from '../settings'

// General Kling developer-API generation: text→video, image→video (first frame),
// and first+last-frame interpolation. Model / mode / duration are the caller's choice.

type StatusFn = (s: { stage: string; message: string }) => void
type KlingTaskResponse = {
  data?: {
    task_status?: string
    task_result?: { videos?: Array<{ url?: string }> }
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface KlingGenPayload {
  type: 't2v' | 'i2v' | 'i2v_tail'
  model: string
  mode: 'std' | 'pro'
  duration: number
  prompt?: string
  imagePath?: string
  tailPath?: string
  aspectRatio?: string
}

function mediaDir(): string {
  const s = loadSettings()
  const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function klingJwt(accessKey: string, secretKey: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }))
  const sig = b64url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

export async function klingGenerate(
  payload: KlingGenPayload,
  onStatus: StatusFn
): Promise<{ ok: boolean; mediaPath?: string; error?: string }> {
  const s = loadSettings()
  if (!s.klingAccessKey || !s.klingSecretKey)
    return { ok: false, error: 'Configure Access Key e Secret do Kling em Configurações.' }
  try {
    const auth = (): Record<string, string> => ({ Authorization: `Bearer ${klingJwt(s.klingAccessKey, s.klingSecretKey)}` })
    const duration = (payload.duration ?? 5) > 5 ? '10' : '5'
    let endpoint: string
    const body: Record<string, unknown> = { model_name: payload.model, mode: payload.mode, duration }
    if (payload.type === 't2v') {
      endpoint = 'text2video'
      body.prompt = payload.prompt || ''
      body.aspect_ratio = payload.aspectRatio || '16:9'
    } else {
      endpoint = 'image2video'
      if (!payload.imagePath) throw new Error('Escolha a imagem inicial.')
      body.prompt = payload.prompt || ''
      body.image = readFileSync(payload.imagePath).toString('base64')
      if (payload.type === 'i2v_tail') {
        if (!payload.tailPath) throw new Error('Escolha a imagem final (last frame).')
        body.image_tail = readFileSync(payload.tailPath).toString('base64')
      }
    }

    onStatus({ stage: 'submit', message: 'Enviando para o Kling…' })
    const r = await fetch(`https://api.klingai.com/v1/videos/${endpoint}`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const txt = await r.text()
    if (!r.ok) throw new Error(`Kling HTTP ${r.status}: ${txt.slice(0, 400)}`)
    const taskId = JSON.parse(txt)?.data?.task_id
    if (!taskId) throw new Error('Kling sem task_id: ' + txt.slice(0, 200))

    for (let i = 0; i < 200; i++) {
      await sleep(5000)
      const st = (await (
        await fetch(`https://api.klingai.com/v1/videos/${endpoint}/${taskId}`, { headers: auth() })
      ).json()) as KlingTaskResponse
      const status = st?.data?.task_status
      onStatus({ stage: 'poll', message: `Kling: ${status || 'processando'}…` })
      if (status === 'succeed') {
        const url = st?.data?.task_result?.videos?.[0]?.url
        if (!url) throw new Error('Kling concluído sem URL.')
        onStatus({ stage: 'download', message: 'Baixando…' })
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
        const out = join(mediaDir(), `kling-${payload.type}-${Date.now()}.mp4`)
        writeFileSync(out, buf)
        return { ok: true, mediaPath: out }
      }
      if (status === 'failed') throw new Error('Kling falhou: ' + JSON.stringify(st?.data).slice(0, 300))
    }
    throw new Error('Kling: tempo limite excedido.')
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
