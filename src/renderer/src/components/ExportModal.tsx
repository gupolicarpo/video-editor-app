import { useEffect, useMemo, useState } from 'react'
import { useEditor } from '../store'
import { rasterizeText } from '../textRender'
import { analyzeTimeline, VERDICT_LABEL } from '../quality'
import { clipVolumeGain } from '../../../shared/audio'

const PRESETS = [
  { label: '1080p 16:9', w: 1920, h: 1080 },
  { label: '720p 16:9', w: 1280, h: 720 },
  { label: '1080×1920 9:16 (Reels/Shorts)', w: 1080, h: 1920 },
  { label: '1080×1080 1:1', w: 1080, h: 1080 }
]

export function ExportModal({ onClose }: { onClose: () => void }): JSX.Element {
  const store = useEditor()
  const [w, setW] = useState(store.projectW)
  const [h, setH] = useState(store.projectH)
  const [fps, setFps] = useState(store.projectFps)
  const [rendering, setRendering] = useState(false)
  const [percent, setPercent] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [review, setReview] = useState<string[] | null>(null)
  const [outputPath, setOutputPath] = useState('')

  const report = useMemo(
    () => analyzeTimeline(store.clips, store.media, store.duration(), store.projectW, store.projectH),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.clips, store.media]
  )

  useEffect(() => {
    const off = window.api.onExportProgress((p) => setPercent(Math.round(p.percent)))
    return off
  }, [])

  // Post-render self-review: probe the output and sanity-check it.
  async function selfReview(outputPath: string, expectedDur: number): Promise<void> {
    const lines: string[] = []
    try {
      const meta = await window.api.probe(outputPath)
      lines.push(`Duração: ${meta.duration.toFixed(1)}s` + (expectedDur ? ` (esperado ${expectedDur.toFixed(1)}s)` : ''))
      if (expectedDur && Math.abs(meta.duration - expectedDur) / expectedDur > 0.05)
        lines.push('⚠️ Duração diverge >5% do esperado.')
      const expectAudio = store.masterVolume > 0 && store.clips.some(
        (c) =>
          (c.type === 'audio' && c.volume > 0) ||
          (c.type === 'video' && c.volume > 0 && store.media.find((m) => m.id === c.mediaId)?.hasAudio)
      )
      if (expectAudio && !meta.hasAudio) lines.push('⚠️ O projeto tinha áudio mas o MP4 saiu MUDO — verifique.')
      else if (meta.hasAudio) lines.push('✓ Faixa de áudio presente.')
      lines.push(`✓ Vídeo ${meta.width}×${meta.height}.`)
    } catch {
      lines.push('Não consegui inspecionar o arquivo exportado.')
    }
    setReview(lines)
  }

  async function chooseOutput(): Promise<void> {
    const selected = await window.api.saveFileDialog(outputPath || 'export.mp4')
    if (selected) {
      setOutputPath(selected)
      setError('')
      setDone(null)
    }
  }

  async function doExport(): Promise<void> {
    setError('')
    setDone(null)
    const st = useEditor.getState()
    const duration = st.duration()
    if (duration <= 0) {
      setError('Adicione clipes à timeline antes de exportar.')
      return
    }
    if (!outputPath) {
      setError('Escolha onde salvar o vídeo antes de renderizar.')
      return
    }

    const clips = []
    const anySolo = st.tracks.some((tr) => tr.solo)
    const silenced = (trackId: string): boolean => {
      const tr = st.tracks.find((x) => x.id === trackId)
      return !!tr && (!!tr.muted || (anySolo && !tr.solo))
    }
    for (const c of st.clips) {
      const common = {
        id: c.id,
        trackOrder: st.trackOrder(c.trackId),
        start: c.start,
        duration: c.duration,
        inPoint: c.inPoint,
        volume: silenced(c.trackId) ? 0 : clipVolumeGain(c.volume) * st.masterVolume,
        pan: c.pan,
        scale: c.scale,
        xFrac: c.xFrac,
        yFrac: c.yFrac,
        rotate: c.rotate ?? 0,
        opacity: c.opacity,
        fit: c.fit,
        speed: c.speed,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
        brightness: c.brightness,
        contrast: c.contrast,
        saturation: c.saturation,
        look: c.look,
        duck: c.duck,
        transition: c.transition,
        effects: c.effects,
        anim: c.anim,
        mask: c.mask
      }
      if (c.type === 'text') {
        // Rasterize the styled text to a full-canvas transparent PNG.
        const png = await rasterizeText(c, w, h)
        clips.push({
          ...common,
          mediaPath: png,
          type: 'image' as const,
          inPoint: 0,
          scale: 1,
          xFrac: 0,
          yFrac: 0,
          // o giro ja foi assado no PNG por drawTextClip, em torno do centro do
          // texto; aplicar de novo giraria a tela inteira
          rotate: 0,
          fit: 'fill' as const,
          hasAudio: false
        })
      } else {
        const m = st.media.find((mm) => mm.id === c.mediaId)!
        clips.push({
          ...common,
          mediaPath: c.type === 'audio' ? c.audioSourcePath || m.audioPath || m.path : m.path,
          audioPath: c.type === 'video' ? m.audioPath : null,
          type: c.type,
          hasAudio: c.type === 'audio' ? true : c.type === 'video' ? m.hasAudio : false
        })
      }
    }

    setRendering(true)
    setPercent(0)
    try {
      const res = await window.api.render({ outputPath, width: w, height: h, fps, duration, clips })
      if (res.ok) {
        setDone(res.outputPath)
        selfReview(res.outputPath, duration)
      } else {
        setError(res.error || 'Falha na exportação.')
      }
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setRendering(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Exportar vídeo</h2>

        <div className="settings-section">Resolução</div>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={`preset ${w === p.w && h === p.h ? 'active' : ''}`}
              onClick={() => {
                setW(p.w)
                setH(p.h)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="ai-row">
          <label className="field small">
            Largura
            <input type="number" value={w} onChange={(e) => setW(Number(e.target.value))} />
          </label>
          <label className="field small">
            Altura
            <input type="number" value={h} onChange={(e) => setH(Number(e.target.value))} />
          </label>
          <label className="field small">
            FPS
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              <option value={24}>24</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </label>
        </div>

        <div className="settings-section">Destino do arquivo</div>
        <div className="export-destination">
          <input
            type="text"
            readOnly
            value={outputPath}
            placeholder="Nenhum destino selecionado"
            title={outputPath}
          />
          <button className="btn" onClick={chooseOutput} disabled={rendering}>
            📁 Escolher…
          </button>
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          Você pode escolher qualquer disco interno ou HD externo.
        </p>

        <div className="settings-section">✅ Verificação de qualidade</div>
        <div className="quality-head">
          <span className="quality-badge" style={{ background: VERDICT_LABEL[report.verdict].color }}>
            {VERDICT_LABEL[report.verdict].label}
          </span>
          <span className="quality-sub">
            movimento {Math.round(report.motionRatio * 100)}% · risco {report.score.toFixed(1)}/5
          </span>
        </div>
        {report.findings.length === 0 ? (
          <p className="hint" style={{ marginTop: 4 }}>
            Nenhum problema detectado — pode exportar.
          </p>
        ) : (
          <div className="quality-findings">
            {report.findings.map((f, i) => (
              <div key={i} className={`quality-finding sev-${f.severity}`}>
                <b>
                  {f.severity === 'critico' ? '⛔' : f.severity === 'sugestao' ? '💡' : 'ℹ️'} {f.title}
                </b>
                <span>{f.action}</span>
              </div>
            ))}
          </div>
        )}

        {rendering && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${percent}%` }} />
            <span className="progress-label">{percent}%</span>
          </div>
        )}

        {done && (
          <div className="export-done">
            ✅ Exportado com sucesso!
            <button className="btn-mini" onClick={() => window.api.showItem(done)}>
              Abrir pasta
            </button>
          </div>
        )}
        {review && (
          <div className="self-review">
            <b>🔎 Auto-revisão do arquivo:</b>
            {review.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
        {error && <div className="ai-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={rendering}>
            Fechar
          </button>
          {rendering && (
            <button className="btn" onClick={() => window.api.cancelRender()}>
              ✕ Cancelar
            </button>
          )}
          <button className="btn btn-primary" onClick={doExport} disabled={rendering || !outputPath}>
            {rendering ? `Renderizando… ${percent}%` : outputPath ? '⬆ Renderizar MP4' : 'Escolha o destino'}
          </button>
        </div>
      </div>
    </div>
  )
}
