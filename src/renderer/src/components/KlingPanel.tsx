import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import { KLING_MODELS, KLING_TAIL_MODELS } from '../ai/kling-models'

type KType = 't2v' | 'i2v' | 'i2v_tail'

// General Kling generation — full model/type/mode choice (developer API, paid).
export function KlingPanel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const [type, setType] = useState<KType>('t2v')
  const [model, setModel] = useState('kling-v2-6')
  const [mode, setMode] = useState<'std' | 'pro'>('pro')
  const [duration, setDuration] = useState(5)
  const [aspect, setAspect] = useState('16:9')
  const [prompt, setPrompt] = useState('')
  const [image, setImage] = useState('')
  const [tail, setTail] = useState('')
  const [hasKeys, setHasKeys] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    window.api.getSettings().then((s: any) => setHasKeys(!!s.klingAccessKey && !!s.klingSecretKey))
    const off = window.api.onAiProgress((p) => setStatus(p.message))
    return off
  }, [])

  // Models available for the current type (last-frame needs a tail-capable model).
  const models = type === 'i2v_tail' ? KLING_TAIL_MODELS : KLING_MODELS
  useEffect(() => {
    if (!models.find((m) => m.id === model)) setModel(models[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  async function pick(setter: (p: string) => void): Promise<void> {
    const paths = await window.api.openFiles()
    const img = paths.find((p) => /\.(png|jpe?g|webp)$/i.test(p))
    if (img) setter(img)
  }
  const fileName = (p: string): string => p.split(/[\\/]/).pop() || ''

  async function run(): Promise<void> {
    setErr('')
    if (!hasKeys) {
      setErr('Configure Access Key + Secret do Kling (API) em ⚙ Configurações.')
      onOpenSettings()
      return
    }
    if (type === 't2v' && !prompt.trim()) return setErr('Escreva um prompt.')
    if (type !== 't2v' && !image) return setErr('Escolha a imagem inicial.')
    if (type === 'i2v_tail' && !tail) return setErr('Escolha a imagem final (last frame).')

    const estimatedUsd = +(0.1 * duration).toFixed(2)
    let reserve = await window.api.budgetReserve({ tool: `kling:${type}`, operation: 'kling_gen', estimatedUsd })
    if (reserve.needApproval) {
      if (!confirm(`${reserve.reason}\n\nProsseguir?`)) return
      reserve = await window.api.budgetReserve({ tool: `kling:${type}`, operation: 'kling_gen', estimatedUsd, approved: true })
    }
    if (!reserve.ok) return setErr(reserve.reason || 'Bloqueado pelo orçamento.')

    setBusy(true)
    setStatus('Iniciando…')
    try {
      const res = await window.api.klingGenerate({
        type,
        model,
        mode,
        duration,
        prompt,
        aspectRatio: aspect,
        imagePath: type !== 't2v' ? image : undefined,
        tailPath: type === 'i2v_tail' ? tail : undefined
      })
      await window.api.budgetReconcile({ entryId: reserve.entryId, actualUsd: estimatedUsd, success: !!res.ok })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        addMedia({
          id: nanoid(8),
          name: res.mediaPath.split(/[\\/]/).pop() || 'kling.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        setStatus('✅ Vídeo do Kling adicionado à Mídia.')
      } else {
        setErr(res.error || 'Falha na geração Kling.')
        setStatus('')
      }
    } catch (e: any) {
      await window.api.budgetReconcile({ entryId: reserve.entryId, actualUsd: 0, success: false })
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kling-panel">
      <div className="insp-section">🎬 Gerar com Kling (API)</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Escolha o tipo, o modelo e o modo. API paga (créditos de desenvolvedor). {!hasKeys && '⚠️ Faltam as chaves.'}
      </p>

      <div className="provider-switch">
        <button className={type === 't2v' ? 'seg active' : 'seg'} onClick={() => setType('t2v')}>
          Texto→vídeo
        </button>
        <button className={type === 'i2v' ? 'seg active' : 'seg'} onClick={() => setType('i2v')}>
          Imagem→vídeo
        </button>
        <button className={type === 'i2v_tail' ? 'seg active' : 'seg'} onClick={() => setType('i2v_tail')}>
          1º+último frame
        </button>
      </div>

      <label className="field small">
        Modelo
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </select>
      </label>

      <div className="ai-row">
        <label className="field small">
          Modo
          <select value={mode} onChange={(e) => setMode(e.target.value as 'std' | 'pro')}>
            <option value="std">Standard</option>
            <option value="pro">Pro</option>
          </select>
        </label>
        <label className="field small">
          Duração
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
          </select>
        </label>
        {type === 't2v' && (
          <label className="field small">
            Proporção
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
          </label>
        )}
      </div>

      {type !== 't2v' && (
        <div className="ls-pick">
          <button className="btn btn-sec" onClick={() => pick(setImage)}>
            🖼 Imagem inicial
          </button>
          <span className="ls-file" title={image}>
            {image ? fileName(image) : 'nenhuma'}
          </span>
        </div>
      )}
      {type === 'i2v_tail' && (
        <div className="ls-pick">
          <button className="btn btn-sec" onClick={() => pick(setTail)}>
            🏁 Imagem final
          </button>
          <span className="ls-file" title={tail}>
            {tail ? fileName(tail) : 'nenhuma'}
          </span>
        </div>
      )}

      <label className="field">
        <textarea
          rows={2}
          value={prompt}
          placeholder={type === 't2v' ? 'Descreva o vídeo…' : 'Movimento/estilo (opcional)…'}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>

      <button className="btn btn-primary full" onClick={run} disabled={busy}>
        {busy ? 'Processando…' : '🎬 Gerar com Kling'}
      </button>
      {status && <div className="ai-status">{status}</div>}
      {err && <div className="ai-error">{err}</div>}
    </div>
  )
}
