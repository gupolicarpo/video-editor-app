import type { Clip, MediaItem } from './types'
import { measureTextBox } from './textRender'

// Pre-compose quality analysis — adapted from OpenMontage's slideshow-risk +
// delivery-promise concepts, computed from OUR timeline. Catches "this will
// look like a static slideshow" and "this export has no audio" before render.

export type Severity = 'critico' | 'sugestao' | 'nota'

export interface Finding {
  severity: Severity
  title: string
  action: string
}

export type Verdict = 'forte' | 'aceitavel' | 'revisar' | 'risco'

export interface QualityReport {
  score: number // 0..5, lower is better
  verdict: Verdict
  motionRatio: number // 0..1
  dims: Record<string, number>
  findings: Finding[]
}

type MotionClass = 'motion' | 'animated' | 'still'

function classify(c: Clip): MotionClass {
  if (c.type === 'video') return 'motion'
  const hasEffect = (c.effects?.length ?? 0) > 0
  const a = c.anim
  const hasAnim = !!a && ((a.in && a.in !== 'none') || (a.loop && a.loop !== 'none') || (a.out && a.out !== 'none'))
  return hasEffect || hasAnim ? 'animated' : 'still'
}

const clamp = (x: number, lo = 0, hi = 5): number => Math.max(lo, Math.min(hi, x))

export function analyzeTimeline(
  clips: Clip[],
  media: MediaItem[],
  totalDuration: number,
  projectW = 1920,
  projectH = 1080
): QualityReport {
  const visual = clips.filter((c) => c.type === 'video' || c.type === 'image' || c.type === 'text')
  const findings: Finding[] = []

  if (visual.length === 0 || totalDuration <= 0) {
    return { score: 0, verdict: 'forte', motionRatio: 1, dims: {}, findings: [] }
  }

  let motionDur = 0
  let animatedDur = 0
  let stillDur = 0
  let weakCount = 0
  for (const c of visual) {
    const cls = classify(c)
    if (cls === 'motion') motionDur += c.duration
    else if (cls === 'animated') animatedDur += c.duration
    else {
      stillDur += c.duration
      weakCount++
    }
  }
  const visualDur = motionDur + animatedDur + stillDur || 1
  const motionRatio = (motionDur + 0.5 * animatedDur) / visualDur

  // Dimension 1 — still overreliance
  const stillRatio = stillDur / visualDur
  const dStill = clamp(stillRatio * 5)
  if (stillRatio > 0.6)
    findings.push({
      severity: 'critico',
      title: 'Muito conteúdo estático',
      action: `${Math.round(stillRatio * 100)}% do tempo é imagem/texto parado. Adicione vídeo, ou aplique efeitos de movimento/animação nesses clipes.`
    })
  else if (stillRatio > 0.4)
    findings.push({
      severity: 'sugestao',
      title: 'Bastante imagem parada',
      action: 'Considere animar as imagens (efeitos de câmera ou animação de entrada/loop).'
    })

  // Dimension 2 — weak motion (stills with no effect/anim)
  const weakRatio = weakCount / visual.length
  const dWeak = clamp(weakRatio * 4)
  if (weakRatio > 0.5)
    findings.push({
      severity: 'sugestao',
      title: 'Clipes sem movimento',
      action: `${weakCount} clipe(s) sem nenhum efeito nem animação. Use ✨ Animação do elemento ou 🎬 Efeitos de movimento.`
    })

  // Dimension 3 — low cut density
  const cutsPerMin = visual.length / (totalDuration / 60)
  const dCuts = clamp(((8 - cutsPerMin) / 8) * 4)
  if (cutsPerMin < 4)
    findings.push({
      severity: 'sugestao',
      title: 'Poucos cortes',
      action: `~${cutsPerMin.toFixed(1)} cortes/min. Quebre os planos longos em cortes mais curtos pra manter o ritmo.`
    })

  // Dimension 4 — repetition / low source variety
  const distinct = new Set(visual.filter((c) => c.type !== 'text').map((c) => c.mediaId)).size
  const nonText = visual.filter((c) => c.type !== 'text').length || 1
  const variety = distinct / nonText
  const dRepeat = clamp((1 - variety) * 3)
  if (variety < 0.4 && nonText > 3)
    findings.push({
      severity: 'nota',
      title: 'Pouca variedade visual',
      action: 'A mesma mídia se repete bastante. Varie ângulos, planos ou fontes.'
    })

  // Dimension 5 — transitions
  const withTrans = visual.filter((c) => c.transition).length
  const transRatio = withTrans / visual.length
  const dTrans = clamp((1 - transRatio) * 1.2, 0, 1.5)

  // Dimension 6 — audio presence
  const hasAudio = clips.some(
    (c) =>
      (c.type === 'audio' && c.volume > 0) ||
      (c.type === 'video' && c.volume > 0 && media.find((m) => m.id === c.mediaId)?.hasAudio)
  )
  const dAudio = hasAudio ? 0 : 4
  if (!hasAudio)
    findings.push({
      severity: 'critico',
      title: 'Sem áudio',
      action: 'Nenhuma faixa de áudio audível. Adicione narração/música, ou suba o volume de um clipe.'
    })

  const dims = {
    estatico: +dStill.toFixed(1),
    sem_movimento: +dWeak.toFixed(1),
    poucos_cortes: +dCuts.toFixed(1),
    repeticao: +dRepeat.toFixed(1),
    sem_transicoes: +dTrans.toFixed(1),
    sem_audio: +dAudio.toFixed(1)
  }
  const score = +(Object.values(dims).reduce((a, b) => a + b, 0) / 6).toFixed(2)
  const verdict: Verdict = score < 2 ? 'forte' : score < 3 ? 'aceitavel' : score < 4 ? 'revisar' : 'risco'

  // Texto fora do quadro: o preview quebra linha em 94% da largura, mas nada
  // impede que a POSICAO empurre o bloco para fora da tela. Sem este aviso so
  // se descobre depois de uma exportacao inteira.
  const fora: string[] = []
  for (const c of clips) {
    if (c.type !== 'text') continue
    const b = measureTextBox(c, projectW, projectH)
    if (!b) continue
    const s = 2 // tolerancia de antialias
    if (b.left < -s || b.right > projectW + s || b.top < -s || b.bottom > projectH + s) {
      const mm = Math.floor(c.start / 60)
      const ss = Math.floor(c.start % 60)
      fora.push(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`)
    }
  }
  if (fora.length > 0) {
    findings.push({
      severity: 'critico',
      title: `${fora.length} texto(s) saindo do quadro`,
      action: `Em ${fora.join(', ')} o texto passa da borda e vai aparecer cortado no arquivo final. Reduza o tamanho, encurte a frase ou reposicione antes de exportar.`
    })
  }

  return { score, verdict, motionRatio, dims, findings }
}

export const VERDICT_LABEL: Record<Verdict, { label: string; color: string }> = {
  forte: { label: 'Forte', color: '#4ade6c' },
  aceitavel: { label: 'Aceitável', color: '#a3e635' },
  revisar: { label: 'Revisar', color: '#e6b84a' },
  risco: { label: 'Risco de slideshow', color: '#f0683c' }
}
