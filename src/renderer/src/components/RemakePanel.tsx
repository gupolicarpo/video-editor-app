import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'

interface Scene {
  index: number
  start: number
  duration: number
  framePath: string
}
interface Analysis {
  ok: boolean
  error?: string
  width?: number
  height?: number
  duration?: number
  audioPath?: string
  scenes?: Scene[]
}

const DEFAULT_PROMPT =
  'Recreate this exact shot as a higher-quality, fresher cinematic version. Keep the same composition, subject, framing, lighting mood and color palette. Upgrade detail and realism only; do not change the content or context.'

// Remake from existing (RIGHT method): keep audio, redo each original frame via
// image-to-image reference. Analysis is free; generation is per-scene (paid).
export function RemakePanel(): JSX.Element {
  const media = useEditor((s) => s.media)
  const selMediaId = useEditor((s) => s.clips.find((c) => c.id === s.selectedClipId)?.mediaId)
  const addMedia = useEditor((s) => s.addMedia)
  const addClip = useEditor((s) => s.addClip)
  const addTrack = useEditor((s) => s.addTrack)
  const updateClip = useEditor((s) => s.updateClip)
  const addEffect = useEditor((s) => s.addEffect)
  const setProject = useEditor((s) => s.setProject)

  const [source, setSource] = useState('')
  const [provider, setProvider] = useState<'luma' | 'openai'>('luma')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => window.api.onAiProgress((p) => setStatus(p.message)), [])

  const selMedia = media.find((m) => m.id === selMediaId && m.type === 'video')

  async function pickSource(): Promise<void> {
    const paths = await window.api.openFiles()
    const v = paths.find((p) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(p))
    if (v) setSource(v)
  }

  async function analyze(): Promise<void> {
    setErr('')
    const src = source || selMedia?.path
    if (!src) {
      setErr('Escolha um vídeo (ou selecione um clipe de vídeo na timeline).')
      return
    }
    setBusy(true)
    setStatus('Analisando…')
    try {
      const res = (await window.api.remakeAnalyze(src)) as Analysis
      if (res.ok) {
        setAnalysis(res)
        setStatus(`✅ ${res.scenes?.length} cenas detectadas.`)
      } else {
        setErr(res.error || 'Falha na análise.')
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const estPerScene = provider === 'openai' ? 0.21 : 0.05

  function sizeHint(): string {
    const w = analysis?.width || 16
    const h = analysis?.height || 9
    const r = w / h
    if (r > 1.2) return '1536x1024'
    if (r < 0.83) return '1024x1536'
    return '1024x1024'
  }

  async function refineScene(sc: Scene): Promise<string | null> {
    const res = await window.api.remakeRefine({ framePath: sc.framePath, prompt, provider, size: sizeHint() })
    if (res.ok && res.imagePath) return res.imagePath
    setErr(res.error || `Falha na cena ${sc.index}.`)
    return null
  }

  async function sample(): Promise<void> {
    if (!analysis?.scenes?.length) return
    setErr('')
    const est = estPerScene
    let rv = await window.api.budgetReserve({ tool: `remake:${provider}`, operation: 'sample', estimatedUsd: est })
    if (rv.needApproval) {
      if (!confirm(`${rv.reason}\n\nProsseguir?`)) return
      rv = await window.api.budgetReserve({ tool: `remake:${provider}`, operation: 'sample', estimatedUsd: est, approved: true })
    }
    if (!rv.ok) return setErr(rv.reason || 'Bloqueado pelo orçamento.')
    setBusy(true)
    try {
      const img = await refineScene(analysis.scenes[0])
      await window.api.budgetReconcile({ entryId: rv.entryId, actualUsd: est, success: !!img })
      if (img) {
        const meta = await window.api.probe(img)
        addMedia({
          id: nanoid(8),
          name: 'remake-amostra.png',
          path: img,
          type: 'image',
          duration: 5,
          width: meta.width,
          height: meta.height,
          hasAudio: false,
          hasVideo: true,
          fps: 30
        })
        setStatus('✅ Amostra na Mídia — compare com a cena 1 original antes de gerar tudo.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function generateAll(): Promise<void> {
    if (!analysis?.scenes?.length || !analysis.audioPath) return
    setErr('')
    const scenes = analysis.scenes
    const est = +(estPerScene * scenes.length).toFixed(2)
    let rv = await window.api.budgetReserve({ tool: `remake:${provider}`, operation: 'full', estimatedUsd: est })
    if (rv.needApproval) {
      if (!confirm(`${rv.reason}\n\nGerar ${scenes.length} cenas por ~$${est.toFixed(2)}?`)) return
      rv = await window.api.budgetReserve({ tool: `remake:${provider}`, operation: 'full', estimatedUsd: est, approved: true })
    }
    if (!rv.ok) return setErr(rv.reason || 'Bloqueado pelo orçamento.')

    setBusy(true)
    try {
      // 1) refine every scene
      const imgs: (string | null)[] = []
      for (const sc of scenes) {
        setStatus(`Refazendo cena ${sc.index}/${scenes.length}…`)
        imgs.push(await refineScene(sc))
      }
      const okCount = imgs.filter(Boolean).length
      await window.api.budgetReconcile({ entryId: rv.entryId, actualUsd: +(estPerScene * okCount).toFixed(2), success: okCount > 0 })
      if (okCount === 0) {
        setErr('Nenhuma cena gerada.')
        return
      }

      // 2) assemble on the timeline (match source dims + timings), keep original audio
      setStatus('Montando na timeline…')
      if (analysis.width && analysis.height) setProject({ projectW: analysis.width, projectH: analysis.height })
      addTrack('video')
      const vTrack = useEditor.getState().tracks[0].id
      addTrack('audio')
      const aTracks = useEditor.getState().tracks.filter((t) => t.kind === 'audio')
      const aTrack = aTracks[aTracks.length - 1].id

      // audio
      const aMeta = await window.api.probe(analysis.audioPath)
      const aId = nanoid(8)
      addMedia({ id: aId, name: 'remake-audio.m4a', path: analysis.audioPath, type: 'audio', duration: aMeta.duration, width: 0, height: 0, hasAudio: true, hasVideo: false, fps: 30 })
      addClip(aId, aTrack, 0)
      const aClip = useEditor.getState().selectedClipId
      if (aClip) updateClip(aClip, { duration: aMeta.duration })

      // images
      for (let i = 0; i < scenes.length; i++) {
        const img = imgs[i]
        if (!img) continue
        const sc = scenes[i]
        const meta = await window.api.probe(img)
        const id = nanoid(8)
        addMedia({ id, name: `remake_${sc.index}.png`, path: img, type: 'image', duration: sc.duration, width: meta.width, height: meta.height, hasAudio: false, hasVideo: true, fps: 30 })
        addClip(id, vTrack, sc.start)
        const cid = useEditor.getState().selectedClipId
        if (cid) {
          updateClip(cid, { duration: sc.duration, fit: 'cover' })
          addEffect(cid, 'kenburns')
        }
      }
      setStatus(`✅ Remake montado: ${okCount}/${scenes.length} cenas + áudio original. Veja no preview.`)
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="remake-panel">
      <div className="insp-section">🔁 Remake com referência</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Refaz um vídeo existente: mantém o <b>áudio original</b> e recria cada cena a partir do <b>frame original</b>{' '}
        (image-to-image), como upgrade fiel — não invenção por texto.
      </p>

      <div className="ls-pick">
        <button className="btn btn-sec" onClick={pickSource}>
          🎞 Vídeo fonte
        </button>
        <span className="ls-file" title={source || selMedia?.path}>
          {source ? source.split(/[\\/]/).pop() : selMedia ? `(clipe) ${selMedia.name}` : 'nenhum'}
        </span>
      </div>
      <button className="btn full" onClick={analyze} disabled={busy}>
        {busy && !analysis ? 'Analisando…' : '🔍 Analisar cenas (grátis)'}
      </button>

      {analysis?.scenes && (
        <>
          <div className="insp-row">
            <span>Cenas</span>
            <span>{analysis.scenes.length}</span>
          </div>
          <div className="provider-switch">
            <button className={provider === 'luma' ? 'seg active' : 'seg'} onClick={() => setProvider('luma')}>
              Luma (referência)
            </button>
            <button className={provider === 'openai' ? 'seg active' : 'seg'} onClick={() => setProvider('openai')}>
              gpt-image-2 (alta)
            </button>
          </div>
          <label className="field">
            Prompt de upgrade
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="insp-row">
            <span>Custo estimado (tudo)</span>
            <span>~${(estPerScene * analysis.scenes.length).toFixed(2)}</span>
          </div>
          <button className="btn btn-sec full" onClick={sample} disabled={busy}>
            🧪 Gerar amostra (cena 1)
          </button>
          <button className="btn btn-primary full" onClick={generateAll} disabled={busy}>
            🔁 Gerar tudo + montar
          </button>
        </>
      )}

      {status && <div className="ai-status">{status}</div>}
      {err && <div className="ai-error">{err}</div>}
    </div>
  )
}
