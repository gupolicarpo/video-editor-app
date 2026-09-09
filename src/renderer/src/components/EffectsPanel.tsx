import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import { EFFECTS, CAMERA_MOTIONS } from '../motion'
import { LOOKS, getLook, lookCss } from '../../../shared/looks'
import type { EffectType, MediaItem } from '../types'
import type { LookId } from '../../../shared/looks'

type Section = 'textura' | 'movimento' | 'overlay'

const FX_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'particulas', label: 'Partículas' },
  { id: 'luz', label: 'Luz' },
  { id: 'clima', label: 'Clima' },
  { id: 'moldura', label: 'Moldura' }
]

interface FxDef {
  id: string
  label: string
  group: string
  seconds: number
  hint: string
}

/**
 * Grab one frame of the selected clip to preview looks against. Every look tile
 * then shows the user's *own* footage graded, which is the only way to judge a
 * grade — a stock swatch tells you nothing about what it does to their skin
 * tones or their sky.
 */
function useClipThumb(): string | null {
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const clips = useEditor((s) => s.clips)
  const media = useEditor((s) => s.media)
  const [url, setUrl] = useState<string | null>(null)

  const clip = clips.find((c) => c.id === selectedClipId)
  const m = clip ? media.find((x) => x.id === clip.mediaId) : undefined
  const path = m && (m.type === 'video' || m.type === 'image') ? m.path : undefined
  // Sample a little inside the clip: the very first frame is often black.
  const at = clip ? clip.inPoint + Math.min(1, clip.duration / 3) : 0

  useEffect(() => {
    if (!path) {
      setUrl(null)
      return
    }
    let dead = false
    const draw = (el: HTMLVideoElement | HTMLImageElement, w: number, h: number): void => {
      if (dead) return
      const cv = document.createElement('canvas')
      const scale = Math.min(1, 320 / Math.max(1, w))
      cv.width = Math.max(1, Math.round(w * scale))
      cv.height = Math.max(1, Math.round(h * scale))
      const g = cv.getContext('2d')
      if (!g) return
      g.drawImage(el as CanvasImageSource, 0, 0, cv.width, cv.height)
      setUrl(cv.toDataURL('image/jpeg', 0.72))
    }
    const src = window.api.mediaUrl(path)
    if (m?.type === 'image') {
      const img = new Image()
      img.onload = () => draw(img, img.naturalWidth, img.naturalHeight)
      img.src = src
      return () => {
        dead = true
      }
    }
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.onloadeddata = () => {
      v.currentTime = at
    }
    v.onseeked = () => draw(v, v.videoWidth, v.videoHeight)
    v.src = src
    return () => {
      dead = true
      v.removeAttribute('src')
      v.load()
    }
  }, [path, at, m?.type])

  return url
}

