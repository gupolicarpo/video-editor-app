import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join, basename, extname } from 'path'
import { tmpdir } from 'os'
import { ffmpegBin, probeMedia } from './ffmpeg'

/**
 * Background removal with RobustVideoMatting.
 *
 * Chosen over BiRefNet after measuring both on real footage:
 *   - BiRefNet: 27.0 s/frame (CPU), and no memory between frames, so the
 *     silhouette boils. It also swallowed part of the chair behind the subject.
 *   - RVM:       0.119 s/frame (CPU), recurrent state carried frame to frame.
 *     Alpha varies 0.022 across the fringe, subject area by 0.46%. Clean.
 *
 * RVM emits `fgr` already decontaminated — the foreground colour with the old
 * background unmixed out of the semi-transparent pixels. Compositing raw camera
 * pixels instead would drag the room's wall into every edge pixel.
 */

const PY_SCRIPT = `
import sys, subprocess, numpy as np, onnxruntime as ort

model, src, dst, ffmpeg, ratio = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
W, H, FPS, NFRAMES = int(sys.argv[6]), int(sys.argv[7]), sys.argv[8], int(sys.argv[9])

# AzureExecutionProvider comes first in get_available_providers() and is a remote
# inference stub, not compute — asking for it makes onnxruntime report a provider
# that never ran a single op. Name the compute providers we actually want.
WANTED = ['CUDAExecutionProvider', 'DmlExecutionProvider', 'CPUExecutionProvider']
avail = ort.get_available_providers()
sess = ort.InferenceSession(model, providers=[p for p in WANTED if p in avail])
print("PROVIDER " + sess.get_providers()[0], flush=True)

# Planar in, planar out. RVM eats and returns NCHW, so interleaved rgb24/rgba
# would cost a full-frame transpose each way (and leave ORT with a strided input
# it has to copy). Measured on 1080p: 169.6 ms/frame interleaved vs 76.5 planar —
# 2.22x, and the inference itself drops 92 -> 46 ms because the tensor is
# contiguous. Plane order for gbrp/gbrap is G, B, R, A (verified, not assumed).
dec = subprocess.Popen([ffmpeg, '-v', 'error', '-i', src, '-f', 'rawvideo',
                        '-pix_fmt', 'gbrp', '-'], stdout=subprocess.PIPE)
# yuva420p + libvpx-vp9 is the only widely-decodable video format with real alpha.
enc = subprocess.Popen([ffmpeg, '-v', 'error', '-y',
                        '-f', 'rawvideo', '-pix_fmt', 'gbrap', '-s', f'{W}x{H}', '-r', FPS, '-i', '-',
                        '-i', src, '-map', '0:v', '-map', '1:a?',
                        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24',
                        # measured: default 8.7fps, cpu-used 4 -> 12.9, realtime/6 -> 49.2 for
                        # 19% more bytes. Past this the encoder stops being the bottleneck (RVM
                        # runs at ~8.4fps on CPU), so buying more speed here would gain nothing.
                        '-deadline', 'realtime', '-cpu-used', '6',
                        '-row-mt', '1', '-c:a', 'libopus', '-b:a', '160k',
                        '-shortest', dst], stdin=subprocess.PIPE)

rec = [np.zeros((1, 1, 1, 1), np.float32)] * 4
r = np.array([ratio], np.float32)
frame_bytes = W * H * 3
src_t = np.empty((1, 3, H, W), np.float32)   # reused every frame
scratch = np.empty((H, W), np.float32)
out8 = np.empty((4, H, W), np.uint8)         # G, B, R, A
done = 0
while True:
    buf = dec.stdout.read(frame_bytes)
    if len(buf) < frame_bytes:
        break
    d = np.frombuffer(buf, np.uint8).reshape(3, H, W)   # gbrp: G, B, R
    np.divide(d[2], 255.0, out=src_t[0, 0])             # R
    np.divide(d[0], 255.0, out=src_t[0, 1])             # G
    np.divide(d[1], 255.0, out=src_t[0, 2])             # B

    fgr, pha, *rec = sess.run(None, {'src': src_t, 'r1i': rec[0], 'r2i': rec[1],
                                     'r3i': rec[2], 'r4i': rec[3], 'downsample_ratio': r})

    f = fgr[0]                                          # R, G, B
    for plane, ch in ((0, 1), (1, 2), (2, 0)):          # out G<-G, B<-B, R<-R
        np.multiply(f[ch], 255.0, out=scratch)
        np.clip(scratch, 0, 255, out=scratch)
        out8[plane] = scratch
    np.multiply(pha[0, 0], 255.0, out=scratch)
    np.clip(scratch, 0, 255, out=scratch)
    out8[3] = scratch
    enc.stdin.write(out8.tobytes())

    done += 1
    if NFRAMES and done % 5 == 0:
        print(f"PROGRESS {done / NFRAMES:.4f}", flush=True)

enc.stdin.close()
enc.wait()
dec.wait()
print(f"FRAMES {done}", flush=True)
if enc.returncode != 0:
    sys.exit("encoder falhou")
`

