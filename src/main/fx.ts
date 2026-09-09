import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { ffmpegBin } from './ffmpeg'

/**
 * Animated overlay FX (sparkles, light leaks, dust…) rendered locally to a
 * transparent WebM the timeline treats as any other overlay clip.
 *
 * Rendered by an offscreen BrowserWindow rather than the HyperFrames CLI the
 * MCP uses. HyperFrames drives a separate headless Chrome, which means finding
 * a Chrome install and shipping `mcp/node_modules` inside the installer — but
 * Electron *is* Chromium, so the browser is already here. Same canvas, one less
 * dependency, and it keeps working in the packaged app.
 *
 * Frames come out as raw BGRA via `capturePage().getBitmap()` and go straight
 * into ffmpeg's stdin. Going through PNG (encode in Chromium, decode in ffmpeg)
 * is pure overhead when both ends speak raw bytes.
 *
 * The page advances by an explicit `drawFrame(t)` call, never by a wall clock:
 * capture is slower than realtime, so anything driven by rAF would render a
 * stuttering, non-deterministic result.
 */

export interface FxDef {
  id: string
  label: string
  group: 'particulas' | 'luz' | 'clima' | 'moldura'
  /** Seconds; also the loop period, so the clip can be repeated seamlessly. */
  seconds: number
  hint: string
}

export const FX_CATALOG: FxDef[] = [
  { id: 'golden', label: 'Golden (faíscas douradas)', group: 'particulas', seconds: 5, hint: 'Brilho premium, bom sobre retrato' },
  { id: 'embers', label: 'Brasas subindo', group: 'particulas', seconds: 5, hint: 'Fogo, batalha, épico' },
  { id: 'confetti', label: 'Confete', group: 'particulas', seconds: 5, hint: 'Comemoração, resultado' },
  { id: 'bokeh', label: 'Bokeh', group: 'luz', seconds: 6, hint: 'Luzes desfocadas, suave' },
  { id: 'lightleak', label: 'Light leak', group: 'luz', seconds: 4, hint: 'Vazamento de luz quente' },
  { id: 'stars', label: 'Estrelas piscando', group: 'luz', seconds: 6, hint: 'Noite, magia' },
  { id: 'dust', label: 'Poeira no ar', group: 'clima', seconds: 6, hint: 'Sutil, dá profundidade' },
  { id: 'snow', label: 'Neve', group: 'clima', seconds: 6, hint: 'Inverno' },
  { id: 'rain', label: 'Chuva', group: 'clima', seconds: 4, hint: 'Tempestade' },
  { id: 'neonframe', label: 'Moldura neon', group: 'moldura', seconds: 4, hint: 'Borda pulsante para título' },
  { id: 'vhsbars', label: 'Interferência VHS', group: 'moldura', seconds: 3, hint: 'Glitch, corte seco' }
]

export const FX_BY_ID: Record<string, FxDef> = Object.fromEntries(FX_CATALOG.map((f) => [f.id, f]))

/**
 * The canvas program, injected into the offscreen page.
 *
 * Every effect is a pure function of `t`, seeded per particle index — so frame
 * N is identical no matter how long the capture of frame N-1 took, and the
 * animation closes the loop exactly at `D`.
 */
