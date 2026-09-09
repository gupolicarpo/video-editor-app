import type { Clip, AnimIn, AnimLoop, AnimOut, AnimDir } from './types'

// Resulting transform for an element at a given time. tx/ty are in % of the
// element's own size (so a slide of 100% moves it fully off its box),
// matching CSS translate() percentage semantics.
// `clip` is a CSS-inset-style reveal mask: [top, right, bottom, left] in %.
export interface AnimState {
  opacity: number
  tx: number
  ty: number
  scaleX: number
  scaleY: number
  rotate: number
  clip: [number, number, number, number]
}

const identity = (): AnimState => ({ opacity: 1, tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotate: 0, clip: [0, 0, 0, 0] })

// Uniform scale helper — most animations scale both axes together.
const scaleBoth = (s: AnimState, f: number): void => {
  s.scaleX *= f
  s.scaleY *= f
}
// A collapsed axis would render as a 0px layer; keep a sliver.
const MIN_SCALE = 0.02

export const ANIM_IN: Array<{ type: AnimIn; label: string }> = [
  { type: 'none', label: 'Nenhuma' },
  { type: 'fade', label: 'Fade in' },
  { type: 'popup', label: 'Pop up' },
  { type: 'slideL', label: 'Slide ◀ (entra da direita)' },
  { type: 'slideR', label: 'Slide ▶ (entra da esquerda)' },
  { type: 'slideU', label: 'Slide ▲ (entra de baixo)' },
  { type: 'slideD', label: 'Slide ▼ (entra de cima)' },
  { type: 'wipe', label: 'Wipe (revelar)' },
  { type: 'zoom', label: 'Zoom in' },
  { type: 'rotate', label: 'Rotacionar' },
  { type: 'flip', label: 'Flip (virar na horizontal)' },
  { type: 'flip3d', label: '3D Flip (virar na vertical)' },
  { type: 'spin3d', label: 'Spin 3D in' },
  { type: 'grow', label: 'Crescer (barra) — âncora oposta à direção' },
  { type: 'bounce', label: 'Bounce in (quicar)' },
  { type: 'jump', label: 'Jump in (pular)' },
  { type: 'fall', label: 'Cair (fall)' },
  { type: 'drift', label: 'Drift (deriva suave)' },
  { type: 'dash', label: 'Dash (arrancada)' },
  { type: 'breath', label: 'Breath in (respirar)' },
  { type: 'heartbeat', label: 'Heartbeat in' },
  { type: 'scrapbook', label: 'Scrapbook (tortinho)' },
  { type: 'tumble', label: 'Tumble (cambalhota)' },
  { type: 'stomp', label: 'Stomp (pisada)' }
]

export const ANIM_LOOP: Array<{ type: AnimLoop; label: string }> = [
  { type: 'none', label: 'Nenhum' },
  { type: 'pulse', label: 'Pulse' },
  { type: 'shake', label: 'Shake' },
  { type: 'sway', label: 'Sway' },
  { type: 'sway3d', label: 'Sway 3D' },
  { type: 'wiggle', label: 'Wiggle' },
  { type: 'jiggle', label: 'Jiggle' },
  { type: 'float', label: 'Float (flutuar)' },
  { type: 'jump', label: 'Jump (pular)' },
  { type: 'heartbeat', label: 'Heartbeat' },
  { type: 'neon', label: 'Neon (pulsar brilho)' },
  { type: 'spin', label: 'Rotate (girar)' },
  { type: 'spin3d', label: 'Spin 3D (girar em 3D)' },
  { type: 'flip', label: 'Flip (virar)' },
  { type: 'credits', label: 'Credits loop (rolar)' },
  { type: 'creditsOnce', label: 'Closing credits (rolar uma vez)' },
  { type: 'balloon', label: 'Balloon random (subir)' }
]