export function EffectsPanel(): JSX.Element {
  const [tab, setTab] = useState<Section>('textura')
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const clips = useEditor((s) => s.clips)
  const tracks = useEditor((s) => s.tracks)
  const media = useEditor((s) => s.media)
  const projectW = useEditor((s) => s.projectW)
  const projectH = useEditor((s) => s.projectH)
  const projectFps = useEditor((s) => s.projectFps)
  const setLook = useEditor((s) => s.setLook)
  const addEffect = useEditor((s) => s.addEffect)
  const removeEffect = useEditor((s) => s.removeEffect)
  const addMedia = useEditor((s) => s.addMedia)
  const addClip = useEditor((s) => s.addClip)
  const addTrack = useEditor((s) => s.addTrack)

  const clip = clips.find((c) => c.id === selectedClipId)
  const thumb = useClipThumb()

  const [fx, setFx] = useState<FxDef[]>([])
  const [busyFx, setBusyFx] = useState<string | null>(null)
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState('')
  const offRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    void window.api.fxCatalog().then(setFx)
    offRef.current = window.api.onFxProgress(setPct)
    return () => offRef.current?.()
  }, [])

  const currentLook: LookId = (clip?.look as LookId) ?? 'none'
  const activeMotion = clip?.effects?.find((e) => CAMERA_MOTIONS.has(e.type))
  const activeLookFx = new Set((clip?.effects || []).map((e) => e.type))

  function toggleEffect(type: EffectType): void {
    if (!clip) return
    const existing = clip.effects?.find((e) => e.type === type)
    if (existing) removeEffect(clip.id, existing.id)
    else addEffect(clip.id, type)
  }

  // FX land on the topmost free video track at the playhead — over the footage,
  // never pushing the footage aside.
  async function placeFx(def: FxDef): Promise<void> {
    setErr('')
    setBusyFx(def.id)
    setPct(0)
    try {
      const res = await window.api.fxRender({
        id: def.id,
        width: projectW,
        height: projectH,
        fps: projectFps,
        seconds: def.seconds
      })
      if (!res.ok || !res.path) {
        setErr(res.error || 'Falhou ao gerar o efeito.')
        return
      }
      let item = media.find((x) => x.path === res.path)
      if (!item) {
        const meta = await window.api.probe(res.path)
        item = {
          id: nanoid(8),
          name: def.label,
          path: res.path,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        } as MediaItem
        addMedia(item)
      }
      const playhead = useEditor.getState().playhead
      const dur = item.duration || def.seconds
      const videoTracks = tracks.filter((t) => t.kind === 'video')
      const free = videoTracks.find(
        (t) =>
          !clips.some(
            (c) => c.trackId === t.id && c.start < playhead + dur && c.start + c.duration > playhead
          )
      )
      if (free) {
        addClip(item.id, free.id, playhead)
      } else {
        addTrack('video')
        const top = useEditor.getState().tracks.find((t) => t.kind === 'video')
        if (top) addClip(item.id, top.id, playhead)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyFx(null)
    }
  }

  const swatch = (lookId: LookId): React.CSSProperties => {
    const l = getLook(lookId)
    return {
      filter: l ? lookCss(l) : undefined,
      backgroundImage: thumb ? `url(${thumb})` : 'linear-gradient(135deg,#7a5cff,#ff7a59 55%,#ffd23f)',
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }
  }

  return (
    <>
      <div className="seg-tabs">
        {(
          [
            ['textura', '🎨 Textura'],
            ['movimento', '🎥 Movimento'],
            ['overlay', '✨ Sobreposições']
          ] as Array<[Section, string]>
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'seg on' : 'seg'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {!clip && tab !== 'overlay' && (
        <p className="hint">Selecione um clipe na timeline para aplicar.</p>
      )}

      {tab === 'textura' && (
        <>
          <p className="hint">
            Cor do clipe. O preview mostra exatamente o que sai no export — mesma matriz de cor nos
            dois lados{clip ? '' : '. Selecione um clipe para ver no seu próprio material'}.
          </p>
          <div className="fx-grid">
            {LOOKS.map((l) => (
              <button
                key={l.id}
                className={currentLook === l.id ? 'fx-tile on' : 'fx-tile'}
                disabled={!clip}
                onClick={() => clip && setLook(clip.id, l.id)}
                title={l.label}
              >
                <span className="fx-swatch" style={swatch(l.id)}>
                  {l.vignette ? <i className="fx-vig" style={{ opacity: l.vignette }} /> : null}
                </span>
                <span className="fx-label">{l.label}</span>
              </button>
            ))}
          </div>
          {getLook(currentLook)?.grain ? (
            <p className="hint">
              O grão aparece aproximado no preview (o ffmpeg sorteia ruído por pixel no export).
            </p>
          ) : null}
        </>
      )}

      {tab === 'movimento' && (
        <>
          <p className="hint">
            Câmera e foco. Movimentos de câmera são exclusivos — escolher um troca o anterior.
          </p>
          <div className="fx-list">
            {EFFECTS.map((e) => {
              const on = CAMERA_MOTIONS.has(e.type)
                ? activeMotion?.type === e.type
                : activeLookFx.has(e.type)
              return (
                <button
                  key={e.type}
                  className={on ? 'fx-row on' : 'fx-row'}
                  disabled={!clip}
                  onClick={() => toggleEffect(e.type)}
                >
                  <span>{e.label}</span>
                  <span className="fx-check">{on ? '✓' : '+'}</span>
                </button>
              )
            })}
          </div>
          <p className="hint">Ajuste intensidade e tempo de cada um no Inspetor.</p>
        </>
      )}

      {tab === 'overlay' && (
        <>
          <p className="hint">
            Gerados aqui na sua máquina em WebM com transparência real, e guardados em cache — na
            segunda vez entram na hora. Caem numa faixa por cima, na agulha.
          </p>
          {FX_GROUPS.map((grp) => {
            const items = fx.filter((f) => f.group === grp.id)
            if (!items.length) return null
            return (
              <div key={grp.id}>
                <div className="insp-section">{grp.label}</div>
                <div className="fx-list">
                  {items.map((f) => (
                    <button
                      key={f.id}
                      className="fx-row"
                      disabled={busyFx !== null}
                      onClick={() => void placeFx(f)}
                      title={f.hint}
                    >
                      <span>
                        {f.label}
                        <em className="fx-hint">{f.hint}</em>
                      </span>
                      <span className="fx-check">
                        {busyFx === f.id ? `${pct}%` : `${f.seconds}s`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {err && <p className="ai-error">{err}</p>}
        </>
      )}
    </>
  )
}
