/**
 * Color looks ("Efeitos › Textura"), defined ONCE and rendered by both the
 * preview and the export.
 *
 * The whole point of this file is that the two sides do the *same math*:
 *
 *   matrix  →  CSS `feColorMatrix` (sRGB)  ==  ffmpeg `colorchannelmixer`
 *   levels  →  CSS `contrast()`/`brightness()`  ==  ffmpeg `lutrgb`
 *
 * That pairing is not arbitrary. The obvious route — CSS `saturate()` on one
 * side and ffmpeg `eq=saturation` on the other — does NOT match: `eq` scales
 * chroma in YUV (Rec.601), while `saturate()` is a Rec.709 matrix in RGB. On a
 * saturated blue the two drifted by 9/255 on the blue channel, which is exactly
 * the kind of "close enough" that turns into a surprise at export time.
 *
 * So saturation and tint are folded into a single 3×3 matrix here, and
 * brightness/contrast go through a per-channel linear map. Both operations are
 * per-channel-linear in sRGB on both sides, so preview *is* export.
 */

export type LookId =
  | 'none'
  | 'teal'
  | 'warm'
  | 'cold'
  | 'faded'
  | 'sepia'
  | 'bw'
  | 'noir'
  | 'vhs'
  | 'cyber'
  | 'bleach'
  | 'forest'
  | 'blockbuster'

export interface LookDef {
  id: LookId
  label: string
  /** Saturation, applied as a Rec.709 luma-preserving matrix. 1 = untouched. */
  sat: number
  /** Per-channel gain applied after saturation: [r, g, b]. */
  tint: [number, number, number]
  /** CSS contrast() semantics: out = (in - 0.5) * c + 0.5. */
  contrast: number
  /** CSS brightness() semantics: out = in * b. */
  brightness: number
  /** Optional darkened corners, 0..1 — reuses the existing vignette path. */
  vignette?: number
  /** Optional film grain, 0..1. Approximated in preview (see LookOverlay). */
  grain?: number
}

// Rec.709 luma weights — the same constants CSS `saturate()` is defined with.
const LR = 0.2126
const LG = 0.7152
const LB = 0.0722

/** 3×3 RGB matrix, row-major, for a look. Saturation first, then channel gain. */
export function lookMatrix(l: LookDef): number[] {
  const s = l.sat
  // Luma-preserving saturation matrix (identical to the CSS saturate() matrix).
  const S = [
    LR + (1 - LR) * s, LG - LG * s, LB - LB * s,
    LR - LR * s, LG + (1 - LG) * s, LB - LB * s,
    LR - LR * s, LG - LG * s, LB + (1 - LB) * s
  ]
  const [tr, tg, tb] = l.tint
  // T · S, with T diagonal — so each row of S just scales by its channel gain.
  return [
    S[0] * tr, S[1] * tr, S[2] * tr,
    S[3] * tg, S[4] * tg, S[5] * tg,
    S[6] * tb, S[7] * tb, S[8] * tb
  ]
}

