import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getLook, lookFfmpeg } from '../shared/looks'

// Binary resolution order: explicit env override → bundled copy shipped with
// the installer (resources/ffmpeg/, Electron only) → system PATH.
// This module stays Electron-free (the MCP reuses it), so resourcesPath is
// probed dynamically instead of importing from 'electron'.
function resolveBin(envVar: string, name: string): string {
  if (process.env[envVar]) return process.env[envVar] as string
  const res = (process as { resourcesPath?: string }).resourcesPath
  if (res) {
    // Only Windows binaries carry an extension; on macOS/Linux the bundled
    // file is plain `ffmpeg`. Both are probed so one build config covers all.
    const names = process.platform === 'win32' ? [`${name}.exe`] : [name, `${name}.exe`]
    for (const n of names) {
      const bundled = join(res, 'ffmpeg', n)
      if (existsSync(bundled)) return bundled
    }
  }
  return name
}
const FFMPEG = resolveBin('FFMPEG_PATH', 'ffmpeg')

/** The resolved ffmpeg binary, for modules that spawn their own passes. */
export function ffmpegBin(): string {
  return FFMPEG
}

// ---- render process control (cancellation + hardware encoding) ----
let currentRender: import('child_process').ChildProcess | null = null
let renderCancelled = false

// Kill the export in flight (if any). The close handler reports "cancelled".
export function cancelRender(): boolean {
  if (currentRender) {
    renderCancelled = true
    try {
      currentRender.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    return true
  }
  return false
}

// Name of this platform's hardware H.264 encoder: NVENC on Windows/Linux with
// an NVIDIA card, VideoToolbox on macOS (every Mac has it, Intel and Apple
// Silicon alike). Falls back to libx264 when neither is compiled in.
export const HW_ENCODER = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc'

// Hardware encoder available? (cached; falls back to libx264 at runtime too)
let nvencCached: boolean | null = null
function hasNvenc(): Promise<boolean> {
  if (nvencCached !== null) return Promise.resolve(nvencCached)
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-encoders'])
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('error', () => {
      nvencCached = false
      resolve(false)
    })
    p.on('close', () => {
      nvencCached = out.includes(HW_ENCODER)
      resolve(nvencCached)
    })
  })
}
const FFPROBE = resolveBin('FFPROBE_PATH', 'ffprobe')

export interface MediaMeta {
  path: string
  type: 'video' | 'audio' | 'image'
  duration: number
  width: number
  height: number
  hasAudio: boolean
  hasVideo: boolean
  fps: number
  audioStreamCount: number
}

export interface PreparedMediaMeta extends MediaMeta {
  // Multi-track recordings get a small audio-only proxy containing every
  // embedded stream. The original video is never modified.
  audioPath: string | null
  // Individual proxies preserve each embedded stream for "Separar áudio".
  audioPaths: string[] | null
}

// ---- Auto-grade: measure the clip, then correct it conservatively ----
// Adapted from browser-use/video-use (MIT). The philosophy that makes this
// work: measure, then apply a *bounded* correction (±8%) with no colour shift.
// Goal is "clean, not graded" — fixes underexposure/flatness, never stylises.

export interface ClipStats {
  yMean: number // 0..1 average luma
  yRange: number // 0..1 spread between the 10th/90th luma percentiles
  satMean: number // 0..1 average saturation
}

export interface AutoGrade {
  brightness: number // -1..1 (our eq/CSS param; approximates a gamma lift)
  contrast: number // 0..2
  saturation: number // 0..3
  stats: ClipStats
}