export const ANIM_OUT: Array<{ type: AnimOut; label: string }> = [
  { type: 'none', label: 'Nenhuma' },
  { type: 'fade', label: 'Fade out' },
  { type: 'popout', label: 'Pop out' },
  { type: 'slideL', label: 'Slide ◀ (sai pela esquerda)' },
  { type: 'slideR', label: 'Slide ▶ (sai pela direita)' },
  { type: 'slideU', label: 'Slide ▲ (sai por cima)' },
  { type: 'slideD', label: 'Slide ▼ (sai por baixo)' },
  { type: 'wipe', label: 'Wipe (cobrir)' },
  { type: 'zoom', label: 'Zoom out' },
  { type: 'rotate', label: 'Rotacionar' },
  { type: 'flip', label: 'Flip (virar na horizontal)' },
  { type: 'flip3d', label: '3D Flip (virar na vertical)' },
  { type: 'spin3d', label: 'Spin 3D out' },
  { type: 'bounce', label: 'Bounce out (quicar)' },
  { type: 'jump', label: 'Jump out (pular)' },
  { type: 'drift', label: 'Drift (deriva suave)' },
  { type: 'dash', label: 'Dash (arrancada)' },
  { type: 'breath', label: 'Breath out (respirar)' },
  { type: 'heartbeat', label: 'Heartbeat out' },
  { type: 'scrapbook', label: 'Scrapbook (tortinho)' },
  { type: 'tumble', label: 'Tumble (cambalhota)' },
  { type: 'stomp', label: 'Stomp (pisada)' }
]

// Directions shown in the picker (label = arrow glyph), ordered for a grid.
export const ANIM_DIRS: Array<{ dir: AnimDir; glyph: string; title: string }> = [
  { dir: 'center', glyph: '⤢', title: 'Centro (sem deslocamento)' },
  { dir: 'right', glyph: '→', title: 'Da direita' },
  { dir: 'left', glyph: '←', title: 'Da esquerda' },
  { dir: 'down', glyph: '↓', title: 'De baixo' },
  { dir: 'up', glyph: '↑', title: 'De cima' },
  { dir: 'downright', glyph: '↘', title: 'Inferior direita' },
  { dir: 'downleft', glyph: '↙', title: 'Inferior esquerda' },
  { dir: 'upright', glyph: '↗', title: 'Superior direita' },
  { dir: 'upleft', glyph: '↖', title: 'Superior esquerda' }
]

// Which animations take a direction. Slides are intrinsically directional;
// `grow` uses it to pick an anchor; `wipe` to pick the sweep axis.
const DIRECTIONAL_IN = new Set<AnimIn>(['fade', 'popup', 'zoom', 'rotate', 'grow', 'wipe', 'drift', 'dash'])
const DIRECTIONAL_OUT = new Set<AnimOut>(['fade', 'popout', 'zoom', 'wipe', 'drift', 'dash'])
export const inUsesDir = (t?: AnimIn): boolean => !!t && DIRECTIONAL_IN.has(t)
export const outUsesDir = (t?: AnimOut): boolean => !!t && DIRECTIONAL_OUT.has(t)

// Unit vector for a direction (x: +right, y: +down).
function dirVec(dir?: AnimDir): { x: number; y: number } {
  switch (dir) {
    case 'right':
      return { x: 1, y: 0 }
    case 'left':
      return { x: -1, y: 0 }
    case 'down':
      return { x: 0, y: 1 }
    case 'up':
      return { x: 0, y: -1 }
    case 'upright':
      return { x: 0.7, y: -0.7 }
    case 'upleft':
      return { x: -0.7, y: -0.7 }
    case 'downright':
      return { x: 0.7, y: 0.7 }
    case 'downleft':
      return { x: -0.7, y: 0.7 }
    default:
      return { x: 0, y: 0 }
  }
}

// How far a directional entrance/exit travels, in % of the element's own size.
const dirMag = (t: string): number => (t === 'drift' ? 25 : t === 'dash' ? 150 : 80)