export const LOOKS: LookDef[] = [
  { id: 'none', label: 'Original', sat: 1, tint: [1, 1, 1], contrast: 1, brightness: 1 },
  {
    id: 'teal',
    label: 'Teal & Orange',
    sat: 1.12,
    tint: [1.06, 1.0, 0.94],
    contrast: 1.08,
    brightness: 1.0,
    vignette: 0.22
  },
  { id: 'warm', label: 'Hora dourada', sat: 1.08, tint: [1.1, 1.02, 0.9], contrast: 1.03, brightness: 1.02 },
  { id: 'cold', label: 'Frio / Nórdico', sat: 0.95, tint: [0.92, 0.99, 1.12], contrast: 1.05, brightness: 1.0 },
  { id: 'faded', label: 'Desbotado', sat: 0.75, tint: [1.04, 1.0, 1.03], contrast: 0.86, brightness: 1.06 },
  { id: 'sepia', label: 'Sépia', sat: 0.0, tint: [1.16, 1.0, 0.78], contrast: 1.04, brightness: 1.02 },
  { id: 'bw', label: 'Preto e branco', sat: 0.0, tint: [1, 1, 1], contrast: 1.08, brightness: 1.0 },
  { id: 'noir', label: 'Noir', sat: 0.0, tint: [1, 1, 1], contrast: 1.38, brightness: 0.96, vignette: 0.38 },
  {
    id: 'vhs',
    label: 'VHS',
    sat: 1.3,
    tint: [1.05, 0.98, 1.06],
    contrast: 0.92,
    brightness: 1.04,
    grain: 0.5,
    vignette: 0.2
  },
  { id: 'cyber', label: 'Cyberpunk', sat: 1.35, tint: [1.05, 0.94, 1.15], contrast: 1.14, brightness: 0.98 },
  { id: 'bleach', label: 'Bleach bypass', sat: 0.45, tint: [1.02, 1.0, 1.02], contrast: 1.32, brightness: 1.04 },
  { id: 'forest', label: 'Floresta', sat: 1.05, tint: [0.94, 1.06, 0.96], contrast: 1.06, brightness: 1.0 },
  {
    id: 'blockbuster',
    label: 'Blockbuster',
    sat: 1.18,
    tint: [1.04, 0.99, 1.02],
    contrast: 1.16,
    brightness: 0.99,
    vignette: 0.3
  }
]

export const LOOK_BY_ID: Record<string, LookDef> = Object.fromEntries(LOOKS.map((l) => [l.id, l]))

export function getLook(id: string | undefined): LookDef | null {
  if (!id || id === 'none') return null
  return LOOK_BY_ID[id] || null
}

/** SVG filter id for a look, used by the preview. */
export const lookFilterId = (id: LookId): string => `lk-${id}`

/**
 * CSS filter value for a look. The url() carries the matrix; contrast and
 * brightness stay as native CSS functions because ffmpeg's `colorlevels`
 * implements exactly those two curves.
 */
export function lookCss(l: LookDef): string {
  const parts = [`url(#${lookFilterId(l.id)})`]
  if (l.contrast !== 1) parts.push(`contrast(${l.contrast})`)
  if (l.brightness !== 1) parts.push(`brightness(${l.brightness})`)
  return parts.join(' ')
}

/**
 * ffmpeg filter chain for a look — the export half of the pair above.
 *
 * Contrast/brightness go through `lutrgb` rather than the more obvious
 * `colorlevels`: colorlevels clamps its own parameters to [0, 1], so it can
 * express neither contrast < 1 (which needs imin < 0) nor brightness > 1. The
 * lut expression is the CSS definition transcribed literally, including the
 * clamp CSS applies *between* two filter functions — hence the inner clip().
 */
export function lookFfmpeg(l: LookDef): string {
  const m = lookMatrix(l)
  const f = (n: number): string => n.toFixed(5)
  let chain =
    `colorchannelmixer=rr=${f(m[0])}:rg=${f(m[1])}:rb=${f(m[2])}` +
    `:gr=${f(m[3])}:gg=${f(m[4])}:gb=${f(m[5])}` +
    `:br=${f(m[6])}:bg=${f(m[7])}:bb=${f(m[8])}`

  if (l.contrast !== 1 || l.brightness !== 1) {
    // CSS mid-grey is 0.5 → 127.5 on an 8-bit channel, not 128.
    let e = 'val'
    if (l.contrast !== 1) e = `clip((${e}-127.5)*${f(l.contrast)}+127.5,0,255)`
    if (l.brightness !== 1) e = `clip(${e}*${f(l.brightness)},0,255)`
    chain += `,lutrgb=r='${e}':g='${e}':b='${e}'`
  }
  // Grain has no exact CSS twin; the preview shows a matched-opacity noise
  // overlay instead. Documented as an approximation in the Effects panel.
  if (l.grain) chain += `,noise=alls=${Math.round(l.grain * 22)}:allf=t+u`
  return chain
}
