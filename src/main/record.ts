import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, createWriteStream, WriteStream } from 'fs'
import { join, basename } from 'path'
import { ffmpegBin, probeMedia } from './ffmpeg'

export interface SavedRecording {
  path: string
  duration: number
  width: number
  height: number
  hasAudio: boolean
  fps: number
}

/**
 * Persist a MediaRecorder blob and normalise it for the timeline.
 *
 * Two things are wrong with what MediaRecorder hands us, both measured:
 *
 *  1. It writes a *streaming* WebM — the duration is in no header, so ffprobe
 *     reports `duration=N/A` and the clip lands on the timeline at length 0.
 *     `-c copy` keeps the broken header; only a re-encode fixes it.
 *  2. The stream is variable-frame-rate. Re-encoded as-is, ffmpeg tags the mp4
 *     `r_frame_rate=2000/1`, which would break frame-accurate nudging and every
 *     duration calculation downstream. `-fps_mode cfr -r <fps>` pins it.
 *
 * (`-fflags +genpts` makes no difference here — the cluster timecodes are fine.
 * It was the VFR tagging all along.)
 */
export async function saveRecording(
  dir: string,
  bytes: Uint8Array,
  baseName: string,
  fps = 30,
  hasAudio = true
): Promise<SavedRecording> {
  const outDir = join(dir, 'recordings')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const raw = join(outDir, `${baseName}.webm`)
  writeFileSync(raw, bytes)
  return normalizeRecording(dir, raw, baseName, fps, hasAudio)
}

/**
 * Gravação em fluxo: cada pedaço do MediaRecorder vai para o disco assim que
 * chega, em vez de acumular na memória.
 *
 * Motivo medido: juntar tudo num Blob e chamar `arrayBuffer()` no fim falha
 * perto de 2 GB — 12 minutos de tela a 14 Mbps já bastam. A gravação inteira
 * era perdida no último segundo, com a mensagem "The requested file could not
 * be read". Gravando em fluxo não há limite de tamanho, não há transferência de
 * 2 GB por IPC, e uma queda no meio custa no máximo o último pedaço de 1s.
 */
const fluxos = new Map<string, { stream: WriteStream; raw: string; fila: Promise<void> }>()

export function openRecordingStream(dir: string, baseName: string): string {
  const outDir = join(dir, 'recordings')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const raw = join(outDir, `${baseName}.webm`)
  const id = `${baseName}-${Date.now()}`
  fluxos.set(id, { stream: createWriteStream(raw), raw, fila: Promise.resolve() })
  return id
}

export function writeRecordingChunk(id: string, bytes: Uint8Array): boolean {
  const f = fluxos.get(id)
  if (!f) return false
  // enfileira: os pedaços têm de chegar ao arquivo na ordem em que saíram
  f.fila = f.fila.then(
    () =>
      new Promise<void>((resolve, reject) => {
        f.stream.write(bytes, (err) => (err ? reject(err) : resolve()))
      })
  )
  return true
}

export async function closeRecordingStream(
  dir: string,
  id: string,
  fps = 30,
  hasAudio = true
): Promise<SavedRecording> {
  const f = fluxos.get(id)
  if (!f) throw new Error('Gravação não encontrada: ' + id)
  await f.fila
  await new Promise<void>((resolve) => f.stream.end(() => resolve()))
  fluxos.delete(id)
  const baseName = basename(f.raw, '.webm')
  return normalizeRecording(dir, f.raw, baseName, fps, hasAudio)
}

/** Fecha o arquivo sem normalizar — usado quando a normalização falha, para o
 *  .webm cru continuar no disco em vez de sumir. */
export async function abortRecordingStream(id: string): Promise<string | null> {
  const f = fluxos.get(id)
  if (!f) return null
  try { await f.fila } catch { /* o que deu para gravar já está no arquivo */ }
  await new Promise<void>((resolve) => f.stream.end(() => resolve()))
  fluxos.delete(id)
  return f.raw
}

async function normalizeRecording(
  dir: string,
  raw: string,
  baseName: string,
  fps = 30,
  hasAudio = true
): Promise<SavedRecording> {
  const outDir = join(dir, 'recordings')
  const out = join(outDir, `${baseName}.mp4`)

  await new Promise<void>((resolve, reject) => {
    const r = String(Math.round(fps) || 30)
    // The webcam stops delivering frames slightly before the microphone stops —
    // measured 0.586 s on a C920, so the video track ended early and the last
    // frame froze while the speaker was still talking. `tpad` clones the final
    // frame to cover the gap and `-shortest` trims it back to the audio.
    const mapping = hasAudio
      ? [
          '-filter_complex', `[0:v]fps=${r},tpad=stop_mode=clone:stop_duration=5[v]`,
          '-map', '[v]', '-map', '0:a',
          '-shortest'
        ]
      : ['-vf', `fps=${r}`]

    const args = [
      '-y',
      '-i', raw,
      ...mapping,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '17', // near-lossless: this is the master, not the delivery
      // Editing master: keyframe every second. x264's default GOP (~250) put
      // keyframes ~5.7s apart, so every timeline seek decoded up to 170 frames —
      // scrubbing felt broken and drift-seeks stalled playback.
      '-g', '30',
      '-keyint_min', '30',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      out
    ]
    const p = spawn(ffmpegBin(), args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com ${code}: ${err.slice(-400)}`))
    )
  })

  try {
    unlinkSync(raw)
  } catch {
    /* o webm bruto é descartável */
  }

  const meta = await probeMedia(out)
  return {
    path: out,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    hasAudio: meta.hasAudio,
    fps: meta.fps
  }
}
