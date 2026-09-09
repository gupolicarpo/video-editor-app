import { writeFileSync } from 'fs'

// Cinematic LUT: gentle contrast + lifted filmic toe, cool/indigo shadows,
// warm highlights (skin glow), modest saturation. Tunable params.
const P = {
  contrast: 1.07,
  lift: 0.015,
  shadow: [-0.012, -0.004, 0.028], // gentle cool/indigo in shadows
  mid: [-0.004, 0.02, -0.026], // neutralize magenta on midtone skin (push green, cut blue)
  high: [0.028, 0.014, -0.02], // subtle warmth in highlights
  sat: 1.0 // keep natural; let primary handle vibrance modestly
}

const N = 33
const clamp = (x) => Math.min(1, Math.max(0, x))
function grade(r, g, b) {
  const c = (x) => clamp(0.5 + (x - 0.5) * P.contrast)
  r = c(r); g = c(g); b = c(b)
  r = r * (1 - P.lift) + P.lift; g = g * (1 - P.lift) + P.lift; b = b * (1 - P.lift) + P.lift
  let L = 0.25 * r + 0.6 * g + 0.15 * b
  const sw = Math.pow(1 - L, 1.5), hw = Math.pow(L, 1.5)
  const mw = 4 * L * (1 - L) // midtone bell (peak at L=0.5, where skin sits)
  r += P.shadow[0] * sw + P.mid[0] * mw + P.high[0] * hw
  g += P.shadow[1] * sw + P.mid[1] * mw + P.high[1] * hw
  b += P.shadow[2] * sw + P.mid[2] * mw + P.high[2] * hw
  const L2 = 0.25 * r + 0.6 * g + 0.15 * b
  r = L2 + (r - L2) * P.sat; g = L2 + (g - L2) * P.sat; b = L2 + (b - L2) * P.sat
  return [clamp(r), clamp(g), clamp(b)]
}

let out = 'TITLE "Cinematic-Purple"\nLUT_3D_SIZE ' + N + '\n'
for (let bi = 0; bi < N; bi++)
  for (let gi = 0; gi < N; gi++)
    for (let ri = 0; ri < N; ri++) {
      const [r, g, b] = grade(ri / (N - 1), gi / (N - 1), bi / (N - 1))
      out += `${r.toFixed(5)} ${g.toFixed(5)} ${b.toFixed(5)}\n`
    }
writeFileSync('C:/Users/gupol/Documents/Video_Editor_App/_review/cinematic.cube', out, 'utf-8')
console.log('LUT gerado: _review/cinematic.cube (' + N + '^3)')