const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3)
const easeIn = (p: number): number => p * p * p
// Overshoot ease (back) for pop / dash.
const easeBack = (p: number): number => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
}
// Damped-cosine bounce. Chosen over the piecewise CSS bounce because it is a
// single closed-form expression, so the ffmpeg export can reproduce it exactly.
const bounceE = (p: number): number => 1 - Math.abs(Math.cos(p * Math.PI * 2.5)) * Math.pow(1 - p, 2)

const HALF_PI = Math.PI / 2

function applyIn(type: AnimIn, p: number, s: AnimState, dir?: AnimDir): void {
  const e = easeOut(p)
  const eb = easeBack(p)
  const ei = easeIn(p)
  switch (type) {
    case 'fade':
      s.opacity *= p
      break
    case 'popup':
      s.opacity *= Math.min(1, p * 1.5)
      scaleBoth(s, 0.4 + 0.6 * eb)
      break
    case 'slideL':
      s.tx += (1 - e) * 120
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'slideR':
      s.tx -= (1 - e) * 120
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'slideU':
      s.ty += (1 - e) * 120
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'slideD':
      s.ty -= (1 - e) * 120
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'fall':
      s.ty -= (1 - eb) * 80
      s.opacity *= Math.min(1, p * 2)
      break
    case 'zoom':
      scaleBoth(s, 0.2 + 0.8 * e)
      s.opacity *= p
      break
    case 'rotate':
      s.rotate += (1 - e) * -20
      scaleBoth(s, 0.6 + 0.4 * e)
      s.opacity *= p
      break
    // --- flips: an orthographic projection of a 3D card turn, i.e. cos(angle) ---
    case 'flip':
      s.scaleX *= Math.max(MIN_SCALE, Math.cos((1 - e) * HALF_PI))
      s.opacity *= Math.min(1, p * 2)
      break
    case 'flip3d':
      s.scaleY *= Math.max(MIN_SCALE, Math.cos((1 - e) * HALF_PI))
      s.opacity *= Math.min(1, p * 2)
      break
    case 'spin3d':
      s.scaleX *= Math.max(MIN_SCALE, Math.abs(Math.cos((1 - e) * 1.5 * Math.PI)))
      scaleBoth(s, 0.7 + 0.3 * e)
      s.opacity *= Math.min(1, p * 2)
      break
    case 'bounce':
      s.ty -= (1 - bounceE(p)) * 60
      s.opacity *= Math.min(1, p * 3)
      break
    case 'jump':
      s.ty += (1 - bounceE(p)) * 90
      s.opacity *= Math.min(1, p * 3)
      break
    case 'breath':
      scaleBoth(s, 1.08 - 0.08 * e)
      s.opacity *= p
      break
    case 'heartbeat':
      scaleBoth(s, (0.85 + 0.15 * e) * (1 + 0.25 * Math.sin(p * Math.PI * 3) * (1 - p)))
      s.opacity *= Math.min(1, p * 2)
      break
    case 'scrapbook':
      s.rotate += (1 - eb) * -14
      scaleBoth(s, 0.7 + 0.3 * eb)
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'tumble':
      s.rotate += (1 - e) * -180
      scaleBoth(s, 0.5 + 0.5 * e)
      s.ty -= (1 - e) * 70
      s.opacity *= Math.min(1, p * 2)
      break
    case 'stomp':
      scaleBoth(s, 1.6 - 0.6 * ei)
      s.opacity *= Math.min(1, p * 3)
      break
    case 'wipe': {
      const v = dirVec(dir)
      // No direction → sweep rightwards by default.
      if (v.x === 0 && v.y === 0) s.clip[1] = (1 - e) * 100
      else {
        if (v.x > 0) s.clip[1] = (1 - e) * 100 // travels right → inset from right shrinks
        if (v.x < 0) s.clip[3] = (1 - e) * 100
        if (v.y > 0) s.clip[2] = (1 - e) * 100
        if (v.y < 0) s.clip[0] = (1 - e) * 100
      }
      break
    }
    case 'grow':
    case 'drift':
    case 'dash':
      // handled in computeAnim (they need the direction)
      break
  }
}

