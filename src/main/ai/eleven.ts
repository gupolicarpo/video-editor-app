import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegBin } from '../ffmpeg'
import { loadSettings } from '../settings'

/**
 * ElevenLabs Audio Isolation ("Voice Isolator"): removes background noise by
 * re-synthesizing the voice stem. Far beyond what an ffmpeg denoise filter can
 * do — this is the quality bar the user pointed at, so we call the real thing
 * with their key instead of imitating it.
 *
 * Billing note: charged per minute of audio on the user's ElevenLabs account,
 * so the UI shows the clip duration on the button — no hidden spend.
 */

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ['-y', '-v', 'error', ...args], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('error', reject)
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-400) || `ffmpeg ${c}`))))
  })
}

/** Remaining credits on the user's own subscription — same pool the site uses. */
export async function elevenBalance(): Promise<{ ok: boolean; remaining?: number; limit?: number; error?: string }> {
  const key = loadSettings().elevenApiKey
  if (!key) return { ok: false, error: 'sem chave' }
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key }
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = (await res.json()) as { character_count: number; character_limit: number }
    return { ok: true, remaining: j.character_limit - j.character_count, limit: j.character_limit }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export interface IsolatePayload {
  path: string
  inPoint: number
  duration: number
  isVideo: boolean
  outDir: string
}

export interface IsolateResult {
  ok: boolean
  mediaPath?: string
  error?: string
}

function log(line: string): void {
  try {
    const { appendFileSync } = require('fs')
    const { app } = require('electron')
    appendFileSync(join(app.getPath('userData'), 'eleven-debug.log'), `${new Date().toISOString()} ${line}
`)
  } catch {
    /* logging must never break the feature */
  }
}

export async function elevenIsolate(payload: IsolatePayload): Promise<IsolateResult> {
  log(`--- isolate: path=${payload.path} in=${payload.inPoint} dur=${payload.duration} video=${payload.isVideo}`)
  const s = loadSettings()
  const key = s.elevenApiKey
  if (!key) {
    log('ABORT: sem chave')
    return { ok: false, error: 'Configure a API key do ElevenLabs em ⚙ Configurações.' }
  }
  log(`chave presente (${key.length} chars)`)

  const stamp = Date.now()
  const segWav = join(tmpdir(), `vedit-el-${stamp}.wav`)
  const cleanMp3 = join(tmpdir(), `vedit-el-${stamp}-clean.mp3`)
  const tempFiles = [segWav, cleanMp3]

  try {
    // 1. Extract exactly the clip's audio segment.
    await ff([
      '-ss', payload.inPoint.toFixed(3),
      '-t', payload.duration.toFixed(3),
      '-i', payload.path,
      '-vn', '-ac', '2', '-ar', '44100',
      segWav
    ])

    log(`wav extraido: ${existsSync(segWav) ? statSync(segWav).size + ' bytes' : 'FALHOU'}`)

    // 2. Send to ElevenLabs audio isolation.
    const form = new FormData()
    form.append('audio', new Blob([readFileSync(segWav)], { type: 'audio/wav' }), 'clip.wav')
    const res = await fetch('https://api.elevenlabs.io/v1/audio-isolation', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form
    })
    log(`resposta HTTP ${res.status} ${res.statusText} ct=${res.headers.get('content-type')}`)
    if (!res.ok) {
      const body = await res.text()
      log(`ERRO corpo: ${body.slice(0, 300)}`)
      return { ok: false, error: `ElevenLabs ${res.status}: ${body.slice(0, 300)}` }
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    log(`audio limpo recebido: ${bytes.length} bytes`)
    writeFileSync(cleanMp3, bytes)

    // 3. Rebuild the clip's media with the cleaned audio.
    if (!existsSync(payload.outDir)) mkdirSync(payload.outDir, { recursive: true })
    if (payload.isVideo) {
      // Re-encode the video segment (frame-accurate cut; our short-GOP master
      // settings) and marry it to the isolated audio.
      const out = join(payload.outDir, `isolado-${stamp}.mp4`)
      await ff([
        '-ss', payload.inPoint.toFixed(3),
        '-t', payload.duration.toFixed(3),
        '-i', payload.path,
        '-i', cleanMp3,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
        '-g', '30', '-keyint_min', '30', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', '-shortest',
        out
      ])
      log(`SAIDA video: ${out} (${existsSync(out) ? statSync(out).size + ' bytes' : 'NAO CRIADO'})`)
      return { ok: true, mediaPath: out }
    }
    const out = join(payload.outDir, `isolado-${stamp}.m4a`)
    await ff(['-i', cleanMp3, '-c:a', 'aac', '-b:a', '192k', out])
    log(`SAIDA audio: ${out} (${existsSync(out) ? statSync(out).size + ' bytes' : 'NAO CRIADO'})`)
    return { ok: true, mediaPath: out }
  } catch (e) {
    log(`EXCECAO: ${(e as Error).stack ?? (e as Error).message}`)
    return { ok: false, error: (e as Error).message }
  } finally {
    for (const f of tempFiles) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* temp */
      }
    }
  }
}
