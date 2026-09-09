import { useEffect, useState } from 'react'
import { useEditor } from '../store'
import { fmtTime } from '../util'
import type { MediaItem } from '../types'

export function MediaLibrary({ search = '' }: { search?: string }): JSX.Element {
  const media = useEditor((s) => s.media)
  const tracks = useEditor((s) => s.tracks)
  const clips = useEditor((s) => s.clips)
  const addClip = useEditor((s) => s.addClip)
  const addTrack = useEditor((s) => s.addTrack)
  const removeMedia = useEditor((s) => s.removeMedia)
  const removeUnusedMedia = useEditor((s) => s.removeUnusedMedia)
  const relinkMedia = useEditor((s) => s.relinkMedia)

  // Files can disappear from disk after import (moved/renamed). Flag them here
  // so a broken export isn't the first time you find out.
  const [missing, setMissing] = useState<Set<string>>(new Set())
  useEffect(() => {
    const paths = media.map((m) => m.path)
    void window.api.checkMissingMedia(paths).then((gone) => setMissing(new Set(gone)))
  }, [media])

  const usedIds = new Set(clips.map((c) => c.mediaId))
  const unusedCount = media.filter((m) => !usedIds.has(m.id)).length

  function cleanup(): void {
    const n = removeUnusedMedia()
    if (n > 0) alert(`${n} mídia(s) não usada(s) removida(s) da biblioteca.`)
  }

  const [relocating, setRelocating] = useState(false)
  // Point the user at one folder and relink every missing file whose name
  // turns up somewhere under it — moving a project folder breaks every path
  // identically, so fixing them one by one would just be repeating this.
  async function relocate(): Promise<void> {
    const missingItems = media.filter((m) => missing.has(m.path))
    const names = [...new Set(missingItems.map((m) => m.path.split(/[\\/]/).pop() || m.path))]
    if (names.length === 0) return
    setRelocating(true)
    try {
      const found = await window.api.relocateMedia(names)
      let n = 0
      for (const m of missingItems) {
        const name = m.path.split(/[\\/]/).pop() || m.path
        const newPath = found[name]
        if (newPath) {
          relinkMedia(m.id, newPath)
          n++
        }
      }
      if (Object.keys(found).length > 0) {
        alert(`${n} de ${missingItems.length} arquivo(s) relocalizado(s).`)
      }
    } finally {
      setRelocating(false)
    }
  }

  // Drop a clip on the timeline at the playhead. Overlays reuse the TOP video
  // track (only spawning a new one if that spot is occupied), so adding many
  // icons doesn't explode into a track per icon.
  function quickAdd(m: MediaItem, overlay = false): void {
    // Read at click time. Subscribing meant the WHOLE library — every card with
    // a <video> thumbnail — re-rendered 60×/s during playback.
    const playhead = useEditor.getState().playhead
    if (m.type === 'audio') {
      const t = tracks.find((tk) => tk.kind === 'audio')
      if (t) addClip(m.id, t.id, playhead)
      return
    }
    if (overlay) {
      const dur = m.type === 'image' ? 5 : m.duration || 3
      const videoTracks = tracks.filter((tk) => tk.kind === 'video') // top-to-bottom
      const free = videoTracks.find(
        (tk) => !clips.some((c) => c.trackId === tk.id && c.start < playhead + dur && c.start + c.duration > playhead)
      )
      if (free) {
        addClip(m.id, free.id, playhead)
      } else {
        addTrack('video') // all occupied here — one new track, inserted at top
        const top = useEditor.getState().tracks.find((tk) => tk.kind === 'video')
        if (top) addClip(m.id, top.id, playhead)
      }
      return
    }
    const t = tracks.find((tk) => tk.kind === 'video')
    if (t) addClip(m.id, t.id, playhead)
  }

  const q = search.trim().toLowerCase()
  const matches = (m: MediaItem): boolean => !q || m.name.toLowerCase().includes(q)
  const videos = media.filter((m) => m.type === 'video' && matches(m))
  const images = media.filter((m) => m.type === 'image' && matches(m))
  const audio = media.filter((m) => m.type === 'audio' && matches(m))

  // Compact grid card (FlexClip-style): duration badge over the thumbnail,
  // name below, tiny actions. Drag still works; ＋ drops at the playhead.
  const Card = ({ m, overlay }: { m: MediaItem; overlay?: boolean }): JSX.Element => (
    <div
      className={missing.has(m.path) ? 'media-card compact missing' : 'media-card compact'}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-media-id', m.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={`${m.name}${m.width ? ` · ${m.width}×${m.height}` : ''}`}
    >
      <div className="media-thumb">
        {m.type === 'video' && (
          <video src={window.api.mediaUrl(m.path)} muted preload="metadata" draggable={false} />
        )}
        {m.type === 'image' && <img src={window.api.mediaUrl(m.path)} alt={m.name} draggable={false} />}
        {m.type === 'audio' && <div className="audio-icon">🎵</div>}
        {m.type !== 'image' && <span className="media-dur">{fmtTime(m.duration)}</span>}
        {missing.has(m.path) && (
          <span className="media-gone" title={`Arquivo não está mais em ${m.path}`}>
            ⚠ sumiu
          </span>
        )}
      </div>
      <div className="media-name" title={m.name}>
        {m.name}
      </div>
      <div className="media-sub">
        {m.width ? `${m.width}×${m.height}` : m.type === 'audio' ? 'áudio' : ''}
      </div>
      {/* Actions stay VISIBLE. Hiding them behind hover made a grid of small
          thumbnails look like the features had been removed. */}
      <div className="media-actions">
        <button className="btn-mini" title={overlay ? 'Sobrepor no vídeo' : 'Colocar na timeline'} onClick={() => quickAdd(m, overlay)}>
          {overlay ? '＋ Sobrepor' : '＋ Timeline'}
        </button>
        <button className="btn-mini ghost" title="Remover da biblioteca" onClick={() => removeMedia(m.id)}>
          ✕
        </button>
      </div>
    </div>
  )

  return (
    <>
      {missing.size > 0 && (
        <div className="missing-banner">
          <span className="missing-banner-icon">⚠</span>
          <span className="missing-banner-text">{missing.size} arquivo(s) ausente(s)</span>
          <button className="missing-banner-action" onClick={relocate} disabled={relocating}>
            {relocating ? 'Procurando…' : 'Relocalizar'}
          </button>
        </div>
      )}

      {unusedCount > 0 && (
        <div className="media-toolbar">
          <span>{unusedCount} não usada(s)</span>
          <button className="btn-mini" onClick={cleanup} title="Remove da biblioteca as mídias sem nenhum clipe">
            🧹 Limpar não usada
          </button>
        </div>
      )}

      {/* Sections are always shown so each media type has a visible home — you
          can see where an imported icon will land before importing it. */}
      <section className="media-section">
        <h4 className="media-section-head">🎬 Vídeos {videos.length > 0 && <span>({videos.length})</span>}</h4>
        {videos.length > 0 ? (
          <div className="media-grid">
            {videos.map((m) => (
              <Card key={m.id} m={m} />
            ))}
          </div>
        ) : (
          <p className="hint">Grave com 🎥 ou importe um vídeo.</p>
        )}
      </section>

      <section className="media-section">
        <h4 className="media-section-head">🖼 Ícones e sobreposições {images.length > 0 && <span>({images.length})</span>}</h4>
        {images.length > 0 ? (
          <>
            <p className="hint">
              Arraste sobre o vídeo, ou use <b>+ Sobrepor</b> (entra numa faixa por cima). Dê a forma
              no Inspetor (máscara) e anime.
            </p>
            <div className="media-grid">
              {images.map((m) => (
                <Card key={m.id} m={m} overlay />
              ))}
            </div>
          </>
        ) : (
          <p className="hint">
            Importe um PNG (de preferência com fundo transparente) para usar como ícone ou animação
            sobre o vídeo. Ele aparece aqui, separado dos vídeos.
          </p>
        )}
      </section>

      {audio.length > 0 && (
        <section className="media-section">
          <h4 className="media-section-head">🎵 Áudio <span>({audio.length})</span></h4>
          <div className="media-grid">
            {audio.map((m) => (
              <Card key={m.id} m={m} />
            ))}
          </div>
        </section>
      )}
    </>
  )
}