function sceneScript(id: string, W: number, H: number, D: number): string {
  return `
const cv = document.getElementById('c'), g = cv.getContext('2d');
const W = ${W}, H = ${H}, D = ${D};
// mulberry32 — small, fast, and stable across runs, which rAF-free determinism needs.
function rng(s){return function(){s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const TAU = Math.PI * 2;
// Fractional loop position for particle i, so the field wraps seamlessly at D.
const wrap = (t, off) => ((t / D) + off) % 1;

function radial(x, y, r, inner, outer) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  return gr;
}

const SCENES = {
  golden(t) {
    const N = 150, r = rng(7);
    for (let i = 0; i < N; i++) {
      const sx = r(), sy = r(), sp = 0.6 + r() * 0.8, ph = r(), sz = 1.4 + r() * 3.6;
      const p = wrap(t * sp, ph);
      const x = sx * W + Math.sin((p * TAU + i) * 2) * 26;
      const y = (1 - p) * H * 1.15 - H * 0.075;
      // Fade in and out at the ends of the pass so nothing pops.
      const a = Math.sin(p * Math.PI) * (0.5 + r() * 0.5);
      if (a <= 0.01) continue;
      g.globalAlpha = a;
      g.fillStyle = radial(x, y, sz * 4, 'rgba(255,240,190,1)', 'rgba(255,180,60,0)');
      g.beginPath(); g.arc(x, y, sz * 4, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,250,225,' + a + ')';
      g.beginPath(); g.arc(x, y, sz * 0.55, 0, TAU); g.fill();
    }
  },
  embers(t) {
    const N = 120, r = rng(19);
    for (let i = 0; i < N; i++) {
      const sx = r(), sp = 0.7 + r() * 1.1, ph = r(), sz = 1.2 + r() * 2.8;
      const p = wrap(t * sp, ph);
      const x = sx * W + Math.sin(p * TAU * 1.5 + i) * 40;
      const y = (1 - p) * H * 1.1;
      const a = Math.sin(p * Math.PI) * 0.9;
      if (a <= 0.01) continue;
      g.globalAlpha = a;
      g.fillStyle = radial(x, y, sz * 5, 'rgba(255,190,90,1)', 'rgba(200,40,0,0)');
      g.beginPath(); g.arc(x, y, sz * 5, 0, TAU); g.fill();
    }
  },
  confetti(t) {
    const N = 140, r = rng(31);
    const COL = ['#ff4d6d', '#ffd23f', '#4cc9f0', '#7ae582', '#c77dff'];
    for (let i = 0; i < N; i++) {
      const sx = r(), sp = 0.8 + r() * 0.7, ph = r(), w = 8 + r() * 10, h = 5 + r() * 8;
      const spin = (r() - 0.5) * 14, col = COL[(r() * COL.length) | 0];
      const p = wrap(t * sp, ph);
      const x = sx * W + Math.sin(p * TAU + i) * 55;
      const y = p * H * 1.15 - H * 0.075;
      g.globalAlpha = Math.min(1, Math.sin(p * Math.PI) * 2.2);
      g.save(); g.translate(x, y); g.rotate(p * spin);
      g.fillStyle = col; g.fillRect(-w / 2, -h / 2, w, h); g.restore();
    }
  },
  bokeh(t) {
    const N = 26, r = rng(53);
    for (let i = 0; i < N; i++) {
      const sx = r(), sy = r(), rad = 26 + r() * 95, sp = 0.25 + r() * 0.5, ph = r();
      const p = wrap(t * sp, ph);
      const x = sx * W + Math.cos(p * TAU) * 70;
      const y = sy * H + Math.sin(p * TAU * 0.7) * 55;
      const a = (0.1 + r() * 0.22) * (0.6 + 0.4 * Math.sin(p * TAU));
      g.globalAlpha = Math.max(0, a);
      g.fillStyle = radial(x, y, rad, 'rgba(255,240,210,0.85)', 'rgba(255,215,150,0)');
      g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
  },
  lightleak(t) {
    const p = t / D;
    // One warm band sweeping across, plus a softer counter-sweep.
    for (const [off, hue, w] of [[0, '255,170,80', 0.55], [0.45, '255,90,120', 0.35]]) {
      const q = (p + off) % 1;
      const cx = (-0.3 + q * 1.6) * W;
      const a = Math.sin(q * Math.PI) * 0.55;
      if (a <= 0.01) continue;
      const gr = g.createLinearGradient(cx - W * w, 0, cx + W * w, 0);
      gr.addColorStop(0, 'rgba(' + hue + ',0)');
      gr.addColorStop(0.5, 'rgba(' + hue + ',' + a.toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(' + hue + ',0)');
      g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
  },
  stars(t) {
    const N = 190, r = rng(71);
    for (let i = 0; i < N; i++) {
      const x = r() * W, y = r() * H, sz = 0.8 + r() * 2.2, sp = 0.5 + r() * 2.5, ph = r();
      const a = Math.max(0, Math.sin((wrap(t * sp, ph)) * TAU)) * (0.35 + r() * 0.65);
      if (a <= 0.02) continue;
      g.globalAlpha = a;
      g.fillStyle = radial(x, y, sz * 5, 'rgba(255,255,255,1)', 'rgba(180,200,255,0)');
      g.beginPath(); g.arc(x, y, sz * 5, 0, TAU); g.fill();
    }
  },
  dust(t) {
    const N = 180, r = rng(97);
    for (let i = 0; i < N; i++) {
      const sx = r(), sy = r(), sz = 0.7 + r() * 1.8, sp = 0.15 + r() * 0.4, ph = r();
      const p = wrap(t * sp, ph);
      const x = sx * W + Math.sin(p * TAU + i * 0.7) * 45;
      const y = ((sy + p * 0.35) % 1) * H;
      g.globalAlpha = (0.18 + r() * 0.4) * (0.5 + 0.5 * Math.sin(p * TAU + i));
      g.fillStyle = radial(x, y, sz * 4, 'rgba(255,250,235,0.9)', 'rgba(255,245,220,0)');
      g.beginPath(); g.arc(x, y, sz * 4, 0, TAU); g.fill();
    }
  },
  snow(t) {
    const N = 220, r = rng(113);
    for (let i = 0; i < N; i++) {
      const sx = r(), sz = 1.2 + r() * 3.2, sp = 0.4 + r() * 0.7, ph = r();
      const p = wrap(t * sp, ph);
      const x = (sx * W + Math.sin(p * TAU * 2 + i) * 55 + W) % W;
      const y = p * H * 1.1 - H * 0.05;
      g.globalAlpha = 0.35 + r() * 0.55;
      g.fillStyle = radial(x, y, sz * 2.2, 'rgba(255,255,255,1)', 'rgba(220,235,255,0)');
      g.beginPath(); g.arc(x, y, sz * 2.2, 0, TAU); g.fill();
    }
  },
  rain(t) {
    const N = 260, r = rng(131);
    g.lineCap = 'round';
    for (let i = 0; i < N; i++) {
      const sx = r(), len = 22 + r() * 55, sp = 1.6 + r() * 1.4, ph = r(), sl = 5 + r() * 7;
      const p = wrap(t * sp, ph);
      const x = sx * W + p * sl * 12;
      const y = p * H * 1.2 - H * 0.1;
      g.globalAlpha = 0.14 + r() * 0.3;
      g.strokeStyle = 'rgba(210,230,255,1)';
      g.lineWidth = 1 + r() * 1.4;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - sl, y + len); g.stroke();
    }
  },
  neonframe(t) {
    const p = t / D;
    const pulse = 0.65 + 0.35 * Math.sin(p * TAU);
    const m = Math.round(Math.min(W, H) * 0.07);
    const rad = 18;
    const path = () => {
      g.beginPath();
      g.moveTo(m + rad, m);
      g.arcTo(W - m, m, W - m, H - m, rad);
      g.arcTo(W - m, H - m, m, H - m, rad);
      g.arcTo(m, H - m, m, m, rad);
      g.arcTo(m, m, W - m, m, rad);
      g.closePath();
    };
    // Wide soft pass under a tight bright pass = glow without a blur filter.
    g.globalAlpha = 0.5 * pulse; g.strokeStyle = 'rgba(80,200,255,1)'; g.lineWidth = 26; path(); g.stroke();
    g.globalAlpha = 0.85 * pulse; g.strokeStyle = 'rgba(150,230,255,1)'; g.lineWidth = 9; path(); g.stroke();
    g.globalAlpha = pulse; g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 2.5; path(); g.stroke();
  },
  vhsbars(t) {
    const p = t / D, r = rng(151);
    for (let i = 0; i < 22; i++) {
      const h = 3 + r() * 26;
      const y = ((r() + p * (0.4 + r() * 2.2)) % 1) * H;
      g.globalAlpha = 0.05 + r() * 0.22;
      g.fillStyle = r() > 0.5 ? 'rgba(255,60,160,1)' : 'rgba(60,240,255,1)';
      g.fillRect(0, y, W, h);
    }
    // Scanlines, kept faint so they read as texture rather than stripes.
    g.globalAlpha = 0.07; g.fillStyle = '#000';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
  }
};

window.drawFrame = function (t) {
  g.clearRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  SCENES['${id}'](t);
  g.globalAlpha = 1;
};
`
}

