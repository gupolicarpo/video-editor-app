import type { MaskShape } from './types'

/**
 * Shape masks. Each shape is defined once, in two forms that MUST agree:
 *   - a CSS `clip-path` for the live preview;
 *   - an ffmpeg alpha formula for the export (see maskChain in ffmpeg.ts).
 *
 * The two are kept identical by construction:
 *   - `circle`  uses `closest-side` in CSS and `min(cw,ch)/2` in ffmpeg — both
 *     the inscribed circle, so a non-square box gives the same circle either way.
 *   - `ellipse` fills the box in both.
 *   - `roundrect` corner radius is 25% of the box in both (per-axis in CSS,
 *     per-axis in the ffmpeg formula), so it matches on any aspect ratio.
 */

export const MASKS: Array<{ shape: MaskShape; label: string }> = [
  { shape: 'none', label: 'Sem máscara (retângulo)' },
  { shape: 'circle', label: '● Círculo' },
  { shape: 'ellipse', label: '⬭ Elipse (preenche a caixa)' },
  { shape: 'roundrect', label: '▢ Retângulo arredondado' }
]

/** CSS clip-path for the preview. Empty string = no clip. */
export function maskClipPath(shape?: MaskShape): string {
  switch (shape) {
    case 'circle':
      return 'circle(closest-side)'
    case 'ellipse':
      return 'ellipse(50% 50%)'
    case 'roundrect':
      return 'inset(0 round 25%)'
    default:
      return ''
  }
}