// Sample ~10 frames across the range and average signalstats metadata.
export function analyzeClipStats(srcPath: string, start: number, duration: number): Promise<ClipStats> {
  const dur = Math.max(0.1, duration)
  const fps = Math.max(0.5, Math.min(10 / dur, 10))
  const args = [
    '-hide_banner', '-nostats', '-v', 'error',
    '-ss', start.toFixed(3),
    '-i', srcPath,
    '-t', dur.toFixed(3),
    '-vf', `fps=${fps.toFixed(2)},signalstats,metadata=print:file=-`,
    '-f', 'null', '-'
  ]
  return new Promise((resolve) => {
    const neutral: ClipStats = { yMean: 0.5, yRange: 0.7, satMean: 0.25 }
    const p = spawn(FFMPEG, args)
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('error', () => resolve(neutral))
    p.on('close', () => {
      const grab = (key: string): number[] =>
        [...out.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`, 'g'))].map((m) => parseFloat(m[1]))
      const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
      const depth = grab('YBITDEPTH')[0] || 8
      const maxVal = Math.pow(2, depth) - 1
      const yAvg = avg(grab('YAVG'))
      if (yAvg === null) return resolve(neutral)
      // Prefer the 10th/90th percentiles (YLOW/YHIGH) over YMIN/YMAX: a single
      // crushed-black or blown-out pixel would otherwise pin the range to 1.0
      // and hide the fact that the image is actually flat.
      const yLow = avg(grab('YLOW'))
      const yHigh = avg(grab('YHIGH'))
      const yRange =
        yLow !== null && yHigh !== null
          ? (yHigh - yLow) / maxVal
          : ((avg(grab('YMAX')) ?? maxVal * 0.7) - (avg(grab('YMIN')) ?? 0)) / maxVal
      const sat = avg(grab('SATAVG'))
      resolve({
        yMean: yAvg / maxVal,
        yRange,
        satMean: sat !== null ? sat / maxVal : 0.25
      })
    })
  })
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// Anti-pop fade applied to every audio clip edge that has no user fade.
const MICRO_FADE = 0.03

// Turn measured stats into a gentle correction. Never desaturates hard, never
// shifts hue, everything clamped. `brightness` stands in for a gamma lift so
// preview (CSS filter) and export (eq) stay pixel-consistent.
export function autoGradeFromStats(stats: ClipStats): AutoGrade {
  // Contrast: target range ≈ 0.72. Boost gently if flat; never reduce.
  let contrast = 1.03
  if (stats.yRange < 0.65) {
    const t = clamp((stats.yRange - 0.5) / 0.15, 0, 1)
    contrast = 1.08 - 0.05 * t
  }

  // Exposure: target mean ≈ 0.48. Lift if dark, tiny pullback if hot.
  let gamma = 1.0
  if (stats.yMean < 0.42) {
    const t = clamp((stats.yMean - 0.3) / 0.12, 0, 1)
    gamma = 1.1 - 0.08 * t
  } else if (stats.yMean > 0.6) {
    gamma = 0.97
  }

  // Saturation: most consumer video is a touch hot → default tiny pullback.
  let saturation = 0.98
  if (stats.satMean < 0.18) saturation = 1.04
  else if (stats.satMean > 0.38) saturation = 0.96

  return {
    brightness: clamp((gamma - 1) * 0.35, -0.06, 0.06),
    contrast: clamp(contrast, 0.94, 1.08),
    saturation: clamp(saturation, 0.94, 1.06),
    stats
  }
}

export async function autoGradeClip(srcPath: string, inPoint: number, duration: number): Promise<AutoGrade> {
  return autoGradeFromStats(await analyzeClipStats(srcPath, inPoint, duration))
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']

export async function probeMedia(filePath: string): Promise<MediaMeta> {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  const json = await runJson(FFPROBE, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ])

  const streams: any[] = json.streams || []
  const vStream = streams.find((s) => s.codec_type === 'video')
  const audioStreams = streams.filter((s) => s.codec_type === 'audio')
  const aStream = audioStreams[0]
  const isImage = IMAGE_EXT.includes(ext) || (vStream && (json.format?.format_name || '').includes('image2'))

  let duration = parseFloat(json.format?.duration ?? '0')
  // A still has no intrinsic duration. A PNG reports N/A → we'd default to 5.
  // But a JPG is decoded as a 1-frame mjpeg and reports a bogus ~0.04s, which
  // would place a sliver-thin clip that can't be grabbed to stretch. Force every
  // image to the still default regardless of what the container claims.
  if (isImage) duration = 5
  else if (!isFinite(duration) || duration <= 0) duration = 0

  let fps = 30
  if (vStream?.r_frame_rate && vStream.r_frame_rate !== '0/0') {
    const [n, d] = vStream.r_frame_rate.split('/').map(Number)
    if (d) fps = n / d
  }

  const type: MediaMeta['type'] = isImage ? 'image' : vStream ? 'video' : 'audio'

  return {
    path: filePath,
    type,
    duration,
    width: vStream?.width ?? 0,
    height: vStream?.height ?? 0,
    hasAudio: !!aStream && !isImage,
    hasVideo: !!vStream,
    fps: Math.round(fps * 1000) / 1000,
    audioStreamCount: isImage ? 0 : audioStreams.length
  }
}

const audioJobs = new Map<string, Promise<string>>()

/**
 * Prepare a browser-friendly audio stream for recordings that contain several
 * embedded tracks (commonly game audio + microphone). Chromium otherwise picks
 * only the first track, which may be silent. All tracks are mixed; the source
 * video remains untouched and the small AAC result is cached by file identity.
 */
export async function prepareMedia(
  filePath: string,
  cacheDir: string,
  onProgress?: (pct: number, stage: string) => void
): Promise<PreparedMediaMeta> {
  const meta = await probeMedia(filePath)
  if (meta.type !== 'video' || meta.audioStreamCount <= 1) {
    return { ...meta, audioPath: null, audioPaths: null }
  }
  // Extracting audio from a long video is minutes of ffmpeg with no UI signal —
  // it read as a frozen app. Report real progress: one mix pass plus one pass
  // per embedded stream, each weighted equally across 0..1.
  const passes = 1 + meta.audioStreamCount
  let done = 0
  const passProgress = (stage: string) => (p: number) =>
    onProgress?.((done + Math.min(1, Math.max(0, p))) / passes, stage)

  mkdirSync(cacheDir, { recursive: true })
  const st = statSync(filePath)
  const key = createHash('sha1')
    .update(filePath.toLowerCase())
    .update(String(st.size))
    .update(String(st.mtimeMs))
    .digest('hex')
  const outputPath = join(cacheDir, `${key}.m4a`)
  const audioPath = await ensureAudioOutput(outputPath, () =>
    mixAudioStreams(filePath, meta.audioStreamCount, outputPath, meta.duration, passProgress('misturando áudio'))
  )
  done += 1
  const audioPaths: string[] = []
  for (let i = 0; i < meta.audioStreamCount; i++) {
    const trackPath = join(cacheDir, `${key}-track-${i + 1}.m4a`)
    audioPaths.push(
      await ensureAudioOutput(trackPath, () =>
        extractAudioStream(filePath, i, trackPath, meta.duration, passProgress(`trilha ${i + 1}/${meta.audioStreamCount}`))
      )
    )
    done += 1
  }
  onProgress?.(1, 'pronto')
  return { ...meta, audioPath, audioPaths }
}

function ensureAudioOutput(outputPath: string, create: () => Promise<string>): Promise<string> {
  if (existsSync(outputPath) && statSync(outputPath).size > 0) return Promise.resolve(outputPath)
  if (existsSync(outputPath)) unlinkSync(outputPath)
  let job = audioJobs.get(outputPath)
  if (!job) {
    job = create()
    audioJobs.set(outputPath, job)
    void job.then(
      () => audioJobs.delete(outputPath),
      () => audioJobs.delete(outputPath)
    )
  }
  return job
}

function mixAudioStreams(
  filePath: string,
  count: number,
  outputPath: string,
  duration?: number,
  onProgress?: (p: number) => void
): Promise<string> {
  const inputs = Array.from({ length: count }, (_, i) => `[0:a:${i}]`).join('')
  const filter =
    `${inputs}amix=inputs=${count}:duration=longest:dropout_transition=0:normalize=0,` +
    'alimiter=limit=0.95:latency=1[aout]'

  return writeAudioOutput(outputPath, [
    '-y', '-hide_banner', '-v', 'error', '-i', filePath,
    '-filter_complex', filter, '-map', '[aout]', '-vn', '-c:a', 'aac', '-b:a', '256k'
  ], duration, onProgress)
}

function extractAudioStream(
  filePath: string,
  streamIndex: number,
  outputPath: string,
  duration?: number,
  onProgress?: (p: number) => void
): Promise<string> {
  return writeAudioOutput(outputPath, [
    '-y', '-hide_banner', '-v', 'error', '-i', filePath,
    '-map', `0:a:${streamIndex}`, '-vn', '-c:a', 'aac', '-b:a', '192k'
  ], duration, onProgress)
}

function writeAudioOutput(
  outputPath: string,
  args: string[],
  duration?: number,
  onProgress?: (p: number) => void
): Promise<string> {
  const tmp = `${outputPath}.${process.pid}.tmp.m4a`
  if (existsSync(tmp)) unlinkSync(tmp)

  // `-progress pipe:1` streams `out_time_us=…` lines we can turn into a real
  // percentage, instead of leaving the user staring at a dead window.
  const progArgs = onProgress && duration ? ['-progress', 'pipe:1', '-nostats'] : []

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [...progArgs, ...args, tmp])
    let error = ''
    if (onProgress && duration) {
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
    proc.stderr.on('data', (d) => (error += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        renameSync(tmp, outputPath)
        resolve(outputPath)
      } else {
        if (existsSync(tmp)) unlinkSync(tmp)
        reject(new Error(error.slice(-1200) || `ffmpeg saiu com código ${code}`))
      }
    })
  })
}

// ---- Timeline render ------------------------------------------------------

export interface RenderClip {
  id: string
  mediaPath: string
  audioPath?: string | null
  type: 'video' | 'audio' | 'image'
  trackOrder: number // higher = on top
  start: number // timeline position (s)
  duration: number // length on timeline (s)
  inPoint: number // trim start within source (s)
  volume: number // 0..n
  pan?: number // -1..1, 0/undefined = center
  hasAudio: boolean
  // transform (fraction of canvas); default full-frame
  scale: number // 1 = fit
  xFrac: number // 0 = centered offset baseline; px offset = xFrac*width
  yFrac: number
  rotate?: number // giro fixo em graus, somado ao giro das animacoes
  opacity: number // 0..1
  fit: 'contain' | 'cover' | 'fill'
  speed: number // 1 = normal
  fadeIn: number // seconds
  fadeOut: number // seconds
  brightness: number // -1..1
  contrast: number // 0..2
  saturation: number // 0..3
  look?: string // named colour look, see src/shared/looks.ts
  duck: boolean
  transition?: { type: string; duration: number }
  effects?: Array<{ type: string; at: number; duration: number; amount: number }>
  // element animations (entrance / loop / exit) — mirrors the renderer's ClipAnim
  anim?: {
    in?: string
    inDur?: number
    inDir?: string
    loop?: string
    loopSpeed?: number
    out?: string
    outDur?: number
    outDir?: string
  }
  // shape mask — mirrors the renderer's MaskShape
  mask?: 'none' | 'circle' | 'ellipse' | 'roundrect'
}

/**
 * Shape mask as an alpha `geq`, in the clip's own box coordinates (cw×ch).
 * Kept pixel-consistent with the CSS clip-path in masks.ts:
 *   - circle  → inscribed (radius = min(cw,ch)/2), matching CSS `closest-side`
 *   - ellipse → fills the box, matching CSS `ellipse(50% 50%)`
 *   - roundrect → 25% corner radius per axis, matching CSS `inset(0 round 25%)`
 * A ~1px feather (smoothstep on the signed distance) anti-aliases the edge, so
 * it doesn't stair-step like the raw threshold prototype did.
 */
function maskChain(shape: RenderClip['mask'], cw: number, ch: number): string {
  if (!shape || shape === 'none') return ''
  const hx = (cw / 2).toFixed(2)
  const hy = (ch / 2).toFixed(2)
  let d: string // signed distance: <=1 inside, 1 = edge
  if (shape === 'ellipse') {
    d = `hypot((X-${hx})/${hx}\\,(Y-${hy})/${hy})`
  } else if (shape === 'circle') {
    const r = (Math.min(cw, ch) / 2).toFixed(2)
    d = `hypot(X-${hx}\\,Y-${hy})/${r}`
  } else {
    // rounded rectangle: distance to the rounded corner region
    const rx = (cw * 0.25).toFixed(2)
    const ry = (ch * 0.25).toFixed(2)
    const dx = `max(abs(X-${hx})-(${hx}-${rx})\\,0)/${rx}`
    const dy = `max(abs(Y-${hy})-(${hy}-${ry})\\,0)/${ry}`
    d = `hypot(${dx}\\,${dy})`
  }
  // feather ≈ 1px expressed in the same normalized units as d
  const feat = shape === 'circle' ? 2 / Math.min(cw, ch) : 2 / Math.min(cw, ch)
  const aExpr = `clip(255*(1-(${d}-1)/${feat.toFixed(5)})\\,0\\,255)`
  return `,format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${aExpr}'`
}

// Bake motion/focus effects into a clip's filter chain. `t` here is timeline
// time (effects run after setpts has offset the clip to its start). cw/ch = box size.
function effectsFilters(
  effects: RenderClip['effects'],
  cw: number,
  ch: number,
  start: number
): string {
  if (!effects || effects.length === 0) return ''
  const z: string[] = []
  const sx: string[] = []
  const sy: string[] = []
  const rot: string[] = []
  let needsRoom = false
  let vignetteAmt = 0
  let blur = ''
  let bw = ''
  for (const e of effects) {
    const st = (start + e.at).toFixed(3)
    const dur = Math.max(0.05, e.duration)
    const durS = dur.toFixed(3)
    const end = (start + e.at + dur).toFixed(3)
    const a = e.amount
    const gate = `between(t\\,${st}\\,${end})`
    const ramp = `clip((t-${st})/${durS}\\,0\\,1)`
    switch (e.type) {
      case 'zoompunch':
        z.push(`(1+${a.toFixed(3)}*sin(${ramp}*PI))`)
        break
      case 'kenburns':
        z.push(`(1+${a.toFixed(3)}*${ramp})`)
        break
      case 'snapzoom':
        z.push(`(1+${a.toFixed(3)}*clip((t-${st})/0.12\\,0\\,1)*clip((${end}-t)/0.12\\,0\\,1))`)
        break
      case 'breathe':
        z.push(`(1+${a.toFixed(3)}*(0.5-0.5*cos((t-${st})*2*PI/3))*${gate})`)
        break
      case 'shake':
        needsRoom = true
        sx.push(`${a.toFixed(2)}*sin(t*47)*${gate}`)
        sy.push(`${a.toFixed(2)}*cos(t*61)*${gate}`)
        break
      case 'panright':
        needsRoom = true
        sx.push(`${a.toFixed(2)}*${ramp}*${gate}`)
        break
      case 'panleft':
        needsRoom = true
        sx.push(`-${a.toFixed(2)}*${ramp}*${gate}`)
        break
      case 'panup':
        needsRoom = true
        sy.push(`-${a.toFixed(2)}*${ramp}*${gate}`)
        break
      case 'pandown':
        needsRoom = true
        sy.push(`${a.toFixed(2)}*${ramp}*${gate}`)
        break
      case 'tilt':
        needsRoom = true
        rot.push(`${a.toFixed(2)}*PI/180*sin(${ramp}*PI)`)
        break
      case 'vignette':
        vignetteAmt = Math.max(vignetteAmt, a)
        break
      case 'blur':
        blur += `,gblur=sigma=${a.toFixed(2)}:enable='${gate}'`
        break
      case 'bw':
        bw += `,hue=s=0:enable='${gate}'`
        break
    }
  }
  if (needsRoom) z.push('1.08') // crop room for shake/pan/tilt
  let chain = ''
  if (z.length || needsRoom || rot.length) {
    const zexpr = z.length ? z.join('*') : '1'
    const sxe = sx.length ? sx.join('+') : '0'
    const sye = sy.length ? sy.join('+') : '0'
    chain += `,scale=w='${cw}*(${zexpr})':h='${ch}*(${zexpr})':eval=frame`
    if (rot.length) chain += `,rotate=a='${rot.join('+')}':ow=iw:oh=ih:c=black@0`
    // The crop offset is derived from the zoom expression itself, NOT from
    // `iw`/`ih`. crop resolves those once at configuration time, while
    // `scale=eval=frame` keeps changing the frame size — so `(iw-cw)/2` stayed
    // frozen at the FIRST frame's size, which is zoom=1, i.e. x=0. Every zoom
    // then cropped from the left edge instead of the centre: measured 155px of
    // drift at the peak of a 0.18 zoom punch, and it grew with the zoom amount.
    // `cw*(z-1)/2` is the same centre offset expressed in terms already known
    // per frame. Verified with a centred marker: worst deviation 1.3px (pixel
    // rounding) across the whole punch, versus 155px before.
    chain += `,crop=${cw}:${ch}:x='${cw}*((${zexpr})-1)/2+(${sxe})':y='${ch}*((${zexpr})-1)/2+(${sye})'`
  }
  if (vignetteAmt > 0) chain += `,vignette=angle=${(0.5 + vignetteAmt * 0.9).toFixed(3)}`
  chain += blur
  chain += bw
  return chain
}

// Bake element animations (in / loop / out) into ffmpeg expressions, mirroring
// the renderer's computeAnim() exactly, so that the preview *is* the export.
//
// Channels:
//   scale  → scale=eval=frame (separate X/Y so `grow`/`flip` can squash one axis)
//   rotate → rotate, preceded by a sqrt(2) transparent pad so corners survive
//   move   → added to the overlay x/y expressions (px, via the layer's own w/h)
//   fade   → fade=alpha
//   wipe   → geq alpha mask (a reveal; the layer never moves)
//
// The easings are deliberately closed-form (no piecewise CSS bounce) so the
// same formula can be written as a single ffmpeg expression.
function animFilters(
  anim: RenderClip['anim'],
  start: number,
  end: number,
  cw: number,
  ch: number,
  // O giro FIXO do clipe entra aqui, no mesmo vetor `rot` das animacoes, em vez
  // de virar um filtro proprio: assim ele herda o pad sqrt(2) e a margem PAR
  // que ja estao verificados. Um `rotate` separado antes do `effectsFilters`
  // quebraria o crop dos efeitos de zoom, que resolve iw/ih uma unica vez.
  staticRotDeg = 0
): { scaleChain: string; rotChain: string; wipeChain: string; fades: string; xAdd: string; yAdd: string } {
  const none = { scaleChain: '', rotChain: '', wipeChain: '', fades: '', xAdd: '', yAdd: '' }
  const staticRot = ((staticRotDeg % 360) + 360) % 360
  if (!anim && !staticRot) return none
  const A = anim ?? {}
  const dur = end - start
  const z: string[] = [] // uniform scale factors (both axes)
  const zx: string[] = [] // horizontal-only scale factors
  const zy: string[] = [] // vertical-only scale factors
  const rot: string[] = [] // additive radians
  if (staticRot) rot.push(((staticRot * Math.PI) / 180).toFixed(6))
  const xs: string[] = [] // additive px (in terms of overlay w)
  const ys: string[] = []
  let fades = ''
  const ALPHA = 'alpha(X\\,Y)'
  let aExpr = ALPHA // geq alpha expression; wrapped below for wipe / neon

  const S = start.toFixed(3)
  const MIN = '0.02'
  // Offsets are fractions of the element's UNSCALED box (CSS translate%
  // semantics). Using the overlay's live `w`/`h` would make a slide travel
  // further whenever a scale animation is running at the same time.
  const CW = String(cw)
  const CH = String(ch)
  const dirVec = (d?: string): { x: number; y: number } => {
    switch (d) {
      case 'right': return { x: 1, y: 0 }
      case 'left': return { x: -1, y: 0 }
      case 'down': return { x: 0, y: 1 }
      case 'up': return { x: 0, y: -1 }
      case 'upright': return { x: 0.7, y: -0.7 }
      case 'upleft': return { x: -0.7, y: -0.7 }
      case 'downright': return { x: 0.7, y: 0.7 }
      case 'downleft': return { x: -0.7, y: 0.7 }
      default: return { x: 0, y: 0 }
    }
  }
  const dirMag = (t: string): number => (t === 'drift' ? 25 : t === 'dash' ? 150 : 80)

  // ---- entrance ----
  if (A.in && A.in !== 'none') {
    const D = Math.max(0.05, Math.min(A.inDur ?? 0.6, dur))
    const Din = D.toFixed(3)
    const EN = (start + D).toFixed(3)
    const P = `clip((t-${S})/${Din}\\,0\\,1)`
    const E = `(1-pow(1-${P}\\,3))`
    const EI = `pow(${P}\\,3)`
    const EB = `(1+2.70158*pow(${P}-1\\,3)+1.70158*pow(${P}-1\\,2))`
    const BO = `(1-abs(cos(${P}*PI*2.5))*pow(1-${P}\\,2))`
    // Outside the entrance window every factor must fall back to its neutral value.
    const inWin = (f: string): string => `if(lt(t\\,${EN})\\,${f}\\,1)`
    const inOff = (f: string): string => `if(lt(t\\,${EN})\\,${f}\\,0)`
    const fadeIn = (mult = 1): void => {
      fades += `,fade=t=in:st=${S}:d=${(D / mult).toFixed(3)}:alpha=1`
    }
    switch (A.in) {
      case 'fade':
        fadeIn()
        break
      case 'popup':
        z.push(inWin(`(0.4+0.6*${EB})`))
        fadeIn(1.5)
        break
      case 'zoom':
        z.push(inWin(`(0.2+0.8*${E})`))
        fadeIn()
        break
      case 'rotate':
        z.push(inWin(`(0.6+0.4*${E})`))
        rot.push(inOff(`-20*PI/180*pow(1-${P}\\,3)`))
        fadeIn()
        break
      case 'fall':
        ys.push(inOff(`-(1-${EB})*0.8*${CH}`))
        fadeIn(2)
        break
      case 'slideL':
        xs.push(inOff(`1.2*${CW}*pow(1-${P}\\,3)`))
        fadeIn(1.5)
        break
      case 'slideR':
        xs.push(inOff(`-1.2*${CW}*pow(1-${P}\\,3)`))
        fadeIn(1.5)
        break
      case 'slideU':
        ys.push(inOff(`1.2*${CH}*pow(1-${P}\\,3)`))
        fadeIn(1.5)
        break
      case 'slideD':
        ys.push(inOff(`-1.2*${CH}*pow(1-${P}\\,3)`))
        fadeIn(1.5)
        break
      case 'flip':
        zx.push(inWin(`max(${MIN}\\,cos((1-${E})*PI/2))`))
        fadeIn(2)
        break
      case 'flip3d':
        zy.push(inWin(`max(${MIN}\\,cos((1-${E})*PI/2))`))
        fadeIn(2)
        break
      case 'spin3d':
        zx.push(inWin(`max(${MIN}\\,abs(cos((1-${E})*1.5*PI)))`))
        z.push(inWin(`(0.7+0.3*${E})`))
        fadeIn(2)
        break
      case 'bounce':
        ys.push(inOff(`-(1-${BO})*0.6*${CH}`))
        fadeIn(3)
        break
      case 'jump':
        ys.push(inOff(`(1-${BO})*0.9*${CH}`))
        fadeIn(3)
        break
      case 'breath':
        z.push(inWin(`(1.08-0.08*${E})`))
        fadeIn()
        break
      case 'heartbeat':
        z.push(inWin(`((0.85+0.15*${E})*(1+0.25*sin(${P}*PI*3)*(1-${P})))`))
        fadeIn(2)
        break
      case 'scrapbook':
        rot.push(inOff(`(1-${EB})*-14*PI/180`))
        z.push(inWin(`(0.7+0.3*${EB})`))
        fadeIn(1.5)
        break
      case 'tumble':
        rot.push(inOff(`(1-${E})*-180*PI/180`))
        z.push(inWin(`(0.5+0.5*${E})`))
        ys.push(inOff(`-(1-${E})*0.7*${CH}`))
        fadeIn(2)
        break
      case 'stomp':
        z.push(inWin(`(1.6-0.6*${EI})`))
        fadeIn(3)
        break
      case 'grow': {
        const G = `if(lt(t\\,${EN})\\,(0.02+0.98*${E})\\,1)`
        const v = dirVec(A.inDir)
        if (v.x === 0 && v.y === 0) z.push(`(${G})`)
        else {
          if (v.x !== 0) {
            zx.push(`(${G})`)
            xs.push(`${(-Math.sign(v.x) * cw) / 2}*(1-(${G}))`)
          }
          if (v.y !== 0) {
            zy.push(`(${G})`)
            ys.push(`${(-Math.sign(v.y) * ch) / 2}*(1-(${G}))`)
          }
        }
        break
      }
      case 'drift':
      case 'dash': {
        const v = dirVec(A.inDir)
        const ease = A.in === 'dash' ? EB : E
        const mag = dirMag(A.in) / 100
        if (v.x) xs.push(inOff(`${(mag * v.x).toFixed(4)}*${CW}*(1-${ease})`))
        if (v.y) ys.push(inOff(`${(mag * v.y).toFixed(4)}*${CH}*(1-${ease})`))
        fadeIn(A.in === 'dash' ? 2 : 1)
        break
      }
      case 'wipe': {
        const v = dirVec(A.inDir)
        // Sweep rightwards by default; the revealed band grows along the axis.
        let mask: string
        if (v.x > 0 || (v.x === 0 && v.y === 0)) mask = `if(lt(X\\,W*${E})\\,${ALPHA}\\,0)`
        else if (v.x < 0) mask = `if(gt(X\\,W*(1-${E}))\\,${ALPHA}\\,0)`
        else if (v.y > 0) mask = `if(lt(Y\\,H*${E})\\,${ALPHA}\\,0)`
        else mask = `if(gt(Y\\,H*(1-${E}))\\,${ALPHA}\\,0)`
        const maskT = mask.replace(/\bt\b(?![a-zA-Z])/g, 'T')
        aExpr = `if(lt(T\\,${EN})\\,${maskT}\\,${aExpr})`
        break
      }
    }
    // Directional approach for entrances whose motion isn't intrinsic.
    if (['fade', 'popup', 'zoom', 'rotate'].includes(A.in) && A.inDir && A.inDir !== 'center') {
      const v = dirVec(A.inDir)
      const M = dirMag(A.in) / 100
      if (v.x) xs.push(inOff(`${(M * v.x).toFixed(4)}*${CW}*pow(1-${P}\\,3)`))
      if (v.y) ys.push(inOff(`${(M * v.y).toFixed(4)}*${CH}*pow(1-${P}\\,3)`))
    }
  }

  // ---- exit ----
  if (A.out && A.out !== 'none') {
    const D = Math.max(0.05, Math.min(A.outDur ?? 0.6, dur))
    const ST = (end - D).toFixed(3)
    const Ds = D.toFixed(3)
    const Q = `clip((${end.toFixed(3)}-t)/${Ds}\\,0\\,1)`
    const PP = `(1-${Q})` // progress through the exit
    const E = `pow(${PP}\\,3)` // easeIn
    const BOq = `(1-abs(cos(${Q}*PI*2.5))*pow(1-${Q}\\,2))`
    const outWin = (f: string): string => `if(gt(t\\,${ST})\\,${f}\\,1)`
    const outOff = (f: string): string => `if(gt(t\\,${ST})\\,${f}\\,0)`
    const fadeOut = (mult = 1): void => {
      fades += `,fade=t=out:st=${ST}:d=${(D / mult).toFixed(3)}:alpha=1`
    }
    switch (A.out) {
      case 'fade':
        fadeOut()
        break
      case 'popout':
        z.push(outWin(`(1-0.6*${E})`))
        fadeOut()
        break
      case 'zoom':
        z.push(outWin(`(1-0.5*${E})`))
        fadeOut()
        break
      case 'rotate':
        rot.push(outOff(`${E}*25*PI/180`))
        z.push(outWin(`(1-0.4*${E})`))
        fadeOut()
        break
      case 'slideL':
        xs.push(outOff(`-1.2*${CW}*${E}`))
        fadeOut(1.5)
        break
      case 'slideR':
        xs.push(outOff(`1.2*${CW}*${E}`))
        fadeOut(1.5)
        break
      case 'slideU':
        ys.push(outOff(`-1.2*${CH}*${E}`))
        fadeOut(1.5)
        break
      case 'slideD':
        ys.push(outOff(`1.2*${CH}*${E}`))
        fadeOut(1.5)
        break
      case 'flip':
        zx.push(outWin(`max(${MIN}\\,cos(${PP}*PI/2))`))
        fadeOut(2)
        break
      case 'flip3d':
        zy.push(outWin(`max(${MIN}\\,cos(${PP}*PI/2))`))
        fadeOut(2)
        break
      case 'spin3d':
        zx.push(outWin(`max(${MIN}\\,abs(cos(${PP}*1.5*PI)))`))
        z.push(outWin(`(1-0.3*${E})`))
        fadeOut(2)
        break
      case 'bounce':
        ys.push(outOff(`(1-${BOq})*0.9*${CH}`))
        fadeOut(2)
        break
      case 'jump':
        ys.push(outOff(`-0.25*${CH}*sin(${PP}*PI)+1.3*${CH}*${E}`))
        fadeOut(1.5)
        break
      case 'breath':
        z.push(outWin(`(1+0.08*${E})`))
        fadeOut()
        break
      case 'heartbeat':
        z.push(outWin(`((1+0.25*sin(${PP}*PI*3)*(1-${PP}))*(1-0.15*${E}))`))
        fadeOut()
        break
      case 'scrapbook':
        rot.push(outOff(`${E}*14*PI/180`))
        z.push(outWin(`(1-0.3*${E})`))
        fadeOut()
        break
      case 'tumble':
        rot.push(outOff(`${E}*180*PI/180`))
        z.push(outWin(`(1-0.5*${E})`))
        ys.push(outOff(`${E}*0.7*${CH}`))
        fadeOut(2)
        break
      case 'stomp':
        z.push(outWin(`(1+0.6*${E})`))
        fadeOut()
        break
      case 'drift':
      case 'dash': {
        const v = dirVec(A.outDir)
        const mag = dirMag(A.out) / 100
        if (v.x) xs.push(outOff(`${(mag * v.x).toFixed(4)}*${CW}*${E}`))
        if (v.y) ys.push(outOff(`${(mag * v.y).toFixed(4)}*${CH}*${E}`))
        fadeOut(A.out === 'dash' ? 1.5 : 1)
        break
      }
      case 'wipe': {
        const v = dirVec(A.outDir)
        let mask: string
        if (v.x > 0 || (v.x === 0 && v.y === 0)) mask = `if(gt(X\\,W*${E})\\,${ALPHA}\\,0)`
        else if (v.x < 0) mask = `if(lt(X\\,W*(1-${E}))\\,${ALPHA}\\,0)`
        else if (v.y > 0) mask = `if(gt(Y\\,H*${E})\\,${ALPHA}\\,0)`
        else mask = `if(lt(Y\\,H*(1-${E}))\\,${ALPHA}\\,0)`
        const maskT = mask.replace(/\bt\b(?![a-zA-Z])/g, 'T')
        aExpr = `if(gt(T\\,${ST})\\,${maskT}\\,${aExpr})`
        break
      }
    }
    if (['fade', 'popout', 'zoom'].includes(A.out) && A.outDir && A.outDir !== 'center') {
      const v = dirVec(A.outDir)
      const M = dirMag(A.out) / 100
      if (v.x) xs.push(outOff(`${(M * v.x).toFixed(4)}*${CW}*${PP}`))
      if (v.y) ys.push(outOff(`${(M * v.y).toFixed(4)}*${CH}*${PP}`))
    }
  }

  // ---- loop (whole clip) ----
  // `loopSpeed` scales local time, exactly as computeAnim() does in the
  // renderer — so what you see in the preview is what gets baked.
  if (A.loop && A.loop !== 'none') {
    const k = Math.max(0.1, Math.min(4, A.loopSpeed ?? 1))
    const LT = `((t-${S})*${k.toFixed(4)})`
    const LTT = `((T-${S})*${k.toFixed(4)})` // geq uses T for time
    switch (A.loop) {
      case 'pulse':
        z.push(`(1+0.06*sin(${LT}*2*PI))`)
        break
      case 'heartbeat':
        z.push(
          `(1+0.12*if(lt(mod(${LT}\\,1.2)\\,0.15)\\,mod(${LT}\\,1.2)/0.15\\,if(lt(mod(${LT}\\,1.2)\\,0.3)\\,1-(mod(${LT}\\,1.2)-0.15)/0.15\\,0)))`
        )
        break
      case 'float':
        ys.push(`0.03*${CH}*sin(${LT}*PI)`)
        break
      case 'jump':
        ys.push(`-0.14*${CH}*abs(sin(${LT}/0.8*PI))`)
        break
      case 'shake':
        xs.push(`0.025*${CW}*sin(${LT}*28)`)
        break
      case 'sway':
        rot.push(`3*PI/180*sin(${LT}*2*PI/1.6)`)
        break
      case 'sway3d':
        zx.push(`(0.92+0.08*cos(${LT}/2*2*PI))`)
        rot.push(`3*PI/180*sin(${LT}/2*2*PI)`)
        break
      case 'wiggle':
        rot.push(`2*PI/180*sin(${LT}*12)`)
        break
      case 'jiggle':
        rot.push(`2.5*PI/180*sin(${LT}*18)`)
        xs.push(`0.012*${CW}*sin(${LT}*23)`)
        break
      case 'neon':
        // A time-varying opacity has to ride the alpha plane: colorchannelmixer
        // takes a constant, and fade= only ramps once.
        aExpr = `${aExpr}*(0.55+0.45*(0.5+0.5*sin(${LTT}/0.9*2*PI)))`
        break
      case 'spin':
        rot.push(`${LT}/3*2*PI`)
        break
      case 'spin3d':
        zx.push(`max(0.05\\,abs(cos(${LT}/3*2*PI)))`)
        break
      case 'flip':
        zx.push(`max(0.05\\,abs(cos(${LT}/2.4*2*PI)))`)
        break
      case 'credits':
        ys.push(`(1.1*${CH}-mod(${LT}*35\\,220)/100*${CH})`)
        break
      case 'creditsOnce':
        ys.push(`(0.6*${CH}-min(1\\,(t-${S})/${Math.max(0.1, dur).toFixed(3)})*1.6*${CH})`)
        break
      case 'balloon':
        ys.push(`(0.6*${CH}-mod(${LT}*16\\,130)/100*${CH})`)
        xs.push(`0.08*${CW}*sin(${LT}*2.1+1.3)`)
        break
    }
  }

  const hasAlphaExpr = aExpr !== ALPHA
  if (!z.length && !zx.length && !zy.length && !rot.length && !xs.length && !ys.length && !fades && !hasAlphaExpr)
    return none

  // Horizontal and vertical scale are tracked separately so `grow`/`flip` can
  // stretch one axis (a bar rising, a card turning) while the other stays put.
  const sxParts = [...z, ...zx]
  const syParts = [...z, ...zy]
  const scaleChain =
    sxParts.length || syParts.length
      ? `,scale=w='max(2\\,trunc(iw*${sxParts.length ? sxParts.join('*') : '1'}))':h='max(2\\,trunc(ih*${syParts.length ? syParts.join('*') : '1'}))':eval=frame`
      : ''

  // Rotation needs headroom: a square spun 45° needs a box √2× wider than its
  // side, or the corners fall outside and get shaved off. Three constraints:
  //   1. `rotate` resolves ow/oh ONCE, at configuration — so it must sit on a
  //      constant-sized input. That is why the caller runs rotChain BEFORE
  //      scaleChain, and why the pad uses literal pixel sizes, not `iw`.
  //   2. The pad is symmetric, so the visual centre is unchanged.
  //   3. The margin must be EVEN. `overlay` aligns chroma to even offsets, so an
  //      odd margin flips the parity of the overlay's x/y and drags the layer a
  //      pixel off from where the same clip sits without rotation.
  const evenMargin = (n: number): number => {
    const m = Math.ceil((n * (1.4142 - 1)) / 2)
    return m % 2 === 0 ? m : m + 1
  }
  const mx = evenMargin(cw)
  const my = evenMargin(ch)
  const rotChain = rot.length
    ? `,pad=${cw + 2 * mx}:${ch + 2 * my}:${mx}:${my}:color=#00000000,rotate=a='${rot.join('+')}':ow=iw:oh=ih:c=black@0`
    : ''

  // A reveal (wipe) or a time-varying opacity (neon) rides on the alpha plane.
  const wipeChain = hasAlphaExpr
    ? `,format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${aExpr}'`
    : ''

  return {
    scaleChain,
    rotChain,
    wipeChain,
    fades,
    xAdd: xs.length ? `+(${xs.join('+')})` : '',
    yAdd: ys.length ? `+(${ys.join('+')})` : ''
  }
}

// atempo only accepts 0.5..2.0 per instance; chain to reach any factor.
function atempoChain(speed: number): string[] {
  const out: string[] = []
  let f = speed
  while (f > 2.0) {
    out.push('atempo=2.0')
    f /= 2
  }
  while (f < 0.5) {
    out.push('atempo=0.5')
    f *= 2
  }
  if (Math.abs(f - 1) > 0.001) out.push(`atempo=${f.toFixed(4)}`)
  return out
}

// Map our transition types to ffmpeg xfade transition names.
function xfadeName(t: string): string {
  switch (t) {
    case 'dissolve':
      return 'dissolve'
    case 'slideleft':
      return 'slideleft'
    case 'slideright':
      return 'slideright'
    case 'slideup':
      return 'slideup'
    case 'slidedown':
      return 'slidedown'
    case 'wipeleft':
      return 'wipeleft'
    case 'wiperight':
      return 'wiperight'
    case 'zoom':
      return 'zoomin'
    case 'circle':
      return 'circleopen'
    case 'fade':
    default:
      return 'fade'
  }
}

// Same law the preview's StereoPannerNode applies to a stereo source (Web
// Audio spec, "stereo input" case) — a linear crossfade between channels,
// NOT equal-power. Mono sources get upmixed to stereo first (aformat), so
// this one formula covers both; that's a deliberate simplification against
// the spec's separate equal-power law for native mono input, accepted
// because this app's audio is stereo in practice (game/mic capture).
function panFilter(pan: number | undefined): string {
  const p = Math.max(-1, Math.min(1, pan ?? 0))
  if (p === 0) return ''
  const f = (n: number): string => n.toFixed(4)
  const c0 = p <= 0 ? `1.0*c0+${f(-p)}*c1` : `${f(1 - p)}*c0`
  const c1 = p <= 0 ? `${f(1 + p)}*c1` : `${f(p)}*c0+1.0*c1`
  return `,aformat=channel_layouts=stereo,pan=stereo|c0=${c0}|c1=${c1}`
}

function eqOf(clip: RenderClip): string {
  const eq =
    clip.brightness !== 0 || clip.contrast !== 1 || clip.saturation !== 1
      ? `,eq=brightness=${clip.brightness.toFixed(3)}:contrast=${clip.contrast.toFixed(3)}:saturation=${clip.saturation.toFixed(3)}`
      : ''
  // The named look runs after the manual eq, exactly as the preview stacks its
  // CSS: cssFilter(clip) first, then the look's url()/contrast()/brightness().
  const look = getLook(clip.look)
  const graded = look ? `${eq},${lookFfmpeg(look)}` : eq
  // A look's vignette reuses the same filter the vignette effect uses, so the
  // two compose instead of fighting.
  return look?.vignette
    ? `${graded},vignette=angle=${(0.5 + look.vignette * 0.9).toFixed(3)}`
    : graded
}

// Scale/fit a source into a w×h box. alpha=true keeps transparency (for overlays);
// alpha=false pads with opaque black (for xfade inputs, which must be opaque & equal-size).
function fitTo(fit: string, w: number, h: number, alpha: boolean): string {
  if (fit === 'cover') {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${alpha ? ',format=rgba' : ''}`
  }
  if (fit === 'fill') {
    return `scale=${w}:${h}${alpha ? ',format=rgba' : ''}`
  }
  if (alpha) {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,format=rgba,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=#00000000`
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
}

// Timeline intervals where OTHER audio clips overlap `clip` (clamped to clip span).
function overlapsAgainst(clip: RenderClip, all: RenderClip[]): Array<[number, number]> {
  const cs = clip.start
  const ce = clip.start + clip.duration
  const raw: Array<[number, number]> = []
  for (const o of all) {
    if (o.id === clip.id) continue
    const a = Math.max(cs, o.start)
    const b = Math.min(ce, o.start + o.duration)
    if (b > a) raw.push([a, b])
  }
  raw.sort((x, y) => x[0] - y[0])
  const merged: Array<[number, number]> = []
  for (const iv of raw) {
    const lastIv = merged[merged.length - 1]
    if (lastIv && iv[0] <= lastIv[1]) lastIv[1] = Math.max(lastIv[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  return merged
}

export interface RenderPayload {
  outputPath: string
  width: number
  height: number
  fps: number
  duration: number
  clips: RenderClip[]
  concatSafe?: boolean
}

export function missingRenderSources(payload: Pick<RenderPayload, 'clips'>): string[] {
  const sources = new Set<string>()
  for (const clip of payload.clips) {
    if (clip.mediaPath) sources.add(clip.mediaPath)
    if (clip.audioPath) sources.add(clip.audioPath)
  }
  return [...sources].filter((path) => !existsSync(path))
}

// VP9/VP8 webms with transparency need the libvpx decoder + format=rgba before
// scaling, or the alpha is silently dropped (clip becomes an opaque rectangle).
async function detectVpxAlpha(src: string): Promise<'vp9' | 'vp8' | null> {
  try {
    const j = await runJson(FFPROBE, [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt:stream_tags=alpha_mode',
      '-print_format', 'json', src
    ])
    const s = j.streams?.[0] || {}
    const hasAlpha = /yuva|rgba|bgra|argb|abgr|ya8|pal8/.test(s.pix_fmt || '') || String(s.tags?.alpha_mode ?? '') === '1'
    if (!hasAlpha) return null
    if (s.codec_name === 'vp9') return 'vp9'
    if (s.codec_name === 'vp8') return 'vp8'
    return null
  } catch {
    return null
  }
}

async function renderTimelinePass(
  payload: RenderPayload,
  onProgress: (p: { percent: number; time: number }) => void
): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  const { width, height, fps, duration, outputPath } = payload
  // Fail fast on missing sources. With `-filter_complex_script`, ffmpeg reports a
  // vanished input as "Cannot allocate memory" / "Could not open encoder" — the
  // real cause never appears. Check first and name the file instead.
  const missing = Array.from(
    new Set(
      payload.clips
        .flatMap((c) => [c.mediaPath, c.audioPath ?? null])
        .filter((p): p is string => !!p && !existsSync(p))
    )
  )
  if (missing.length) {
    const list = missing.map((p) => `  • ${p}`).join(String.fromCharCode(10))
    return {
      ok: false,
      error:
        `${missing.length} arquivo(s) de mídia não estão mais no disco (foram movidos, renomeados ou apagados):` +
        String.fromCharCode(10) +
        list +
        String.fromCharCode(10) +
        'Remova esses clipes da timeline ou reimporte os arquivos e tente de novo.'
    }
  }

  const renderTemp = mkdtempSync(join(tmpdir(), 'vedit-render-'))
  const tempFiles: string[] = []
  const tempFile = (name: string): string => {
    const path = join(renderTemp, name)
    tempFiles.push(path)
    return path
  }
  const args: string[] = ['-y']
  const filters: string[] = []

  // Input 0: black canvas for the whole duration.
  args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}`)

  // Group cuts by source file and pre-detect VP9/VP8 alpha.
  interface SourceInput {
    path: string
    image: boolean
    start: number
    end: number
    idx: number
    vpx: 'vp9' | 'vp8' | null
  }
  const sources = new Map<string, SourceInput>()
  const registerSource = (path: string, image: boolean, start: number, end: number): SourceInput => {
    const existing = sources.get(path)
    if (existing) {
      existing.start = Math.min(existing.start, start)
      existing.end = Math.max(existing.end, end)
      return existing
    }
    const source = { path, image, start, end, idx: 0, vpx: null }
    sources.set(path, source)
    return source
  }
  payload.clips.forEach((clip) => {
    const consumed = clip.duration * Math.max(0.05, clip.speed)
    const image = clip.type === 'image'
    registerSource(clip.mediaPath, image, image ? 0 : clip.inPoint, image ? clip.duration : clip.inPoint + consumed)
    if (clip.type === 'video' && clip.audioPath) {
      registerSource(clip.audioPath, false, clip.inPoint, clip.inPoint + consumed)
    }
  })

  const indexed = payload.clips.map((clip, n) => ({
    clip,
    n,
    idx: 0,
    audioIdx: 0,
    sourceStart: 0,
    audioSourceStart: 0,
    visualSrc: '',
    audioSrc: '',
    vpx: null as 'vp9' | 'vp8' | null
  }))
  const visualVideoPaths = new Set(
    payload.clips.filter((clip) => clip.type === 'video').map((clip) => clip.mediaPath)
  )
  await Promise.all(
    [...sources.values()].map(async (source) => {
      if (visualVideoPaths.has(source.path)) source.vpx = await detectVpxAlpha(source.path)
    })
  )
  let inputIndex = 1
  for (const source of sources.values()) {
    if (source.image) {
      args.push('-loop', '1', '-t', Math.max(0.001, source.end).toFixed(3), '-i', source.path)
    } else {
      // Transparent VP9/VP8 needs its libvpx decoder to expose the alpha plane.
      if (source.vpx) args.push('-c:v', source.vpx === 'vp9' ? 'libvpx-vp9' : 'libvpx')
      // Source seconds consumed = timeline duration × speed.
      args.push(
        '-ss',
        source.start.toFixed(3),
        '-t',
        Math.max(0.001, source.end - source.start).toFixed(3),
        '-i',
        source.path
      )
    }
    source.idx = inputIndex++
  }
  for (const item of indexed) {
    const source = sources.get(item.clip.mediaPath)!
    const audioSource =
      item.clip.type === 'video' && item.clip.audioPath ? sources.get(item.clip.audioPath)! : source
    item.idx = source.idx
    item.audioIdx = audioSource.idx
    item.sourceStart = source.start
    item.audioSourceStart = audioSource.start
    item.vpx = source.vpx
  }

  // --- Video chain: overlay visual clips bottom -> top, with xfade transitions ---
  const visual = indexed
    .filter((i) => i.clip.type === 'video' || i.clip.type === 'image')
    .sort((a, b) => a.clip.trackOrder - b.clip.trackOrder || a.clip.start - b.clip.start)

  // A transition pair: incoming clip B + its overlapping predecessor A on the same track.
  interface XPair {
    a: (typeof visual)[number]
    b: (typeof visual)[number]
    D: number
    type: string
    w0: number
    w1: number
  }
  const pairs: XPair[] = []
  for (const item of visual) {
    const B = item.clip
    if (!B.transition || B.transition.duration <= 0) continue
    let A: (typeof visual)[number] | null = null
    for (const o of visual) {
      if (o === item || o.clip.trackOrder !== B.trackOrder) continue
      if (o.clip.start < B.start && o.clip.start + o.clip.duration > B.start + 0.001) {
        if (!A || o.clip.start + o.clip.duration > A.clip.start + A.clip.duration) A = o
      }
    }
    if (!A) continue
    const overlap = A.clip.start + A.clip.duration - B.start
    const D = Math.min(B.transition.duration, overlap, A.clip.duration, B.duration)
    if (D <= 0.02) continue
    pairs.push({ a: A, b: item, D, type: xfadeName(B.transition.type), w0: B.start, w1: B.start + D })
  }
  const headD = new Map<string, number>()
  const tailD = new Map<string, number>()
  for (const p of pairs) {
    headD.set(p.b.clip.id, p.D)
    tailD.set(p.a.clip.id, p.D)
  }

  filters.push(`[0:v]format=yuv420p[base0]`)
  const visualByInput = new Map<number, typeof visual>()
  for (const item of visual) {
    const group = visualByInput.get(item.idx) || []
    group.push(item)
    visualByInput.set(item.idx, group)
  }
  for (const [idx, group] of visualByInput) {
    const alphaPre = group[0].vpx ? 'format=rgba,' : ''
    if (group.length === 1 && !alphaPre) {
      group[0].visualSrc = `${idx}:v`
      continue
    }
    const labels = group.map((item) => `iv${item.n}`)
    filters.push(
      `[${idx}:v]${alphaPre}${group.length > 1 ? `split=${group.length}` : 'null'}${labels.map((label) => `[${label}]`).join('')}`
    )
    group.forEach((item, i) => {
      item.visualSrc = labels[i]
    })
  }

  interface Op {
    order: number
    time: number
    label: string
    x: string
    y: string
    s: number
    e: number
  }
  const ops: Op[] = []

  // ---- normal clip bodies (with split when a clip also feeds an xfade) ----
  for (const item of visual) {
    const { clip, n } = item
    const start = clip.start
    const end = clip.start + clip.duration
    const speed = clip.type === 'image' ? 1 : Math.max(0.05, clip.speed)
    const sourceOffset = clip.type === 'image' ? 0 : Math.max(0, clip.inPoint - item.sourceStart)
    const consumed = clip.duration * speed
    const clipped = `cv${n}`
    filters.push(
      `[${item.visualSrc}]trim=start=${sourceOffset.toFixed(3)}:duration=${consumed.toFixed(3)},setpts=PTS-STARTPTS[${clipped}]`
    )
    const hd = headD.get(clip.id) || 0
    const td = tailD.get(clip.id) || 0
    const consumers = 1 + (hd ? 1 : 0) + (td ? 1 : 0)
    // Split this clip again only when its body also feeds a transition.
    let srcN = clipped
    if (consumers > 1) {
      const labels = [`s${n}n`]
      srcN = `s${n}n`
      if (hd) labels.push(`s${n}h`)
      if (td) labels.push(`s${n}t`)
      filters.push(`[${clipped}]split=${consumers}${labels.map((l) => `[${l}]`).join('')}`)
    }

    const sw = Math.max(0.01, clip.scale)
    const cw = Math.round(width * sw)
    const ch = Math.round(height * sw)
    const xoff = Math.round(clip.xFrac * width)
    const yoff = Math.round(clip.yFrac * height)
    let x = `(W-w)/2+${xoff}`
    let y = `(H-h)/2+${yoff}`
    const setpts = `setpts=(PTS-STARTPTS)/${speed.toFixed(4)}+${start.toFixed(3)}/TB`
    const opacityChain = clip.opacity < 1 ? `,colorchannelmixer=aa=${clip.opacity.toFixed(3)}` : ''
    let fadeChain = ''
    if (clip.fadeIn > 0) fadeChain += `,fade=t=in:st=${start.toFixed(3)}:d=${clip.fadeIn.toFixed(3)}:alpha=1`
    if (clip.fadeOut > 0)
      fadeChain += `,fade=t=out:st=${(end - clip.fadeOut).toFixed(3)}:d=${clip.fadeOut.toFixed(3)}:alpha=1`

    let normalStart = start
    let normalEnd = end
    if (hd) normalStart = start + hd // head handled by xfade segment
    if (td) normalEnd = end - td // tail handled by xfade segment

    // Intro transition (transition set but no overlapping predecessor): keep the
    // lightweight slide/alpha effect against the canvas.
    if (clip.transition && clip.transition.duration > 0 && !headD.has(clip.id)) {
      const D = Math.min(clip.transition.duration, clip.duration)
      const st = start.toFixed(3)
      const ramp = `max(0\\,1-(t-${st})/${D.toFixed(3)})`
      const tt = clip.transition.type
      if (tt === 'slideleft') x = `(W-w)/2+${xoff}+W*${ramp}`
      else if (tt === 'slideright') x = `(W-w)/2+${xoff}-W*${ramp}`
      else if (tt === 'slideup') y = `(H-h)/2+${yoff}+H*${ramp}`
      else if (tt === 'slidedown') y = `(H-h)/2+${yoff}-H*${ramp}`
      else fadeChain += `,fade=t=in:st=${st}:d=${D.toFixed(3)}:alpha=1`
    }

    const vlabel = `v${n}`
    const fx = effectsFilters(clip.effects, cw, ch, start)
    const an = animFilters(clip.anim, start, end, cw, ch, clip.rotate ?? 0)
    if (an.xAdd) x = `${x}${an.xAdd}`
    if (an.yAdd) y = `${y}${an.yAdd}`
    // wipe/neon act on the layer's own alpha, so they run before it is scaled
    // or rotated (X/Y inside the geq mask must be the element's own coordinates).
    const mask = maskChain(clip.mask, cw, ch)
    filters.push(
      `[${srcN}]${setpts},${fitTo(clip.fit, cw, ch, true)}${fx}${an.wipeChain}${an.rotChain}${an.scaleChain}${eqOf(clip)}${mask}${opacityChain}${fadeChain}${an.fades}[${vlabel}]`
    )
    ops.push({ order: clip.trackOrder, time: normalStart, label: vlabel, x, y, s: normalStart, e: normalEnd })
  }

  // ---- xfade transition segments ----
  pairs.forEach((p, pi) => {
    const A = p.a.clip
    const B = p.b.clip
    const D = p.D
    const speedA = A.type === 'image' ? 1 : Math.max(0.05, A.speed)
    const speedB = B.type === 'image' ? 1 : Math.max(0.05, B.speed)
    filters.push(
      `[s${p.a.n}t]trim=start=${(Math.max(0, A.duration - D) * speedA).toFixed(3)}:duration=${(D * speedA).toFixed(3)},setpts=(PTS-STARTPTS)/${speedA.toFixed(4)},${fitTo(A.fit, width, height, false)}${eqOf(A)},fps=${fps},format=yuv420p[xa${pi}]`
    )
    filters.push(
      `[s${p.b.n}h]trim=start=0:duration=${(D * speedB).toFixed(3)},setpts=(PTS-STARTPTS)/${speedB.toFixed(4)},${fitTo(B.fit, width, height, false)}${eqOf(B)},fps=${fps},format=yuv420p[xb${pi}]`
    )
    filters.push(
      `[xa${pi}][xb${pi}]xfade=transition=${p.type}:duration=${D.toFixed(3)}:offset=0,setpts=PTS-STARTPTS+${p.w0.toFixed(3)}/TB,format=rgba[xf${pi}]`
    )
    ops.push({ order: B.trackOrder, time: p.w0, label: `xf${pi}`, x: `(W-w)/2`, y: `(H-h)/2`, s: p.w0, e: p.w1 })
  })

  // ---- chain overlays in (track, time) order ----
  ops.sort((a, b) => a.order - b.order || a.time - b.time)
  let last = 'base0'
  ops.forEach((op, k) => {
    const out = `base${k + 1}`
    filters.push(
      `[${last}][${op.label}]overlay=${op.x}:${op.y}:enable='between(t,${op.s.toFixed(3)},${op.e.toFixed(3)})':eof_action=pass[${out}]`
    )
    last = out
  })
  const videoOut = last

  // --- Audio chain: position + mix all audio-bearing clips ---
  const audio = indexed.filter((i) => (i.clip.type === 'video' || i.clip.type === 'audio') && i.clip.hasAudio)
  const audioByInput = new Map<number, typeof audio>()
  for (const item of audio) {
    const group = audioByInput.get(item.audioIdx) || []
    group.push(item)
    audioByInput.set(item.audioIdx, group)
  }
  for (const [idx, group] of audioByInput) {
    if (group.length === 1) {
      group[0].audioSrc = `${idx}:a`
      continue
    }
    const labels = group.map((item) => `ia${item.n}`)
    filters.push(`[${idx}:a]asplit=${group.length}${labels.map((label) => `[${label}]`).join('')}`)
    group.forEach((item, i) => {
      item.audioSrc = labels[i]
    })
  }
  const DUCK_LEVEL = 0.28
  const aLabels: string[] = []
  audio.forEach((item) => {
    const { clip, n } = item
    const speed = Math.max(0.05, clip.speed)
    const consumed = clip.duration * speed
    const sourceOffset = Math.max(0, clip.inPoint - item.audioSourceStart)
    const delayMs = Math.round(clip.start * 1000)
    const lbl = `a${n}`
    const parts = [
      `atrim=start=${sourceOffset.toFixed(3)}:duration=${consumed.toFixed(3)}`,
      `asetpts=PTS-STARTPTS`,
      ...atempoChain(speed)
    ]
    // Every cut edge gets at least a 30ms fade — inaudible as a dip, but it
    // kills the click/pop you'd otherwise hear when a waveform starts or ends
    // mid-cycle. User-set fades always win. (Technique from video-use, MIT.)
    const maxFade = Math.max(0.001, clip.duration / 2)
    const fIn = Math.min(clip.fadeIn > 0 ? clip.fadeIn : MICRO_FADE, maxFade)
    const fOut = Math.min(clip.fadeOut > 0 ? clip.fadeOut : MICRO_FADE, maxFade)
    parts.push(`afade=t=in:st=0:d=${fIn.toFixed(3)}`)
    parts.push(`afade=t=out:st=${(clip.duration - fOut).toFixed(3)}:d=${fOut.toFixed(3)}`)
    parts.push(`adelay=${delayMs}|${delayMs}`)

    // Ducking: lower this clip while any OTHER audio clip overlaps it (timeline coords).
    const intervals = clip.duck ? overlapsAgainst(clip, audio.map((a) => a.clip)) : []
    if (intervals.length > 0) {
      const cond = intervals
        .map(([a, b]) => `between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`)
        .join('+')
      parts.push(
        `volume=eval=frame:volume=${clip.volume.toFixed(3)}*(1-min(1\\,${cond})*${(1 - DUCK_LEVEL).toFixed(3)})`
      )
    } else {
      parts.push(`volume=${clip.volume.toFixed(3)}`)
    }
    const pan = panFilter(clip.pan)
    if (pan) parts.push(pan.slice(1)) // panFilter leads with its own comma for CSS-style callers

    filters.push(`[${item.audioSrc}]${parts.join(',')}[${lbl}]`)
    aLabels.push(`[${lbl}]`)
  })

  let audioOut = 'aout'
  if (aLabels.length === 0) {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${duration.toFixed(3)}[aout]`)
  } else {
    const mixed =
      aLabels.length === 1
        ? `${aLabels[0]}anull`
        : `${aLabels.join('')}amix=inputs=${aLabels.length}:normalize=0:dropout_transition=0`
    filters.push(`${mixed}[amixed]`)
    // Rebuild the mix's timestamps before encoding. Without this, a chunk whose
    // audio branches do not overlap in time — e.g. three tracks covering
    // 0→39.6s and three more covering 39.6→57.6s via adelay, which is what a
    // cut at a chunk boundary produces — makes amix hand the encoder a frame
    // carrying AV_NOPTS_VALUE. adelay then ADDS its offset to that sentinel
    // (INT64_MAX), overflowing into a huge negative dts, and the muxer aborts
    // with "non monotonically increasing dts ... 9223372036854775807 >=
    // -9223372036853729280" after writing zero video frames.
    //
    // Reproduced from the real chunk-0003 failure dump and verified fixed:
    // aresample fills any gap, then asetpts=N/SR/TB derives every timestamp
    // from the running sample count, so the result is monotonic by
    // construction no matter what the branches upstream reported. Checked the
    // output too, not just the exit code — audio present at the same level in
    // both halves, and 1728 video frames for 57.594s @30fps.
    filters.push(`[amixed]aresample=async=1:first_pts=0,asetpts=N/SR/TB[aout]`)
  }

  const filterScript = 'filters.txt'
  writeFileSync(tempFile(filterScript), filters.join(';'), 'utf8')
  args.push('-filter_complex_script', filterScript)
  args.push('-map', `[${videoOut}]`, '-map', `[${audioOut}]`)
  args.push('-r', String(fps))

  const tail = [
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    // Every chunk's audio channel count used to be whatever its own filter
    // graph happened to produce — 1 (mono) if nothing forced otherwise, 2 if
    // a clip's pan triggered the stereo upmix (see panFilter). The final
    // concat step stream-copies chunks together (`-c copy`), which requires
    // every segment to share identical stream parameters; a mono chunk next
    // to a stereo one is exactly the mismatch that corrupts the muxer's
    // timestamp bookkeeping on the joined file. Measured: concatenating a
    // real mono chunk with a real stereo chunk this way DOES produce a file
    // whose declared channel count (from the first segment) doesn't match
    // the packets from the second — undefined behavior a real ~60-minute
    // export's timestamp magnitudes turn into the DTS overflow crash. Fixed
    // at the source: every chunk now always encodes 48kHz stereo, so there
    // is nothing left for a neighboring chunk to mismatch.
    '-ac', '2',
    '-ar', '48000',
    '-b:a', '192k',
    ...(payload.concatSafe ? ['-avoid_negative_ts', 'make_zero'] : []),
    '-movflags', '+faststart',
    '-t', duration.toFixed(3),
    '-progress', 'pipe:1',
    '-nostats',
    outputPath
  ]

  type RenderResult = { ok: boolean; outputPath?: string; error?: string; cancelled?: boolean }
  const attempt = (nvenc: boolean): Promise<RenderResult> =>
    new Promise((resolve) => {
      // VideoToolbox takes a quality scale instead of NVENC's rate-control
      // flags, so the two hardware paths cannot share one argument list.
      const hw =
        HW_ENCODER === 'h264_videotoolbox'
          ? ['-c:v', 'h264_videotoolbox', '-q:v', '55', '-realtime', '0']
          : ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
      const enc = nvenc
        ? [...hw, ...(payload.concatSafe ? ['-bf', '0'] : [])]
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...(payload.concatSafe ? ['-bf', '0'] : [])]
      const proc = spawn(FFMPEG, [...args, ...enc, ...tail], { cwd: renderTemp, windowsHide: true })
      currentRender = proc
      let stderr = ''

      proc.stdout.on('data', (buf) => {
        const text = buf.toString()
        for (const line of text.split('\n')) {
          const m = line.match(/out_time_ms=(\d+)/)
          if (m) {
            const t = parseInt(m[1], 10) / 1_000_000
            onProgress({ percent: Math.min(100, (t / duration) * 100), time: t })
          }
        }
      })
      proc.stderr.on('data', (buf) => {
        stderr += buf.toString()
        if (stderr.length > 20000) stderr = stderr.slice(-20000)
      })

      proc.on('error', (err) => {
        currentRender = null
        resolve({ ok: false, error: String(err) })
      })
      proc.on('close', (code) => {
        currentRender = null
        if (renderCancelled) {
          resolve({ ok: false, cancelled: true, error: 'Exportação cancelada.' })
        } else if (code === 0) {
          onProgress({ percent: 100, time: duration })
          resolve({ ok: true, outputPath })
        } else {
          resolve({ ok: false, error: stderr.slice(-2000) || `ffmpeg exited ${code}` })
        }
      })
    })

  renderCancelled = false
  const nv = await hasNvenc()
  let result = await attempt(nv)
  // NVENC listed but failed at runtime (driver/session limits)? Retry on CPU.
  if (!result.ok && !result.cancelled && nv) result = await attempt(false)
  // A failed render used to delete its own evidence. Keep the filtergraph and
  // the error next to the output so a crash can be diagnosed instead of guessed.
  if (!result.ok && !result.cancelled) {
    try {
      const dump = `${outputPath}.render-error.txt`
      writeFileSync(
        dump,
        [
          `data: ${new Date().toISOString()}`,
          `clipes: ${payload.clips.length}  duracao: ${duration.toFixed(2)}s  ${width}x${height}@${fps}`,
          `entradas ffmpeg: ${args.filter((a) => a === '-i').length}`,
          `filtros: ${filters.length} (${filters.join(';').length} caracteres)`,
          '',
          '--- erro ---',
          result.error ?? '(sem mensagem)',
          '',
          '--- filtergraph ---',
          filters.join(';' + String.fromCharCode(10))
        ].join(String.fromCharCode(10)),
        'utf8'
      )
    } catch {
      /* diagnostics are best-effort */
    }
  }
  for (const path of tempFiles) {
    try {
      unlinkSync(path)
    } catch {
      /* best-effort cleanup */
    }
  }
  try {
    rmdirSync(renderTemp)
  } catch {
    /* best-effort cleanup */
  }
  return result
}

function chunkRanges(payload: RenderPayload): Array<[number, number]> {
  const chunkSeconds = 60
  const visual = payload.clips.filter((clip) => clip.type === 'video' || clip.type === 'image')
  const mainOrder = visual.length ? Math.min(...visual.map((clip) => clip.trackOrder)) : 0
  const main = visual.filter((clip) => clip.trackOrder === mainOrder)
  const safeEnds = main
    .map((clip) => clip.start + clip.duration)
    .filter(
      (time) =>
        time > 0 &&
        time < payload.duration &&
        !main.some((clip) => clip.start < time - 0.001 && clip.start + clip.duration > time + 0.001)
    )
    .sort((a, b) => a - b)

  const ranges: Array<[number, number]> = []
  let start = 0
  while (start < payload.duration - 0.001) {
    const upcomingEnds = safeEnds.filter((time) => time > start + 0.001)
    const countLimit = upcomingEnds[39] ?? payload.duration
    const target = Math.min(payload.duration, start + chunkSeconds, countLimit)
    if (target >= payload.duration - 0.001) {
      ranges.push([start, payload.duration])
      break
    }
    const candidates = safeEnds.filter((time) => time > start + 0.001 && time <= target + 0.001)
    const end = candidates.length > 0 ? candidates[candidates.length - 1] : target
    ranges.push([start, end])
    start = end
  }
  return ranges
}

function clipInRange(clip: RenderClip, rangeStart: number, rangeEnd: number): RenderClip | null {
  const clipEnd = clip.start + clip.duration
  const start = Math.max(clip.start, rangeStart)
  const end = Math.min(clipEnd, rangeEnd)
  if (end - start <= 0.001) return null

  const trimLeft = start - clip.start
  const includesStart = trimLeft <= 0.001
  const includesEnd = clipEnd - end <= 0.001
  const effects = clip.effects
    ?.map((effect) => {
      const effectStart = Math.max(effect.at, trimLeft)
      const effectEnd = Math.min(effect.at + effect.duration, trimLeft + (end - start))
      if (effectEnd <= effectStart) return null
      return { ...effect, at: effectStart - trimLeft, duration: effectEnd - effectStart }
    })
    .filter((effect): effect is NonNullable<typeof effect> => effect !== null)
  const anim = clip.anim
    ? {
        ...clip.anim,
        in: includesStart ? clip.anim.in : undefined,
        inDur: includesStart ? clip.anim.inDur : undefined,
        out: includesEnd ? clip.anim.out : undefined,
        outDur: includesEnd ? clip.anim.outDur : undefined
      }
    : undefined

  return {
    ...clip,
    start: start - rangeStart,
    duration: end - start,
    inPoint: clip.inPoint + trimLeft * Math.max(0.05, clip.speed),
    fadeIn: includesStart ? Math.min(clip.fadeIn, end - start) : 0,
    fadeOut: includesEnd ? Math.min(clip.fadeOut, end - start) : 0,
    transition: includesStart ? clip.transition : undefined,
    effects,
    anim
  }
}

export async function renderTimeline(
  payload: RenderPayload,
  onProgress: (p: { percent: number; time: number }) => void
): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  const missingSources = missingRenderSources(payload)
  if (missingSources.length > 0) {
    return {
      ok: false,
      error:
        `A renderização não começou porque ${missingSources.length === 1 ? 'este arquivo não foi encontrado' : 'estes arquivos não foram encontrados'}:\n` +
        missingSources.map((path) => `• ${path}`).join('\n') +
        '\n\nDevolva o arquivo ao caminho indicado ou religue a mídia antes de exportar.'
    }
  }

  // Chunk on DURATION as well as clip count. Counting clips alone let an 81-min
  // timeline with 51 clips take the single-pass path: one filtergraph with 33
  // inputs, 186 filters and a 4863 s canvas, which died with "Cannot allocate
  // memory" (on a 63 GB machine) before emitting a single frame. Long timelines
  // are the expensive case regardless of how few clips they hold.
  const SINGLE_PASS_MAX_SECONDS = 240
  const singlePassOk =
    payload.clips.length <= 60 && payload.duration <= SINGLE_PASS_MAX_SECONDS
  if (singlePassOk) return renderTimelinePass(payload, onProgress)

  const ranges = chunkRanges(payload)
  const outputDir = dirname(payload.outputPath)
  const disk = statfsSync(outputDir)
  const freeBytes = Number(disk.bavail) * Number(disk.bsize)
  const estimatedOutput =
    (payload.duration * payload.width * payload.height * payload.fps * 0.25) / 8
  const requiredBytes = estimatedOutput * 2.2 + 1024 ** 3
  if (freeBytes < requiredBytes) {
    return {
      ok: false,
      error:
        `Espaço insuficiente no disco escolhido. Esta exportação precisa de aproximadamente ` +
        `${(requiredBytes / 1024 ** 3).toFixed(1)} GB livres durante o processamento, mas há ` +
        `${(freeBytes / 1024 ** 3).toFixed(1)} GB. Escolha um disco com mais espaço.`
    }
  }
  const chunkTemp = mkdtempSync(join(outputDir, '.vedit-chunks-'))
  const chunkFiles: string[] = []
  const cleanup = (): void => {
    for (const path of chunkFiles) {
      try {
        unlinkSync(path)
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      rmdirSync(chunkTemp)
    } catch {
      /* best-effort cleanup */
    }
  }

  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i]
    const clips = payload.clips
      .map((clip) => clipInRange(clip, start, end))
      .filter((clip): clip is RenderClip => clip !== null)
    const outputPath = join(chunkTemp, `chunk-${String(i).padStart(4, '0')}.mp4`)
    chunkFiles.push(outputPath)
    const result = await renderTimelinePass(
      { ...payload, outputPath, duration: end - start, clips, concatSafe: true },
      (progress) => {
        const time = Math.min(payload.duration, start + progress.time)
        onProgress({ percent: Math.min(99, (time / payload.duration) * 99), time })
      }
    )
    if (!result.ok) {
      cleanup()
      return result
    }
  }

  const listPath = join(chunkTemp, 'chunks.ffconcat')
  chunkFiles.push(listPath)
  const list = chunkFiles
    .filter((path) => path.endsWith('.mp4'))
    .map((path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n')
  writeFileSync(listPath, `ffconcat version 1.0\n${list}\n`, 'utf8')

  const joined = await new Promise<{ ok: boolean; outputPath?: string; error?: string }>((resolve) => {
    renderCancelled = false
    const proc = spawn(
      FFMPEG,
      [
        '-y',
        '-fflags',
        '+genpts',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        '-copytb',
        '1',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        payload.outputPath
      ],
      { windowsHide: true }
    )
    currentRender = proc
    let stderr = ''
    proc.stderr.on('data', (buf) => {
      stderr += buf.toString()
      if (stderr.length > 20000) stderr = stderr.slice(-20000)
    })
    proc.on('error', (error) => {
      currentRender = null
      resolve({ ok: false, error: String(error) })
    })
    proc.on('close', (code) => {
      currentRender = null
      if (renderCancelled) resolve({ ok: false, error: 'Exportação cancelada.' })
      else if (code === 0) resolve({ ok: true, outputPath: payload.outputPath })
      else resolve({ ok: false, error: stderr.slice(-2000) || `ffmpeg exited ${code}` })
    })
  })
  cleanup()
  if (joined.ok) onProgress({ percent: 100, time: payload.duration })
  return joined
}

// Extract a clip's trimmed segment to a small standalone mp4 (<=15s, <=720p),
// used as a reference video for Seedance 2.0 video-to-video editing.
export function extractSegment(srcPath: string, inPoint: number, duration: number, outPath: string): Promise<string> {
  const dur = Math.min(15, Math.max(1, duration))
  const args = [
    '-y',
    '-ss', inPoint.toFixed(3),
    '-i', srcPath,
    '-t', dur.toFixed(3),
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath
  ]
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve(outPath) : reject(new Error(err.slice(-1000)))))
  })
}

