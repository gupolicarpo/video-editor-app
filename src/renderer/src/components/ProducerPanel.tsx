import { useEffect, useState } from 'react'
import { PROVIDERS, CAPABILITY_LABEL } from '../ai/providers'
import type { Capability } from '../ai/providers'
import { rankProviders, detectRealFace } from '../ai/scoring'
import type { ProviderScore } from '../ai/scoring'
import { LipSyncPanel } from './LipSyncPanel'
import { KlingPanel } from './KlingPanel'
import { RemakePanel } from './RemakePanel'
import { useEditor } from '../store'

interface BudgetState {
  totalUsd: number
  mode: string
  singleActionApprovalUsd: number
  spentUsd: number
  reservedUsd: number
  remainingUsd: number
}

const CAPS: Capability[] = [
  'video2video',
  'image2video',
  'text2video',
  'lipsync',
  'tts',
  'image',
  'bgremove',
  'upscale'
]

const RUNTIME_BADGE: Record<string, string> = {
  api: '🔌 API',
  mcp: '🔗 MCP',
  local: '💻 Local',
  site: '🌐 Site'
}

export function ProducerPanel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const projectW = useEditor((s) => s.projectW)
  const projectH = useEditor((s) => s.projectH)
  const projectFps = useEditor((s) => s.projectFps)
  const playhead = useEditor((s) => s.playhead)
  const [goal, setGoal] = useState('')
  const [capability, setCapability] = useState<Capability>('video2video')
  const [seconds, setSeconds] = useState(5)
  const [results, setResults] = useState<ProviderScore[] | null>(null)
  const [budget, setBudget] = useState<BudgetState | null>(null)
  const [fxPrompt, setFxPrompt] = useState('Um título cinematográfico com partículas sutis e entrada suave')
  const [fxCopied, setFxCopied] = useState(false)

  async function refreshBudget(): Promise<void> {
    setBudget(await window.api.budgetState())
  }
  useEffect(() => {
    refreshBudget()
  }, [])

  function analyze(): void {
    const needsRealFace = detectRealFace(goal)
    const ranked = rankProviders(PROVIDERS, {
      intent: goal,
      capability,
      needsRealFace,
      costInputs: { seconds, chars: 300, images: 1 }
    })
    setResults(ranked)
  }

  async function copyFxRequest(): Promise<void> {
    const request =
      `Use a skill /motion-graphics do HyperFrames para criar este FX: ${fxPrompt.trim()}. ` +
      `Use ${projectW}x${projectH}, ${projectFps} fps e fundo transparente. ` +
      `Depois chame a ferramenta generate_fx do Video Editor para adicionar o resultado na timeline em ${playhead.toFixed(2)} segundos.`
    await navigator.clipboard.writeText(request)
    setFxCopied(true)
  }

  const pctUsed = budget ? Math.min(100, (budget.spentUsd / Math.max(0.01, budget.totalUsd)) * 100) : 0

  return (
    <div className="producer-panel">
      <div className="insp-section">🤖 Produtor IA</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Diga o que você quer e eu escolho a melhor ferramenta (qualidade × custo × se aceita seu rosto), com
        estimativa de custo e controle de orçamento.
      </p>

      {/* Budget bar */}
      {budget && (
        <div className="budget-box">
          <div className="budget-row">
            <span>Orçamento ({budget.mode})</span>
            <span>
              ${budget.spentUsd.toFixed(2)} / ${budget.totalUsd.toFixed(2)}
            </span>
          </div>
          <div className="budget-bar">
            <div className="budget-fill" style={{ width: `${pctUsed}%` }} />
          </div>
          <div className="budget-row sub">
            <span>Restante: ${budget.remainingUsd.toFixed(2)}</span>
            <button className="btn-mini" onClick={onOpenSettings}>
              ajustar
            </button>
          </div>
        </div>
      )}

      <label className="field">
        O que você quer fazer?
        <textarea
          rows={3}
          value={goal}
          placeholder="Ex: colocar eu (rosto real) falando no meu estúdio roxo; ou animar uma imagem; ou narração em PT-BR…"
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <div className="ai-row">
        <label className="field small">
          Tipo
          <select value={capability} onChange={(e) => setCapability(e.target.value as Capability)}>
            {CAPS.map((c) => (
              <option key={c} value={c}>
                {CAPABILITY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="field small">
          Duração (s)
          <input type="number" min={1} max={60} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </label>
      </div>
      <button className="btn btn-primary full" onClick={analyze} disabled={!goal.trim()}>
        🔎 Analisar e recomendar
      </button>

      {results && (
        <>
          {detectRealFace(goal) && (
            <div className="producer-flag">
              👤 Detectei que envolve <b>seu rosto real</b> — priorizei ferramentas que o aceitam.
            </div>
          )}
          <div className="insp-section" style={{ marginTop: 10 }}>
            Recomendações
          </div>
          {results.slice(0, 6).map((r, i) => (
            <div key={r.provider.id} className={`provider-card ${i === 0 ? 'top' : ''}`}>
              <div className="provider-head">
                <span className="provider-name">
                  {i === 0 && '⭐ '}
                  {r.provider.name}
                </span>
                <span className="provider-score">{Math.round(r.weighted * 100)}</span>
              </div>
              <div className="provider-meta">
                <span className="provider-badge">{RUNTIME_BADGE[r.provider.runtime]}</span>
                <span className="provider-cost">{r.estCost === 0 ? 'grátis' : `~$${r.estCost.toFixed(2)}`}</span>
                {r.provider.callableNow && <span className="provider-badge ok">▶ roda no app</span>}
              </div>
              <div className="provider-reasons">{r.reasons.join(' · ')}</div>
              {r.provider.note && <div className="provider-note">{r.provider.note}</div>}
            </div>
          ))}
          <p className="hint">
            Dica: as marcadas <b>▶ roda no app</b> eu já disparo daqui. As de <b>🌐 Site</b> você gera lá e me manda o
            arquivo; as de <b>🔗 MCP</b> o Claude dispara; <b>💻 Local</b> precisa de setup.
          </p>
        </>
      )}

      <hr className="producer-sep" />
      <div className="insp-section">✨ FX com Codex · HyperFrames</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Gratuito e local. O Codex cria títulos, lower-thirds, partículas, gráficos e overlays transparentes e os coloca
        nesta timeline pelo MCP.
      </p>
      <label className="field">
        Descreva o efeito
        <textarea
          rows={3}
          value={fxPrompt}
          onChange={(e) => {
            setFxPrompt(e.target.value)
            setFxCopied(false)
          }}
        />
      </label>
      <button className="btn btn-primary full" onClick={copyFxRequest} disabled={!fxPrompt.trim()}>
        {fxCopied ? '✓ Pedido copiado — cole no Codex' : '✨ Copiar pedido para o Codex'}
      </button>
      <p className="hint">
        O efeito será criado em {projectW}×{projectH} e inserido na posição atual da agulha ({playhead.toFixed(2)}s).
      </p>

      <hr className="producer-sep" />
      <RemakePanel />

      <hr className="producer-sep" />
      <KlingPanel onOpenSettings={onOpenSettings} />

      <hr className="producer-sep" />
      <LipSyncPanel onOpenSettings={onOpenSettings} />
    </div>
  )
}
