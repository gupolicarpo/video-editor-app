import type { Clip, Effect, EffectType } from './types'

export interface Motion {
  scale: number
  dx: number // px in stage space (relative to a 1920-wide reference)
  dy: number
  rotate: number // degrees
  vignette: number // 0..1
  blur: number // px
  grayscale: number // 0..1
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const easeInOut = (p: number): number => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)

export const EFFECTS: Array<{ type: EffectType; label: string }> = [
  { type: 'zoompunch', label: 'Zoom punch (avança e volta)' },
  { type: 'kenburns', label: 'Push-in lento (Ken Burns)' },
  { type: 'snapzoom', label: 'Snap zoom (seco)' },
  { type: 'breathe', label: 'Breathe (flutuação sutil)' },
  { type: 'panright', label: 'Pan ▶ direita' },
  { type: 'panleft', label: 'Pan ◀ esquerda' },
  { type: 'panup', label: 'Pan ▲ cima' },
  { type: 'pandown', label: 'Pan ▼ baixo' },
  { type: 'tilt', label: 'Tilt (inclinação dutch)' },
  { type: 'shake', label: 'Shake (tremor)' },
  { type: 'vignette', label: 'Vinheta (foco)' },
  { type: 'blur', label: 'Desfoque' },
  { type: 'bw', label: 'Preto e branco' }
]

// Camera-movement effects are mutually exclusive (only one at a time per clip).
// "Looks" (vignette/blur/bw) are independent and may coexist with a motion.
export const CAMERA_MOTIONS: ReadonlySet<EffectType> = new Set<EffectType>([
  'zoompunch',
  'kenburns',
  'snapzoom',
  'breathe',
  'panright',
  'panleft',
  'panup',
  'pandown',
  'tilt',
  'shake'
])

export function defaultEffect(type: EffectType, clipDuration: number): Omit<Effect, 'id'> {
  switch (type) {
    case 'zoompunch':
      return { type, at: 0, duration: 1.0, amount: 0.18 }
    case 'kenburns':
      return { type, at: 0, duration: Math.max(1, clipDuration), amount: 0.15 }
    case 'snapzoom':
      return { type, at: 0, duration: 1.0, amount: 0.2 }
    case 'shake':
      return { type, at: 0, duration: 0.6, amount: 8 }
    case 'vignette':
      return { type, at: 0, duration: Math.max(1, clipDuration), amount: 0.4 }
    case 'blur':
      return { type, at: 0, duration: Math.max(1, clipDuration), amount: 6 }
    case 'breathe':
      return { type, at: 0, duration: Math.max(1, clipDuration), amount: 0.04 }
    case 'panright':
    case 'panleft':
    case 'panup':
    case 'pandown':
      return { type, at: 0, duration: Math.max(1, clipDuration), amount: 60 }
    case 'tilt':
      return { type, at: 0, duration: 1.0, amount: 5 }
    case 'bw':
      return { type, at: 0, duration: Math.max(1, clipDuration), amount: 1 }
  }
}

// Compute the animated transform/vignette/blur for a clip at timeline time t.
export function computeMotion(clip: Clip, t: number): Motion {
  const m: Motion = { scale: 1, dx: 0, dy: 0, rotate: 0, vignette: 0, blur: 0, grayscale: 0 }
  const lt = t - clip.start
  for (const e of clip.effects || []) {
    const inWin = lt >= e.at && lt <= e.at + e.duration
    const p = e.duration > 0 ? clamp01((lt - e.at) / e.duration) : 0
    switch (e.type) {
      case 'breathe':
        if (inWin) m.scale *= 1 + e.amount * (0.5 - 0.5 * Math.cos(((lt - e.at) * 2 * Math.PI) / 3))
        break
      case 'panright':
        if (inWin) m.dx += e.amount * p
        break
      case 'panleft':
        if (inWin) m.dx -= e.amount * p
        break
      case 'panup':
        if (inWin) m.dy -= e.amount * p
        break
      case 'pandown':
        if (inWin) m.dy += e.amount * p
        break
      case 'tilt':
        if (inWin) m.rotate += e.amount * Math.sin(p * Math.PI)
        break
      case 'bw':
        if (inWin) m.grayscale = Math.max(m.grayscale, e.amount)
        break
      case 'zoompunch':
        if (inWin) m.scale *= 1 + e.amount * Math.sin(p * Math.PI)
        break
      case 'kenburns':
        if (lt >= e.at) m.scale *= 1 + e.amount * (lt > e.at + e.duration ? 1 : p)
        break
      case 'snapzoom':
        if (inWin) {
          const lp = lt - e.at
          const inT = 0.12
          const outT = 0.12
          let r = 1
          if (lp < inT) r = easeInOut(lp / inT)
          else if (lp > e.duration - outT) r = easeInOut(Math.max(0, (e.duration - lp) / outT))
          m.scale *= 1 + e.amount * r
        }
        break
      case 'shake':
        if (inWin) {
          m.dx += e.amount * Math.sin(lt * 47)
          m.dy += e.amount * Math.cos(lt * 61)
        }
        break
      case 'vignette':
        if (inWin) m.vignette = Math.max(m.vignette, e.amount)
        break
      case 'blur':
        if (inWin) m.blur = Math.max(m.blur, e.amount)
        break
    }
  }
  return m
}