function applyOut(type: AnimOut, q: number, s: AnimState, dir?: AnimDir): void {
  // q goes 1 -> 0 as we approach the end; p is progress through the exit.
  const p = 1 - q
  const e = easeIn(p)
  switch (type) {
    case 'fade':
      s.opacity *= q
      break
    case 'popout':
      s.opacity *= q
      scaleBoth(s, 1 - 0.6 * e)
      break
    case 'slideL':
      s.tx -= e * 120
      s.opacity *= Math.min(1, q * 1.5)
      break
    case 'slideR':
      s.tx += e * 120
      s.opacity *= Math.min(1, q * 1.5)
      break
    case 'slideU':
      s.ty -= e * 120
      s.opacity *= Math.min(1, q * 1.5)
      break
    case 'slideD':
      s.ty += e * 120
      s.opacity *= Math.min(1, q * 1.5)
      break
    case 'zoom':
      scaleBoth(s, 1 - 0.5 * e)
      s.opacity *= q
      break
    case 'rotate':
      s.rotate += e * 25
      scaleBoth(s, 1 - 0.4 * e)
      s.opacity *= q
      break
    case 'flip':
      s.scaleX *= Math.max(MIN_SCALE, Math.cos(p * HALF_PI))
      s.opacity *= Math.min(1, q * 2)
      break
    case 'flip3d':
      s.scaleY *= Math.max(MIN_SCALE, Math.cos(p * HALF_PI))
      s.opacity *= Math.min(1, q * 2)
      break
    case 'spin3d':
      s.scaleX *= Math.max(MIN_SCALE, Math.abs(Math.cos(p * 1.5 * Math.PI)))
      scaleBoth(s, 1 - 0.3 * e)
      s.opacity *= Math.min(1, q * 2)
      break
    case 'bounce':
      s.ty += (1 - bounceE(q)) * 90
      s.opacity *= Math.min(1, q * 2)
      break
    case 'jump':
      s.ty += -25 * Math.sin(p * Math.PI) + 130 * e
      s.opacity *= Math.min(1, q * 1.5)
      break
    case 'breath':
      scaleBoth(s, 1 + 0.08 * e)
      s.opacity *= q
      break
    case 'heartbeat':
      scaleBoth(s, (1 + 0.25 * Math.sin(p * Math.PI * 3) * (1 - p)) * (1 - 0.15 * e))
      s.opacity *= q
      break
    case 'scrapbook':
      s.rotate += e * 14
      scaleBoth(s, 1 - 0.3 * e)
      s.opacity *= q
      break
    case 'tumble':
      s.rotate += e * 180
      scaleBoth(s, 1 - 0.5 * e)
      s.ty += e * 70
      s.opacity *= Math.min(1, q * 2)
      break
    case 'stomp':
      scaleBoth(s, 1 + 0.6 * e)
      s.opacity *= q
      break
    case 'wipe': {
      const v = dirVec(dir)
      // Cover travels toward the direction: the *opposite* inset grows.
      if (v.x === 0 && v.y === 0) s.clip[3] = e * 100
      else {
        if (v.x > 0) s.clip[3] = e * 100
        if (v.x < 0) s.clip[1] = e * 100
        if (v.y > 0) s.clip[0] = e * 100
        if (v.y < 0) s.clip[2] = e * 100
      }
      break
    }
    case 'drift':
    case 'dash':
      // handled in computeAnim (they need the direction)
      break
  }
}