function pythonBin(): string {
  // macOS/Linux ship `python3`; bare `python` is either missing or Python 2
  // there. Windows keeps `python`, which is what its installer registers.
  return process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3')
}

export function matteAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(pythonBin(), ['-c', 'import onnxruntime, numpy'])
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
}

export function rvmModelPath(): string {
  // Same cascade as the ffmpeg binary: env override → bundled resource → checkout.
  if (process.env.VEDIT_RVM_MODEL) return process.env.VEDIT_RVM_MODEL
  const packed = join(process.resourcesPath || '', 'models', 'rvm_mobilenetv3_fp32.onnx')
  if (existsSync(packed)) return packed
  return join(__dirname, '../../vendor/models/rvm_mobilenetv3_fp32.onnx')
}

export interface MatteResult {
  path: string
  frames: number
  provider: string
}

/**
 * `downsample_ratio` is what the network segments at; the alpha is then
 * upsampled to full resolution. The authors recommend 0.25 for 1080p — lower
 * loses hair, higher costs time without gaining edge detail.
 */
export async function matteClip(
  srcPath: string,
  outDir: string,
  onProgress: (pct: number) => void,
  ratio = 0.25
): Promise<MatteResult> {
  const model = rvmModelPath()
  if (!existsSync(model)) throw new Error(`Modelo RVM não encontrado em ${model}`)

  const meta = await probeMedia(srcPath)
  if (!meta.hasVideo || !meta.width || !meta.height) throw new Error('Clipe sem vídeo.')

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${basename(srcPath, extname(srcPath))}-sem-fundo.webm`)
  const scriptPath = join(tmpdir(), `vedit-matte-${Date.now()}.py`)
  writeFileSync(scriptPath, PY_SCRIPT, 'utf-8')

  const expected = Math.max(1, Math.round(meta.duration * (meta.fps || 30)))
  let provider = 'desconhecido'
  let frames = 0

  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(pythonBin(), [
        scriptPath,
        model,
        srcPath,
        out,
        ffmpegBin(),
        String(ratio),
        String(meta.width),
        String(meta.height),
        String(meta.fps || 30),
        String(expected)
      ])
      let err = ''
      p.stdout.on('data', (d) => {
        for (const line of String(d).split('\n')) {
          if (line.startsWith('PROGRESS ')) onProgress(parseFloat(line.slice(9)))
          else if (line.startsWith('PROVIDER ')) provider = line.slice(9).trim()
          else if (line.startsWith('FRAMES ')) frames = parseInt(line.slice(7), 10)
        }
      })
      p.stderr.on('data', (d) => (err += String(d)))
      p.on('error', reject)
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Recorte falhou (${code}): ${err.slice(-500)}`))
      )
    })
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      /* temp script */
    }
  }

  onProgress(1)
  return { path: out, frames, provider }
}
