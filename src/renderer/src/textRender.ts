import type { Clip } from './types'

// Draw a text clip onto a full-canvas 2D context (used for export rasterization).
// Onde cada linha do texto vai parar. Fica separado de proposito: o desenho no
// export e a verificacao pre-exportacao PRECISAM concordar, e a unica forma de
// garantir isso e os dois lerem da mesma funcao.
export interface TextLayout {
  lines: string[]
  fontSize: number
  lineHeight: number
  maxW: number
  cx: number
  cy: number
  totalH: number
}

export function layoutTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  W: number,
  H: number
): TextLayout | null {
  const t = clip.text
  if (!t) return null
  const fontSize = Math.max(4, t.fontSizeRel * H)
  const lineHeight = fontSize * 1.25
  ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${fontSize}px ${t.fontFamily}`
  ctx.textBaseline = 'middle'

  // O PREVIEW quebra linha: a caixa de texto tem `maxWidth: 94%`,
  // `whiteSpace: pre-wrap` e `wordBreak: break-word`. O rasterizador do export
  // quebrava SO em quebra de linha explicita, entao qualquer frase mais larga
  // que a tela saia numa linha unica vazando pelos dois lados: no preview
  // parecia certo e no arquivo final o texto sumia fora do quadro. Aqui a
  // quebra e reproduzida com a MESMA largura, medida no proprio contexto
  // (mesma fonte, mesmo tamanho) para bater com o que o preview mostra.
  // 94% da tela e o teto, mas quando o texto esta deslocado do centro a caixa
  // tambem nao pode passar da borda mais proxima — senao quebrar linha nao
  // resolve nada: o bloco inteiro sai do quadro pelo lado para onde foi
  // empurrado. O preview aplica exatamente a mesma conta em `maxWidth`.
  const cxTmp = (0.5 + clip.xFrac) * W
  const wrapWidth = Math.min(W * 0.94, 2 * Math.min(cxTmp, W - cxTmp))
  const lines: string[] = []
  for (const para of t.content.split('\n')) {
    if (para === '') { lines.push(''); continue }
    let line = ''
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width <= wrapWidth) { line = test; continue }
      if (line) { lines.push(line); line = '' }
      // palavra unica maior que a caixa: quebra por caractere, igual ao
      // `word-break: break-word` do preview
      if (ctx.measureText(word).width <= wrapWidth) { line = word; continue }
      let chunk = ''
      for (const ch of word) {
        if (ctx.measureText(chunk + ch).width > wrapWidth && chunk) {
          lines.push(chunk)
          chunk = ch
        } else chunk += ch
      }
      line = chunk
    }
    lines.push(line)
  }
  let maxW = 0
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width)

  const cx = (0.5 + clip.xFrac) * W
  const cy = (0.5 + clip.yFrac) * H
  const totalH = lines.length * lineHeight
  return { lines, fontSize, lineHeight, maxW, cx, cy, totalH }
}

// Caixa que o texto ocupa no quadro, em pixels. Usada para avisar antes de
// exportar quando um texto vaza para fora da tela.
export function measureTextBox(
  clip: Clip,
  W: number,
  H: number
): { left: number; right: number; top: number; bottom: number } | null {
  const cv = document.createElement('canvas')
  cv.width = 8
  cv.height = 8
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  const L = layoutTextClip(ctx, clip, W, H)
  if (!L) return null
  const pad = clip.text?.bgColor ? L.fontSize * 0.4 : 0
  return {
    left: L.cx - L.maxW / 2 - pad,
    right: L.cx + L.maxW / 2 + pad,
    top: L.cy - L.totalH / 2,
    bottom: L.cy + L.totalH / 2
  }
}

// Draw a text clip onto a full-canvas 2D context (used for export rasterization).
export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  W: number,
  H: number
): void {
  const t = clip.text
  if (!t) return
  const L = layoutTextClip(ctx, clip, W, H)
  if (!L) return
  const { lines, fontSize, lineHeight, maxW, cx, cy, totalH } = L

  // O giro fixo e assado AQUI, em torno do centro do proprio texto. O clipe de
  // texto vira um PNG do tamanho da tela inteira, entao girar o PNG depois
  // rodaria o texto em torno do centro da TELA — nao do texto.
  const rot = clip.rotate ?? 0
  const rotated = rot % 360 !== 0
  if (rotated) {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.translate(-cx, -cy)
  }

  // Optional background box.
  if (t.bgColor) {
    const padX = fontSize * 0.4
    const padY = fontSize * 0.25
    ctx.fillStyle = t.bgColor
    ctx.fillRect(cx - maxW / 2 - padX, cy - totalH / 2 - padY, maxW + padX * 2, totalH + padY * 2)
  }

  let anchorX = cx
  if (t.align === 'left') {
    ctx.textAlign = 'left'
    anchorX = cx - maxW / 2
  } else if (t.align === 'right') {
    ctx.textAlign = 'right'
    anchorX = cx + maxW / 2
  } else {
    ctx.textAlign = 'center'
  }

  lines.forEach((ln, i) => {
    const y = cy - totalH / 2 + lineHeight / 2 + i * lineHeight
    if (t.outline) {
      ctx.lineWidth = Math.max(1, fontSize * 0.14)
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.lineJoin = 'round'
      ctx.strokeText(ln, anchorX, y)
    }
    ctx.fillStyle = t.color
    ctx.fillText(ln, anchorX, y)
  })

  if (rotated) ctx.restore()
}

// Rasterize a text clip to a transparent PNG and persist it to a temp file.
// Returns the temp file path for ffmpeg to overlay.
export async function rasterizeText(clip: Clip, W: number, H: number): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  drawTextClip(ctx, clip, W, H)
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1]
  return window.api.writeTempPng(base64)
}