function pageHtml(id: string, w: number, h: number, seconds: number): string {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}
canvas{display:block;width:${w}px;height:${h}px}
</style><canvas id="c" width="${w}" height="${h}"></canvas>
<script>${sceneScript(id, w, h, seconds)}</script>`
}

/**
 * One reused offscreen window for every FX render.
 *
 * Creating a fresh transparent+offscreen BrowserWindow per render looks
 * tidier but does not survive the second call: the first render succeeds and
 * the next one dies with ERR_FAILED on load, i.e. the user's second click on
 * an effect. Reusing one window sidesteps the create/destroy race entirely and
 * skips the startup cost, so it is also faster.
 */
let fxWin: BrowserWindow | null = null
let fxIdleTimer: NodeJS.Timeout | null = null

function acquireFxWindow(w: number, h: number): BrowserWindow {
  if (fxIdleTimer) {
    clearTimeout(fxIdleTimer)
    fxIdleTimer = null
  }
  if (fxWin && !fxWin.isDestroyed()) {
    fxWin.setContentSize(w, h)
    return fxWin
  }
  fxWin = new BrowserWindow({
    width: w,
    height: h,
    useContentSize: true,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, zoomFactor: 1, backgroundThrottling: false }
  })
  return fxWin
}

/** Let the window go after a quiet spell — effects come in bursts, not singly. */
function releaseFxWindow(): void {
  if (fxIdleTimer) clearTimeout(fxIdleTimer)
  fxIdleTimer = setTimeout(() => {
    if (fxWin && !fxWin.isDestroyed()) fxWin.destroy()
    fxWin = null
    fxIdleTimer = null
  }, 60_000)
  fxIdleTimer.unref?.()
}

export interface RenderFxOptions {
  id: string
  width: number
  height: number
  fps: number
  seconds?: number
  outDir: string
  onProgress?: (pct: number) => void
}

export async function renderFx(opts: RenderFxOptions): Promise<{ path: string; cached: boolean }> {
  const def = FX_BY_ID[opts.id]
  if (!def) throw new Error(`Efeito desconhecido: ${opts.id}`)
  const seconds = Math.max(0.5, Math.min(30, opts.seconds ?? def.seconds))
  const fps = Math.max(1, Math.min(60, Math.round(opts.fps)))
  const { width: W, height: H } = opts

  const key = createHash('sha1')
    .update(`${opts.id}|${W}x${H}|${fps}|${seconds}|v2`)
    .digest('hex')
    .slice(0, 10)
  const dir = join(opts.outDir, 'fx')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${opts.id}-${key}.webm`)
  if (existsSync(out)) return { path: out, cached: true }

  const total = Math.max(1, Math.round(seconds * fps))
  const win = acquireFxWindow(W, H)

  // VP9 is the only encoder here that carries a real alpha plane. `-auto-alt-ref 0`
  // matters: alt-ref frames and alpha do not coexist in libvpx.
  //
  // `unpremultiply` is not optional: Chromium hands back PREMULTIPLIED BGRA
  // (50%-alpha white measures as 128,125,113,128 — not 255,250,225,128) while
  // ffmpeg reads `bgra` as straight alpha. Skip it and every particle composites
  // roughly alpha-squared, i.e. a sparkle layer that is mysteriously too dim.
  const ff = spawn(ffmpegBin(), [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0',
    '-vf', 'unpremultiply=inplace=1',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '6',
    '-fps_mode', 'cfr', '-r', String(fps),
    out
  ])

  let ffErr = ''
  ff.stderr.on('data', (d) => (ffErr += d.toString()))
  const done = new Promise<void>((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(ffErr.slice(-2000) || `ffmpeg saiu com ${code}`))
    )
  })

  try {
    // A file, not a data: URL — the scene script is big enough that URL
    // encoding is pure overhead, and loadFile fails loudly instead of oddly.
    const page = join(dir, `.scene-${key}.html`)
    writeFileSync(page, pageHtml(opts.id, W, H, seconds), 'utf8')
    await win.loadFile(page)
    for (let i = 0; i < total; i++) {
      const t = i / fps
      await win.webContents.executeJavaScript(`window.drawFrame(${t});1`, true)
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H })
      const bmp = img.toBitmap()
      if (!ff.stdin.write(bmp)) await new Promise((r) => ff.stdin.once('drain', r))
      if (opts.onProgress && i % 5 === 0) opts.onProgress(Math.round(((i + 1) / total) * 100))
    }
    ff.stdin.end()
    await done
    opts.onProgress?.(100)
    return { path: out, cached: false }
  } catch (e) {
    ff.stdin.destroy()
    ff.kill()
    throw e
  } finally {
    releaseFxWindow()
  }
}
