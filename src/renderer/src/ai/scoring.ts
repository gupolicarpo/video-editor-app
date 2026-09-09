// Provider scoring — TypeScript reimplementation of OpenMontage's scored
// selection concept. Ranks providers across 7 weighted dimensions; task-fit
// uses semantic token overlap (with synonym expansion) of the user's intent
// against each provider's `bestFor` descriptors.

import type { Provider, Capability, CostInputs } from './providers'

export interface TaskContext {
  intent: string // natural-language goal
  capability: Capability
  needsRealFace: boolean
  costInputs: CostInputs
}

export interface ProviderScore {
  provider: Provider
  taskFit: number
  quality: number
  control: number
  reliability: number
  costEfficiency: number
  latency: number
  continuity: number
  weighted: number
  estCost: number
  reasons: string[]
}

const WEIGHTS = {
  taskFit: 0.3,
  quality: 0.2,
  control: 0.15,
  reliability: 0.15,
  costEfficiency: 0.1,
  latency: 0.05,
  continuity: 0.05
}

// Semantic clusters — any token in a cluster matches the others.
const SYNONYMS: string[][] = [
  ['cinematic', 'film', 'movie', 'trailer', 'dramatic', 'epic', 'cinematografico', 'filme'],
  ['relight', 'lighting', 'light', 'iluminacao', 'luz', 'reluminar'],
  ['background', 'scene', 'fundo', 'cenario', 'estudio', 'studio'],
  ['talking', 'speak', 'narration', 'presenter', 'falando', 'fala', 'roteiro', 'narracao'],
  ['lipsync', 'lip-sync', 'lip', 'sync', 'sincronia', 'boca'],
  ['face', 'avatar', 'rosto', 'pessoa', 'eu', 'me', 'identidade'],
  ['animate', 'animation', 'motion', 'animar', 'animacao', 'movimento'],
  ['voice', 'audio', 'narration', 'tts', 'voz', 'narracao'],
  ['image', 'photo', 'picture', 'imagem', 'foto'],
  ['edit', 'modify', 'change', 'editar', 'mudar', 'trocar', 'restyle']
]

function expand(tokens: Set<string>): Set<string> {
  const out = new Set(tokens)
  for (const cluster of SYNONYMS) {
    if (cluster.some((w) => tokens.has(w))) cluster.forEach((w) => out.add(w))
  }
  return out
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

// Overlap coefficient: |A ∩ B| / min(|A|,|B|) — rewards intent ⊆ capabilities.
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / Math.min(a.size, b.size)
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function scoreProvider(p: Provider, ctx: TaskContext): ProviderScore {
  const reasons: string[] = []

  // task fit
  const intentTokens = expand(tokenize(ctx.intent))
  const bestForTokens = expand(tokenize(p.bestFor.join(' ')))
  let taskFit = clamp01(overlap(intentTokens, bestForTokens) * 0.9 + 0.1)
  if (!p.capabilities.includes(ctx.capability)) {
    taskFit *= 0.15
    reasons.push('não cobre essa capacidade diretamente')
  }
  if (ctx.needsRealFace && !p.allowsRealFace) {
    taskFit *= 0.1
    reasons.push('❌ bloqueia/perde seu rosto real')
  } else if (ctx.needsRealFace && p.allowsRealFace) {
    reasons.push('✅ aceita seu rosto real')
  }

  // control = feature richness
  const control = clamp01(Object.values(p.supports).filter(Boolean).length / 4)

  // cost efficiency: cheaper = higher (free = best)
  const est = p.estimateCost(ctx.costInputs)
  const costEfficiency = est === 0 ? 1 : clamp01(1 - Math.min(1, est / 3))
  if (est === 0) reasons.push(p.runtime === 'local' ? 'grátis (local)' : 'sem custo de API')

  // latency: 0s→1, 600s→0
  const latency = clamp01(1 - p.latencyP50 / 600)

  // continuity: providers already callable in-app score a bit higher
  const continuity = p.callableNow ? 0.8 : 0.4
  if (p.callableNow) reasons.push('já roda no app')
  else if (p.runtime === 'site') reasons.push('rodar no site e importar')
  else if (p.runtime === 'mcp') reasons.push('via MCP (Claude dispara)')
  else if (p.runtime === 'local') reasons.push('local (precisa setup)')
  else reasons.push('precisa integração/chave')

  const weighted =
    taskFit * WEIGHTS.taskFit +
    p.quality * WEIGHTS.quality +
    control * WEIGHTS.control +
    p.reliability * WEIGHTS.reliability +
    costEfficiency * WEIGHTS.costEfficiency +
    latency * WEIGHTS.latency +
    continuity * WEIGHTS.continuity

  return {
    provider: p,
    taskFit,
    quality: p.quality,
    control,
    reliability: p.reliability,
    costEfficiency,
    latency,
    continuity,
    weighted,
    estCost: est,
    reasons
  }
}

export function rankProviders(providers: Provider[], ctx: TaskContext): ProviderScore[] {
  return providers
    .map((p) => scoreProvider(p, ctx))
    .sort((a, b) => b.weighted - a.weighted)
}

// Heuristic: does the goal mention the user's own face/person?
export function detectRealFace(intent: string): boolean {
  const t = intent.toLowerCase()
  return /\b(eu|meu|minha|mim|meu rosto|minha cara|me |myself|my face|real face|talking head)\b/.test(t)
}