// `speed` scales the *rate* of every loop: 2 = twice as fast, 0.5 = half.
// Implemented by scaling local time, so period, phase and amplitude stay
// coherent — and it matches the ffmpeg expressions used at export.
function applyLoop(type: AnimLoop, lt: number, s: AnimState, speed = 1, dur = 1): void {
  const tau = Math.PI * 2
  const L = lt * speed
  switch (type) {
    case 'pulse':
      scaleBoth(s, 1 + 0.06 * Math.sin((L / 1.0) * tau))
      break
    case 'shake':
      s.tx += 2.5 * Math.sin(L * 28)
      break
    case 'sway':
      s.rotate += 3 * Math.sin((L / 1.6) * tau)
      break
    case 'sway3d':
      s.scaleX *= 0.92 + 0.08 * Math.cos((L / 2) * tau)
      s.rotate += 3 * Math.sin((L / 2) * tau)
      break
    case 'wiggle':
      s.rotate += 2 * Math.sin(L * 12)
      break
    case 'jiggle':
      s.rotate += 2.5 * Math.sin(L * 18)
      s.tx += 1.2 * Math.sin(L * 23)
      break
    case 'float':
      s.ty += 3 * Math.sin((L / 2.0) * tau)
      break
    case 'jump':
      s.ty -= Math.abs(Math.sin((L / 0.8) * Math.PI)) * 14
      break
    case 'heartbeat': {
      const beat = L % 1.2
      const k = beat < 0.15 ? beat / 0.15 : beat < 0.3 ? 1 - (beat - 0.15) / 0.15 : 0
      scaleBoth(s, 1 + 0.12 * k)
      break
    }
    case 'neon':
      s.opacity *= 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((L / 0.9) * tau))
      break
    case 'spin':
      s.rotate += (L / 3) * 360
      break
    case 'spin3d':
      s.scaleX *= Math.max(0.05, Math.abs(Math.cos((L / 3) * tau)))
      break
    case 'flip':
      s.scaleX *= Math.max(0.05, Math.abs(Math.cos((L / 2.4) * tau)))
      break
    case 'credits':
      s.ty += 110 - ((L * 35) % 220)
      break
    case 'creditsOnce':
      // Single pass tied to the clip's own length, so it always finishes on time.
      s.ty += 60 - Math.min(1, lt / Math.max(0.1, dur)) * 160
      break
    case 'balloon':
      s.ty += 60 - ((L * 16) % 130)
      s.tx += 8 * Math.sin(L * 2.1 + 1.3)
      break
  }
}

export const clampLoopSpeed = (v?: number): number => Math.max(0.1, Math.min(4, v ?? 1))

// Anchored growth. We deliberately avoid CSS transform-origin (it would also
// re-origin the rotation and camera effects on the same layer). Instead we
// scale about the centre and add a translate that pins the opposite edge:
// scaling by `g` moves an edge inward by (1-g)/2 of the box, so we push back
// by exactly that. Exact, and composes with everything else.
const GROW_MIN = 0.02
function applyGrow(dir: AnimDir | undefined, p: number, s: AnimState): void {
  const g = GROW_MIN + (1 - GROW_MIN) * easeOut(p)
  const v = dirVec(dir)
  if (v.x === 0 && v.y === 0) {
    scaleBoth(s, g) // no direction → plain zoom from the centre
    return
  }
  if (v.x !== 0) {
    s.scaleX *= g
    s.tx += -Math.sign(v.x) * ((1 - g) / 2) * 100
  }
  if (v.y !== 0) {
    s.scaleY *= g
    s.ty += -Math.sign(v.y) * ((1 - g) / 2) * 100
  }
}