export interface AudioEnhanceOpts {
  denoise: boolean
  denoiseAmount: number // 0..1; intentionally capped to a voice-safe range
  normalize: boolean
  voice: boolean
  compressor: boolean
  gainDb: number
  reverb: number // 0..1
  delayMs: number
  delayMix: number // 0..1
  channels: 'original' | 'mono' | 'stereo'
}

// Clean up a clip's audio: background-noise removal, voice EQ, and loudness
// normalization. Writes a new .m4a into the media dir.
export function enhanceAudio(
  srcPath: string,
  inPoint: number,
  duration: number,
  opts: AudioEnhanceOpts,
  outPath: string
): Promise<string> {
  const dur = Math.max(0.2, duration)
  const chain: string[] = []
  const denoiseAmount = Math.max(0, Math.min(1, opts.denoiseAmount))
  const gainDb = Math.max(-24, Math.min(24, opts.gainDb))
  const reverb = Math.max(0, Math.min(1, opts.reverb))
  const delayMix = Math.max(0, Math.min(1, opts.delayMix))
  const delayMs = Math.max(20, Math.min(2000, opts.delayMs))
  if (opts.voice) chain.push('highpass=f=60', 'lowpass=f=16000')
  if (opts.denoise) {
    // Keep reduction deliberately conservative. The old nf=-25 setting treated
    // quiet speech as noise and could remove it almost entirely.
    const reduction = 4 + denoiseAmount * 8
    chain.push(`afftdn=nr=${reduction.toFixed(1)}:nf=-50:tn=1:gs=8`)
  }
  if (opts.compressor) {
    chain.push('acompressor=threshold=-14dB:ratio=2:attack=20:release=200:knee=4:makeup=1:mix=0.75')
  }
  if (Math.abs(gainDb) >= 0.05) chain.push(`volume=${gainDb.toFixed(1)}dB`)
  if (reverb > 0) {
    const decay = 0.05 + reverb * 0.2
    chain.push(`aecho=0.9:0.7:45|90:${decay.toFixed(3)}|${(decay * 0.6).toFixed(3)}`)
  }
  if (delayMix > 0) {
    const decay = 0.03 + delayMix * 0.42
    chain.push(`aecho=0.9:0.75:${delayMs.toFixed(0)}:${decay.toFixed(3)}`)
  }
  if (!opts.normalize && (gainDb > 0 || reverb > 0 || delayMix > 0)) {
    chain.push('alimiter=limit=0.95:attack=5:release=50:level=false:latency=true')
  }
  if (opts.normalize) chain.push('loudnorm=I=-16:TP=-1.5:LRA=11')
  const af = chain.length ? chain.join(',') : 'anull'
  const args = [
    '-y',
    '-ss', inPoint.toFixed(3),
    '-i', srcPath,
    '-t', dur.toFixed(3),
    '-vn',
    '-af', af,
    // `-ac` forces the OUTPUT channel count; ffmpeg's built-in down/up-mix
    // matrices handle mono↔stereo, so there's no need to hand-write a `pan`
    // expression for this (unlike per-clip L/R panning, which does need one
    // since it has a value, not just a fixed target count).
    ...(opts.channels === 'mono' ? ['-ac', '1'] : opts.channels === 'stereo' ? ['-ac', '2'] : []),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outPath
  ]
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve(outPath) : reject(new Error(err.slice(-1000)))))
  })
}

