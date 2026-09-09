import type { Clip, TransitionType } from './types'
import { clamp } from './util'

export const TRANSITIONS: Array<{ value: TransitionType; label: string }> = [
  { value: 'fade', label: 'Fade (crossfade)' },
  { value: 'dissolve', label: 'Dissolver' },
  { value: 'slideleft', label: 'Slide ◀ esquerda' },
  { value: 'slideright', label: 'Slide ▶ direita' },
  { value: 'slideup', label: 'Slide ▲ cima' },
  { value: 'slidedown', label: 'Slide ▼ baixo' },
  { value: 'wipeleft', label: 'Wipe ◀' },
  { value: 'wiperight', label: 'Wipe ▶' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'circle', label: 'Círculo' }
]

export interface TransitionStyle {
  active: boolean
  transform?: string
  clipPath?: string
  opacity?: number
}

// Compute the CSS effect for an incoming clip at timeline time t.
export function previewTransition(clip: Clip, t: number): TransitionStyle {
  if (!clip.transition) return { active: false }
  const d = Math.min(clip.transition.duration, clip.duration)
  if (d <= 0 || t < clip.start || t > clip.start + d) return { active: false }
  const p = clamp((t - clip.start) / d, 0, 1)
  const inv = 1 - p
  switch (clip.transition.type) {
    case 'fade':
    case 'dissolve':
      return { active: true, opacity: p }
    case 'slideleft':
      return { active: true, transform: `translateX(${inv * 100}%)` }
    case 'slideright':
      return { active: true, transform: `translateX(${-inv * 100}%)` }
    case 'slideup':
      return { active: true, transform: `translateY(${inv * 100}%)` }
    case 'slidedown':
      return { active: true, transform: `translateY(${-inv * 100}%)` }
    case 'wipeleft':
      return { active: true, clipPath: `inset(0 ${inv * 100}% 0 0)` }
    case 'wiperight':
      return { active: true, clipPath: `inset(0 0 0 ${inv * 100}%)` }
    case 'zoom':
      return { active: true, transform: `scale(${0.5 + 0.5 * p})`, opacity: p }
    case 'circle':
      return { active: true, clipPath: `circle(${p * 75}% at 50% 50%)` }
    default:
      return { active: true, opacity: p }
  }
}
