import { setPriority } from 'os'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { ffmpegBin, ffprobeBin, probeMedia } from './ffmpeg'

// Proxy de edição: cópia 720p com keyframe a cada 0,25s, usada SÓ no preview.
// A exportação continua lendo o arquivo original — nunca este.

interface EnsureCallbacks {
  onProgress: (pct: number) => void
  onDone: (path: string | null) => void
}

type EnsureResult = { status: 'ready'; path: string } | { status: 'queued' | 'skip' }

function runText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} exited ${code}`))))
  })
}

function runJson(cmd: string, args: string[]): Promise<any> {
  return runText(cmd, args).then((t) => JSON.parse(t))
}

// mesma detecção de alfa VP9/VP8 do ffmpeg.ts (detectVpxAlpha) — um proxy H.264
// apagaria a transparência de FX/matte, então esses arquivos ficam de fora.
function hasAlpha(pixFmt: string, alphaModeTag: unknown): boolean {
  return /yuva|rgba|bgra|argb|abgr|ya8|pal8/.test(pixFmt || '') || String(alphaModeTag ?? '') === '1'
}

async function keyframeInterval(src: string): Promise<number> {
  const out = await runText(ffprobeBin(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-read_intervals', '%+30',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    src
  ])
  const ks: number[] = []
  for (const line of out.split('\n')) {
    const [ptsTime, flags] = line.trim().split(',')
    if (ptsTime && flags && flags.includes('K')) {
      const t = parseFloat(ptsTime)
      if (isFinite(t)) ks.push(t)
    }
  }
  if (ks.length < 2) return Infinity
  return (ks[ks.length - 1] - ks[0]) / (ks.length - 1)
}

const jobCallbacks = new Map<string, EnsureCallbacks[]>()
let chain: Promise<void> = Promise.resolve()

// O renderer avisa quando está TOCANDO. Gerar proxy durante o play lia o
// arquivo-fonte a toda velocidade (8x tempo real) e codificava na GPU
// enquanto o preview disputava o mesmo disco: medido no registro do usuário,
// 17 proxies (1 GB) gerados em 7 minutos de edição, com o som picotando.
// A fila espera o play parar antes de cada trabalho.
let tocando = false
export function setPlaybackActive(v: boolean): void {
  tocando = v
}
async function esperarPausa(): Promise<void> {
  while (tocando) await new Promise((r) => setTimeout(r, 500))
}

export async function ensureEditProxy(src: string, cb: EnsureCallbacks): Promise<EnsureResult> {
  const st = statSync(src)
  const key = createHash('sha1')
    .update(src.toLowerCase())
    .update(String(st.size))
    .update(String(st.mtimeMs))
    .digest('hex')
  const cacheDir = join(app.getPath('userData'), 'proxies')
  mkdirSync(cacheDir, { recursive: true })
  const dst = join(cacheDir, `${key}.mp4`)

  if (existsSync(dst) && statSync(dst).size > 0) {
    return { status: 'ready', path: dst }
  }

  const probe = await runJson(ffprobeBin(), [
    '-v', 'quiet',
    '-show_entries', 'stream=codec_type,codec_name,pix_fmt,avg_frame_rate,height:stream_tags=alpha_mode',
    '-print_format', 'json',
    src
  ])
  const streams: any[] = probe.streams || []
  const vStream = streams.find((s) => s.codec_type === 'video') || {}
  const aStream = streams.find((s) => s.codec_type === 'audio')
  if (hasAlpha(vStream.pix_fmt, vStream.tags?.alpha_mode)) {
    return { status: 'skip' }
  }

  const interval = await keyframeInterval(src)
  if (interval <= 0.5) {
    return { status: 'skip' }
  }

  const list = jobCallbacks.get(dst)
  if (list) {
    list.push(cb)
    return { status: 'queued' }
  }
  jobCallbacks.set(dst, [cb])

  chain = chain.then(() => runProxyJob(src, dst, vStream, aStream))
  return { status: 'queued' }
}

async function runProxyJob(src: string, dst: string, vStream: any, aStream: any): Promise<void> {
  const callbacks = jobCallbacks.get(dst) || []
  const onProgress = (pct: number): void => callbacks.forEach((c) => c.onProgress(pct))
  try {
    await esperarPausa()
    const meta = await probeMedia(src)

    let fps = 30
    if (vStream.avg_frame_rate && vStream.avg_frame_rate !== '0/0') {
      const [n, d] = vStream.avg_frame_rate.split('/').map(Number)
      if (d) fps = n / d
    }
    const gop = Math.max(1, Math.round(fps / 4))
    const escala = (vStream.height || 0) > 720

    const audioCodec = aStream?.codec_name as string | undefined
    const audioArgs =
      audioCodec && ['aac', 'mp3', 'alac'].includes(audioCodec)
        ? ['-c:a', 'copy']
        : audioCodec
          ? ['-c:a', 'aac', '-b:a', '192k']
          : []

    const path = await writeProxyOutput(src, dst, { escala, gop, audioArgs }, meta.duration, onProgress)
    callbacks.forEach((c) => c.onDone(path))
  } catch {
    callbacks.forEach((c) => c.onDone(null))
  } finally {
    jobCallbacks.delete(dst)
  }
}

function writeProxyOutput(
  src: string,
  dst: string,
  opts: { escala: boolean; gop: number; audioArgs: string[] },
  duration: number,
  onProgress: (pct: number) => void
): Promise<string> {
  const tmp = `${dst}.${process.pid}.tmp.mp4`
  if (existsSync(tmp)) unlinkSync(tmp)

  const progArgs = duration ? ['-progress', 'pipe:1', '-nostats'] : []
  const gpuArgs = [
    ...progArgs,
    // -readrate 2: lê a fonte a no máximo 2x tempo real — deixa o disco livre
    // para o preview em vez de sugar 500 MB o mais rápido possível.
    '-y', '-v', 'error', '-readrate', '2', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', src,
    '-map', '0:v:0', '-map', '0:a?',
    ...(opts.escala ? ['-vf', 'scale_cuda=-2:720'] : []),
    '-fps_mode', 'passthrough',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '32', '-g', String(opts.gop), '-bf', '0',
    ...opts.audioArgs,
    '-movflags', '+faststart',
    tmp
  ]
  const cpuArgs = [
    ...progArgs,
    '-y', '-v', 'error', '-readrate', '2', '-i', src,
    '-map', '0:v:0', '-map', '0:a?',
    ...(opts.escala ? ['-vf', 'scale=-2:720'] : []),
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', String(opts.gop), '-bf', '0', '-pix_fmt', 'yuv420p',
    ...opts.audioArgs,
    '-movflags', '+faststart',
    tmp
  ]

  const run = (args: string[]): Promise<number> =>
    new Promise((resolve, reject) => {
      const proc = spawn(ffmpegBin(), args, { windowsHide: true })
      // prioridade mínima: o proxy nunca compete com a interface pela CPU
      try {
        if (proc.pid) setPriority(proc.pid, 19)
      } catch {
        /* sem permissão para mudar prioridade: segue normal */
      }
      if (duration) {
        let buf = ''
        proc.stdout.on('data', (d) => {
          buf += String(d)
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line.trim())
            if (m) onProgress(Number(m[1]) / 1e6 / duration)
          }
        })
      }
      proc.on('error', reject)
      proc.on('close', (code) => resolve(code ?? 1))
    })

  return (async () => {
    let code = await run(gpuArgs)
    if (code !== 0) code = await run(cpuArgs)
    if (code === 0) {
      renameSync(tmp, dst)
      return dst
    }
    if (existsSync(tmp)) unlinkSync(tmp)
    throw new Error(`proxy de edição saiu com código ${code}`)
  })()
}
