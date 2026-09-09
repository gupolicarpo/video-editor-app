import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import type { Clip } from '../types'

/**
 * Background removal for a video clip (RobustVideoMatting, runs locally).
 *
 * The result is a WebM/VP9 with a real alpha channel, which both the preview
 * (Chromium) and the export (ffmpeg) already composite. Put an image on a track
 * *below* the matted clip and it shows through.
 */
export function MattePanel({ clip, mediaPath }: { clip: Clip; mediaPath: string }): JSX.Element | null {
  const addMedia = useEditor((s) => s.addMedia)
  const updateClip = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [info, setInfo] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void window.api.matteAvailable().then(setAvailable)
  }, [])
  useEffect(() => window.api.onMatteProgress((p) => setPct(Math.round(p * 100))), [])

  if (clip.type !== 'video') return null

  async function run(): Promise<void> {
    setErr('')
    setInfo('')
    setBusy(true)
    setPct(0)
    try {
      const res = await window.api.matteClip(mediaPath)
      const meta = await window.api.probe(res.path)
      const id = nanoid(8)
      addMedia({
        id,
        name: res.path.split(/[\\/]/).pop() || 'sem-fundo.webm',
        path: res.path,
        type: meta.type,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        hasAudio: meta.hasAudio,
        hasVideo: meta.hasVideo,
        fps: meta.fps
      })
      commit()
      // inPoint resets: the matted file starts where the source clip's media did.
      updateClip(clip.id, { mediaId: id, inPoint: 0, duration: meta.duration })
      setInfo(`${res.frames} quadros · ${res.provider.replace('ExecutionProvider', '')}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <h4>✂ Remover fundo</h4>
      {available === false ? (
        <p className="hint">
          Requer Python com <code>onnxruntime</code> e <code>numpy</code>.
        </p>
      ) : (
        <>
          <button className="btn" onClick={run} disabled={busy || available !== true}>
            {busy ? `Recortando… ${pct}%` : '✂ Remover fundo deste clipe'}
          </button>
          {info && <p className="hint">✓ {info}</p>}
          {err && <p className="ai-error">{err}</p>}
          <p className="hint">
            Gera um WebM com transparência e troca o clipe por ele. Ponha a imagem de fundo numa faixa
            abaixo. O áudio é preservado.
          </p>
        </>
      )}
    </div>
  )
}