// Compute the element animation state for a clip at timeline time t.
export function computeAnim(clip: Clip, t: number): AnimState {
  const a = clip.anim
  const s = identity()
  if (!a) return s
  const lt = t - clip.start
  if (lt < 0 || lt > clip.duration) return s

  if (a.loop && a.loop !== 'none') applyLoop(a.loop, lt, s, clampLoopSpeed(a.loopSpeed), clip.duration)

  const inDur = Math.min(a.inDur ?? 0.6, clip.duration)
  if (a.in && a.in !== 'none' && lt < inDur) {
    const p = inDur > 0 ? lt / inDur : 1
    applyIn(a.in, p, s, a.inDir)
    if (a.in === 'grow') {
      // For `grow` the direction picks the anchored edge, not an approach vector.
      applyGrow(a.inDir, p, s)
    } else if (a.in === 'drift' || a.in === 'dash') {
      const v = dirVec(a.inDir)
      const ease = a.in === 'dash' ? easeBack(p) : easeOut(p)
      const off = (1 - ease) * dirMag(a.in)
      s.tx += off * v.x
      s.ty += off * v.y
      s.opacity *= a.in === 'dash' ? Math.min(1, p * 2) : p
    } else if (inUsesDir(a.in) && a.inDir && a.inDir !== 'center' && a.in !== 'wipe') {
      // entrance comes FROM the chosen direction → start offset, ease to 0
      const v = dirVec(a.inDir)
      const off = (1 - easeOut(p)) * dirMag(a.in)
      s.tx += off * v.x
      s.ty += off * v.y
    }
  }

  const outDur = Math.min(a.outDur ?? 0.6, clip.duration)
  if (a.out && a.out !== 'none' && lt > clip.duration - outDur) {
    const q = outDur > 0 ? (clip.duration - lt) / outDur : 0
    const cq = Math.max(0, Math.min(1, q))
    applyOut(a.out, cq, s, a.outDir)
    const p = 1 - cq
    if (a.out === 'drift' || a.out === 'dash') {
      const v = dirVec(a.outDir)
      const off = easeIn(p) * dirMag(a.out)
      s.tx += off * v.x
      s.ty += off * v.y
      s.opacity *= a.out === 'dash' ? Math.min(1, cq * 1.5) : cq
    } else if (outUsesDir(a.out) && a.outDir && a.outDir !== 'center' && a.out !== 'wipe') {
      // exit moves TOWARD the chosen direction
      const v = dirVec(a.outDir)
      const off = (1 - cq) * dirMag(a.out)
      s.tx += off * v.x
      s.ty += off * v.y
    }
  }
  return s
}

// CSS inset() string for the reveal mask, or undefined when nothing is clipped.
export function clipPathOf(s: AnimState): string | undefined {
  const [t, r, b, l] = s.clip
  if (!t && !r && !b && !l) return undefined
  const c = (v: number): string => `${Math.max(0, Math.min(100, v)).toFixed(3)}%`
  return `inset(${c(t)} ${c(r)} ${c(b)} ${c(l)})`
}

// "Match": mirror one side of the animation onto the other.
const MATCH_IN_TO_OUT: Record<string, AnimOut> = {
  fade: 'fade',
  popup: 'popout',
  zoom: 'zoom',
  rotate: 'rotate',
  flip: 'flip',
  flip3d: 'flip3d',
  spin3d: 'spin3d',
  bounce: 'bounce',
  jump: 'jump',
  drift: 'drift',
  dash: 'dash',
  breath: 'breath',
  heartbeat: 'heartbeat',
  scrapbook: 'scrapbook',
  tumble: 'tumble',
  stomp: 'stomp',
  wipe: 'wipe',
  slideL: 'slideR',
  slideR: 'slideL',
  slideU: 'slideD',
  slideD: 'slideU',
  fall: 'slideU',
  grow: 'zoom'
}
const MATCH_OUT_TO_IN: Record<string, AnimIn> = {
  fade: 'fade',
  popout: 'popup',
  zoom: 'zoom',
  rotate: 'rotate',
  flip: 'flip',
  flip3d: 'flip3d',
  spin3d: 'spin3d',
  bounce: 'bounce',
  jump: 'jump',
  drift: 'drift',
  dash: 'dash',
  breath: 'breath',
  heartbeat: 'heartbeat',
  scrapbook: 'scrapbook',
  tumble: 'tumble',
  stomp: 'stomp',
  wipe: 'wipe',
  slideL: 'slideR',
  slideR: 'slideL',
  slideU: 'slideD',
  slideD: 'slideU'
}
export const matchOutFor = (i?: AnimIn): AnimOut => (i && MATCH_IN_TO_OUT[i]) || 'fade'
export const matchInFor = (o?: AnimOut): AnimIn => (o && MATCH_OUT_TO_IN[o]) || 'fade'
