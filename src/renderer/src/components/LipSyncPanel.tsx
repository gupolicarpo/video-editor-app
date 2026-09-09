import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import { PROVIDERS } from '../ai/providers'

// HeyGen lip-sync: a photo of you + your audio (or text) → you "talking".
export function LipSyncPanel({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const [photo, setPhoto] = useState('')
  const [audio, setAudio] = useState('')
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'audio' | 'text'>('audio')
  const [voiceId, setVoiceId] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    window.api.getSettings().then((s: any) => setHasKey(!!s.heygenApiKey))
    const off = window.api.onAiProgress((p) => setStatus(p.message))
    return off
  }, [])

  async function pickPhoto(): Promise<void> {
    const paths = await window.api.openFiles()
    const img = paths.find((p) => /\.(png|jpe?g|webp)$/i.test(p))
    if (img) setPhoto(img)
  }
  async function pickAudio(): Promise<void> {
    const paths = await window.api.openFiles()
    const a = paths.find((p) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(p))
    if (a) setAudio(a)
  }

  async function run(): Promise<void> {
    setErr('')
    if (!hasKey) {
      setErr('Configure a chave da HeyGen em ⚙ Configurações.')
      onOpenSettings()
      return
    }
    if (!photo) {
      setErr('Escolha uma foto sua (ex: a imagem do estúdio do Kling).')
      return
    }
    if (mode === 'audio' && !audio) {
      setErr('Escolha o arquivo de áudio com sua voz.')
      return
    }
    if (mode === 'text' && !text.trim()) {
      setErr('Escreva o texto a ser falado.')
      return
    }

    // Cost estimate + budget reserve
    const prov = PROVIDERS.find((p) => p.id === 'heygen')!
    let seconds = 15
    if (mode === 'audio') {
      try {
        const meta = await window.api.probe(audio)
        if (meta?.duration) seconds = meta.duration
      } catch {
        /* keep default */
      }
    }
    const estimatedUsd = prov.estimateCost({ seconds })
    let reserve = await window.api.budgetReserve({ tool: 'heygen', operation: 'lipsync', estimatedUsd })
    if (reserve.needApproval) {
      if (!confirm(`${reserve.reason}\n\nProsseguir mesmo assim?`)) return
      reserve = await window.api.budgetReserve({ tool: 'heygen', operation: 'lipsync', estimatedUsd, approved: true })
    }
    if (!reserve.ok) {
      setErr(reserve.reason || 'Bloqueado pelo orçamento.')
      return
    }

    setBusy(true)
    setStatus('Iniciando…')
    try {
      const res = await window.api.heygenGenerate({
        photoPath: photo,
        audioPath: mode === 'audio' ? audio : undefined,
        text: mode === 'text' ? text : undefined,
        voiceId: voiceId || undefined
      })
      await window.api.budgetReconcile({ entryId: reserve.entryId, actualUsd: estimatedUsd, success: !!res.ok })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        addMedia({
          id: nanoid(8),
          name: res.mediaPath.split(/[\\/]/).pop() || 'heygen.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        setStatus('✅ Vídeo falado adicionado à Mídia.')
      } else {
        setErr(res.error || 'Falha na geração HeyGen.')
        setStatus('')
      }
    } catch (e: any) {
      await window.api.budgetReconcile({ entryId: reserve.entryId, actualUsd: 0, success: false })
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const fileName = (p: string): string => p.split(/[\\/]/).pop() || ''

  return (
    <div className="lipsync-panel">
      <div className="insp-section">🎤 Lip-sync (HeyGen) — você falando</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Uma foto sua (ex: a do estúdio) + sua voz (ou um texto) → você falando, com lip-sync. {!hasKey && '⚠️ Precisa da chave HeyGen.'}
      </p>

      <div className="ls-pick">
        <button className="btn btn-sec" onClick={pickPhoto}>
          🖼 Foto
        </button>
        <span className="ls-file" title={photo}>
          {photo ? fileName(photo) : 'nenhuma'}
        </span>
      </div>

      <div className="provider-switch" style={{ marginTop: 8 }}>
        <button className={mode === 'audio' ? 'seg active' : 'seg'} onClick={() => setMode('audio')}>
          Minha voz (áudio)
        </button>
        <button className={mode === 'text' ? 'seg active' : 'seg'} onClick={() => setMode('text')}>
          Texto + voz IA
        </button>
      </div>

      {mode === 'audio' ? (
        <div className="ls-pick">
          <button className="btn btn-sec" onClick={pickAudio}>
            🎵 Áudio
          </button>
          <span className="ls-file" title={audio}>
            {audio ? fileName(audio) : 'nenhum'}
          </span>
        </div>
      ) : (
        <>
          <label className="field">
            <textarea
              rows={3}
              value={text}
              placeholder="Texto que você quer falar…"
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label className="field small">
            Voice ID (HeyGen)
            <input value={voiceId} placeholder="opcional" onChange={(e) => setVoiceId(e.target.value)} />
          </label>
        </>
      )}

      <button className="btn btn-primary full" onClick={run} disabled={busy}>
        {busy ? 'Processando…' : '🎤 Gerar você falando'}
      </button>
      {status && <div className="ai-status">{status}</div>}
      {err && <div className="ai-error">{err}</div>}
    </div>
  )
}