// One-click footage enhancement tuned for laptop/webcam video: denoise, color
// grade, sharpen, and optional upscale to 1080p. Bakes a new clean file.
export interface EnhanceOpts {
  strength: 'leve' | 'medio' | 'forte'
  upscale: boolean
  warm: boolean
}

async function pixFmtHasAlpha(src: string): Promise<boolean> {
  try {
    const json = await runJson(FFPROBE, [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt:stream_tags=alpha_mode',
      '-print_format', 'json',
      src
    ])
    const stream = json.streams?.[0] || {}
    const pf: string = stream.pix_fmt || ''
    // VP9/WebM signals transparency via an alpha_mode=1 tag even when pix_fmt reads yuv420p.
    const alphaMode = String(stream.tags?.alpha_mode ?? stream.tags?.ALPHA_MODE ?? '')
    return /yuva|rgba|bgra|argb|abgr|ya8|pal8/.test(pf) || alphaMode === '1'
  } catch {
    return false
  }
}

// Returns the actual output path (mp4, or webm when alpha must be preserved).
export async function enhanceClip(
  srcPath: string,
  inPoint: number,
  duration: number,
  opts: EnhanceOpts,
  outPath: string,
  onProgress?: (p: number) => void
): Promise<string> {
  const P = {
    leve: { dn: '1:1:4:4', contrast: 1.04, bright: 0.01, sat: 1.05, gamma: 1.0, sharp: 0.4 },
    medio: { dn: '1.5:1.5:6:6', contrast: 1.08, bright: 0.02, sat: 1.12, gamma: 0.98, sharp: 0.6 },
    forte: { dn: '2:2:8:8', contrast: 1.12, bright: 0.03, sat: 1.2, gamma: 0.96, sharp: 0.9 }
  }[opts.strength]

  const scale = opts.upscale ? `scale=w=-2:h='if(lt(ih,1080),1080,ih)':flags=lanczos,` : ''
  const rgbFilters =
    `hqdn3d=${P.dn},eq=contrast=${P.contrast}:brightness=${P.bright}:saturation=${P.sat}:gamma=${P.gamma}` +
    (opts.warm ? ',colorbalance=rs=0.03:gs=0.01:bs=-0.03' : '') +
    `,unsharp=5:5:${P.sharp}:5:5:0.0`

  const alpha = await pixFmtHasAlpha(srcPath)
  let args: string[]
  let finalOut = outPath

  if (alpha) {
    // Preserve transparency: enhance RGB, keep the alpha channel, output WebM/VP9.
    finalOut = outPath.replace(/\.mp4$/i, '.webm')
    // VP9/VP8 alpha is only exposed by the libvpx decoder; the native decoder
    // hands back yuv420p and alphaextract fails ("planes not available").
    let decoder: string[] = []
    try {
      const j = await runJson(FFPROBE, [
        '-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-print_format', 'json', srcPath
      ])
      const codec = j.streams?.[0]?.codec_name || ''
      if (codec === 'vp9') decoder = ['-c:v', 'libvpx-vp9']
      else if (codec === 'vp8') decoder = ['-c:v', 'libvpx']
    } catch {
      /* ignore */
    }
    // Convert to rgba BEFORE split (so the alpha plane is materialised), enhance the
    // RGB, then re-merge and upscale the final yuva (scaling before split drops alpha).
    const fc =
      `[0:v]format=rgba,split=2[m][al];` +
      `[al]alphaextract[a];` +
      `[m]format=yuv420p,${rgbFilters}[rgb];` +
      `[rgb][a]alphamerge,${scale}format=yuva420p[out]`
    args = [
      '-y',
      ...decoder,
      '-ss', inPoint.toFixed(3),
      '-i', srcPath,
      '-t', duration.toFixed(3),
      '-filter_complex', fc,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuva420p',
      '-b:v', '0',
      '-crf', '24',
      '-deadline', 'good',
      '-cpu-used', '4',
      '-row-mt', '1',
      '-c:a', 'libopus',
      '-progress', 'pipe:1',
      '-nostats',
      finalOut
    ]
  } else {
    args = [
      '-y',
      '-ss', inPoint.toFixed(3),
      '-i', srcPath,
      '-t', duration.toFixed(3),
      '-vf', `${scale}${rgbFilters},format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '17',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      finalOut
    ]
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stdout.on('data', (buf) => {
      const m = buf.toString().match(/out_time_ms=(\d+)/)
      if (m && onProgress) onProgress(Math.min(100, (parseInt(m[1], 10) / 1_000_000 / duration) * 100))
    })
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve(finalOut) : reject(new Error(err.slice(-1500)))))
  })
}

// Per-channel "reference look" match grade (cinematic: natural warm skin, dark
// neutral blacks, elegant purple) — derived from a colorist match to a reference
// frame. Plus clarity and upscale to 1080p. Preserves transparency.
const REF_CURVES =
  "curves=red='0/0 0.133/0.110 0.482/0.490 0.792/0.867 1/1':" +
  "green='0/0 0.161/0.106 0.329/0.400 0.561/0.612 1/1':" +
  "blue='0/0 0.247/0.133 0.486/0.463 0.871/0.886 1/1'"
const REF_CLARITY = 'cas=strength=0.6,unsharp=5:5:0.45:5:5:0.0'
const REF_SCALE = "scale=w=-2:h='if(lt(ih,1080),1080,ih)':flags=lanczos"

export async function applyLook(
  srcPath: string,
  inPoint: number,
  duration: number,
  outPath: string,
  onProgress?: (p: number) => void
): Promise<string> {
  const alpha = await pixFmtHasAlpha(srcPath)
  let args: string[]
  let finalOut = outPath

  if (alpha) {
    finalOut = outPath.replace(/\.mp4$/i, '.webm')
    let decoder: string[] = []
    try {
      const j = await runJson(FFPROBE, ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-print_format', 'json', srcPath])
      const codec = j.streams?.[0]?.codec_name || ''
      if (codec === 'vp9') decoder = ['-c:v', 'libvpx-vp9']
      else if (codec === 'vp8') decoder = ['-c:v', 'libvpx']
    } catch {
      /* ignore */
    }
    const fc =
      `[0:v]format=rgba,split=2[m][al];[al]alphaextract[a];` +
      `[m]format=yuv420p,${REF_CURVES},${REF_CLARITY}[rgb];` +
      `[rgb][a]alphamerge,${REF_SCALE},format=yuva420p[out]`
    args = ['-y', ...decoder, '-ss', inPoint.toFixed(3), '-i', srcPath, '-t', duration.toFixed(3),
      '-filter_complex', fc, '-map', '[out]', '-map', '0:a?',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24',
      '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-c:a', 'libopus',
      '-progress', 'pipe:1', '-nostats', finalOut]
  } else {
    args = ['-y', '-ss', inPoint.toFixed(3), '-i', srcPath, '-t', duration.toFixed(3),
      '-vf', `${REF_CURVES},${REF_CLARITY},${REF_SCALE},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', finalOut]
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stdout.on('data', (buf) => {
      const m = buf.toString().match(/out_time_ms=(\d+)/)
      if (m && onProgress) onProgress(Math.min(100, (parseInt(m[1], 10) / 1_000_000 / duration) * 100))
    })
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve(finalOut) : reject(new Error(err.slice(-1500)))))
  })
}

export async function getFfmpegInfo(): Promise<{ available: boolean; version?: string }> {
  try {
    const out = await runText(FFMPEG, ['-version'])
    const version = out.split('\n')[0]
    return { available: true, version }
  } catch {
    return { available: false }
  }
}

// ---- helpers ----
function runJson(cmd: string, args: string[]): Promise<any> {
  return runText(cmd, args).then((t) => JSON.parse(t))
}

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
