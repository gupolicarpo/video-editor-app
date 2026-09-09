import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEditor } from '../store'
import type { Clip } from '../types'
import { fmtTime } from '../util'
import { getThumbnail } from '../mediaTools'
import { findRippleFollowers } from '../rippleTrim'
import { applyTrimRipple, clampTrimDelta, trimPatch } from '../groupTrim'

// Zoom runs on a LOGARITHMIC slider. Linear was unusable: the range is
// 0.2..400 px/s, so one pixel of a 200px track jumped 2px/s — at the low end
// (where a 56-minute recording lives) a single nudge doubled the zoom, and at
// the high end nothing moved. Log scale makes every step the same *relative*
// change, so it feels identical anywhere in the range.
const ZOOM_MIN = 0.2
const ZOOM_MAX = 400
const ZOOM_TICKS = 1000
const ZOOM_STEP = 1.12 // one +/- click
function ppsToSlider(pps: number): number {
  return Math.round((Math.log(pps / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * ZOOM_TICKS)
}
function sliderToPps(v: number): number {
  return ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / ZOOM_TICKS)
}

const HEADER_W = 130

// Height cycles through 3 presets instead of a free drag — matches the
// redesign's "compacta/média/alta" control. The underlying store value is
// still a plain number (nothing else needs to change), this just picks the
// next preset at or above the current height instead of any pixel value.
const HEIGHT_PRESETS = [20, 46, 74, 108]
const HEIGHT_LABELS = ['mínima', 'compacta', 'média', 'alta']
function nearestHeightIndex(h: number): number {
  let best = 0
  let bestDist = Infinity
  HEIGHT_PRESETS.forEach((p, i) => {
    const d = Math.abs(p - h)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  return best
}

export function Timeline(): JSX.Element {
  const tracks = useEditor((s) => s.tracks)
  const clips = useEditor((s) => s.clips)
  const pps = useEditor((s) => s.pps)
  const trackHeight = useEditor((s) => s.trackHeight)
  const setTrackHeight = useEditor((s) => s.setTrackHeight)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setZoom = useEditor((s) => s.setZoom)
  const addTrack = useEditor((s) => s.addTrack)
  const removeTrack = useEditor((s) => s.removeTrack)
  const addClip = useEditor((s) => s.addClip)
  const [tlHeight, setTlHeight] = useState(290)
  const addTextClip = useEditor((s) => s.addTextClip)
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const selectedClipIds = useEditor((s) => s.selectedClipIds)
  const removeSelected = useEditor((s) => s.removeSelected)
  const removeSelectedKeepGap = useEditor((s) => s.removeSelectedKeepGap)
  const toggleTrackFlag = useEditor((s) => s.toggleTrackFlag)
  const selectedTrackId = useEditor((s) => s.selectedTrackId)
  const selectTrack = useEditor((s) => s.selectTrack)
  const markers = useEditor((s) => s.markers)
  const removeMarker = useEditor((s) => s.removeMarker)
  const loopIn = useEditor((s) => s.loopIn)
  const loopOut = useEditor((s) => s.loopOut)
  const anySolo = tracks.some((t) => t.solo)

  function addText(): void {
    const topVideo = tracks.find((t) => t.kind === 'video')
    if (topVideo) addTextClip(topVideo.id, useEditor.getState().playhead)
  }

  const duration = useEditor((s) => s.duration())
  const contentWidth = Math.max(duration, 20) * pps + 240
  const scrollRef = useRef<HTMLDivElement>(null)

  // Zoom keeps the playhead pinned. Without this the scroll position stays put
  // in *pixels* while the content grows/shrinks around it, so every zoom threw
  // the needle off-screen. We record where the needle is on screen before the
  // change and restore that same screen offset after the new width lands —
  // hence useLayoutEffect (scrollLeft has to be set after React resizes the
  // content, but before the browser paints, or the timeline visibly jumps).
  const pendingAnchor = useRef<{ time: number; px: number } | null>(null)
  const zoomTo = (next: number): void => {
    const el = scrollRef.current
    if (el) {
      const time = useEditor.getState().playhead
      const px = time * pps - el.scrollLeft
      // If the needle is currently off-screen there is no offset worth
      // preserving — pull it to the middle instead.
      const visible = px >= 0 && px <= el.clientWidth
      pendingAnchor.current = { time, px: visible ? px : el.clientWidth / 2 }
    }
    setZoom(next)
  }
  useLayoutEffect(() => {
    const a = pendingAnchor.current
    const el = scrollRef.current
    if (!a || !el) return
    pendingAnchor.current = null
    el.scrollLeft = Math.max(0, a.time * pps - a.px)
  }, [pps])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomTo(pps * ZOOM_STEP)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomTo(pps / ZOOM_STEP)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pps])

  // Grab the playhead (or click the ruler/empty lane) and drag to scrub.
  function startScrub(e: React.MouseEvent): void {
    e.preventDefault()
    useEditor.getState().setPlaying(false)
    const scroller = scrollRef.current
    if (!scroller) return
    const compute = (clientX: number) => {
      const left = scroller.getBoundingClientRect().left - scroller.scrollLeft
      setPlayhead(Math.max(0, (clientX - left) / pps))
    }
    compute(e.clientX)
    const onMove = (ev: MouseEvent) => compute(ev.clientX)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="timeline" style={{ height: tlHeight }}>
      <div
        className="tl-resize"
        title="Arraste para aumentar/diminuir a timeline"
        onMouseDown={(e) => {
          e.preventDefault()
          const startY = e.clientY
          const startH = tlHeight
          const onMove = (ev: MouseEvent) => {
            // drag up = taller. Clamp so it stays usable and leaves room above.
            const h = Math.min(window.innerHeight - 220, Math.max(180, startH + (startY - ev.clientY)))
            setTlHeight(h)
          }
          const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      />
      <div className="tl-toolbar">
        <button className="btn-mini" onClick={() => addTrack('video')}>
          + Faixa de vídeo
        </button>
        <button className="btn-mini" onClick={() => addTrack('audio')}>
          + Faixa de áudio
        </button>
        <button className="btn-mini" onClick={addText} title="Adicionar texto/legenda">
          T+ Texto
        </button>
        <span className="sep" />
        <button className="btn-mini" onClick={splitAtPlayhead} title="Cortar no cursor (S)">
          ✂ Cortar
        </button>
        <button
          className="btn-mini"
          onClick={removeSelected}
          disabled={!selectedClipId && selectedClipIds.length === 0}
          title="Excluir e fechar o buraco — os clipes seguintes encostam no anterior (Del)"
        >
          🗑⇤ Excluir{selectedClipIds.length > 1 ? ` (${selectedClipIds.length})` : ''}
        </button>
        <button
          className="btn-mini"
          onClick={removeSelectedKeepGap}
          disabled={!selectedClipId && selectedClipIds.length === 0}
          title="Excluir deixando o buraco no lugar (Shift+Del)"
        >
          🗑⊟ Deixar buraco
        </button>
        <span className="sep" />
        <button
          className="btn-mini"
          title="Ajustar o zoom para caber o projeto inteiro"
          onClick={() => {
            const w = scrollRef.current?.clientWidth ?? 800
            // No artificial floor here — setZoom already clamps to the real
            // range (0.2px/s), so a 56-minute recording can actually fit
            // instead of hitting an arbitrary wall at 10px/s (which would
            // need ~34,000px of ruler to show the whole thing).
            zoomTo((w - 60) / Math.max(1, duration))
          }}
        >
          ⤢ Caber
        </button>
        <div className="zoom">
          <button
            className="btn-mini zoom-step"
            title="Diminuir o zoom (Ctrl+-)"
            onClick={() => zoomTo(pps / ZOOM_STEP)}
            disabled={pps <= ZOOM_MIN + 1e-6}
          >
            −
          </button>
          <input
            type="range"
            min={0}
            max={ZOOM_TICKS}
            step={1}
            value={ppsToSlider(pps)}
            onChange={(e) => zoomTo(sliderToPps(Number(e.target.value)))}
            title={`Zoom · ${pps < 10 ? pps.toFixed(1) : Math.round(pps)} px/s`}
          />
          <button
            className="btn-mini zoom-step"
            title="Aumentar o zoom (Ctrl++)"
            onClick={() => zoomTo(pps * ZOOM_STEP)}
            disabled={pps >= ZOOM_MAX - 1e-6}
          >
            +
          </button>
        </div>
        <button
          className="btn-mini"
          title="Altura das faixas (compacta / média / alta)"
          onClick={() => {
            const idx = HEIGHT_PRESETS.findIndex((p) => p >= trackHeight)
            const next = HEIGHT_PRESETS[(Math.max(0, idx) + 1) % HEIGHT_PRESETS.length]
            setTrackHeight(next)
          }}
        >
          ↕ Altura · {HEIGHT_LABELS[nearestHeightIndex(trackHeight)]}
        </button>
      </div>

      <div className="tl-main">
        <div className="tl-headers" style={{ width: HEADER_W }}>
          <div className="ruler-spacer" />
          {tracks.map((t) => (
            <div
              key={t.id}
              className={`track-header ${t.kind}${selectedTrackId === t.id ? ' sel' : ''}`}
              style={{ height: trackHeight }}
              onClick={() => selectTrack(t.id)}
              title="Clique para escolher esta faixa como destino das gravações"
            >
              <span className="track-name">{t.name}</span>
              <span className="track-flags">
                <button
                  className={`track-flag ${t.muted ? 'on' : ''}`}
                  title="Mudo (silencia os clipes desta faixa)"
                  onClick={() => toggleTrackFlag(t.id, 'muted')}
                >
                  M
                </button>
                <button
                  className={`track-flag ${t.solo ? 'on' : ''}`}
                  title="Solo (só faixas em solo tocam áudio)"
                  onClick={() => toggleTrackFlag(t.id, 'solo')}
                >
                  S
                </button>
                <button
                  className={`track-flag ${t.locked ? 'on' : ''}`}
                  title="Travar (impede arrastar/aparar os clipes)"
                  onClick={() => toggleTrackFlag(t.id, 'locked')}
                >
                  🔒
                </button>
              </span>
              {tracks.length > 1 && (
                <button
                  className="track-del"
                  title="Remover faixa"
                  onClick={() => {
                    const n = clips.filter((c) => c.trackId === t.id).length
                    if (n === 0 || confirm(`Remover a faixa "${t.name}" com ${n} clipe(s)?`)) removeTrack(t.id)
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-content" style={{ width: contentWidth }}>
            <Ruler duration={Math.max(duration, 20)} pps={pps} onScrub={startScrub} />
            {loopIn !== null && loopOut !== null && loopOut > loopIn && (
              <div
                className="loop-band"
                title="Região de loop (I/O define, U limpa)"
                style={{ left: loopIn * pps, width: (loopOut - loopIn) * pps }}
              />
            )}
            {markers.map((m) => (
              <div
                key={m.id}
                className="marker"
                style={{ left: m.time * pps }}
                title={`Marcador ${fmtTime(m.time)} — clique: ir · botão direito: remover`}
                onClick={(e) => {
                  e.stopPropagation()
                  setPlayhead(m.time)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  removeMarker(m.id)
                }}
              >
                ◆
              </div>
            ))}
            <div className="lanes">
              {tracks.map((t) => (
                <div
                  key={t.id}
                  className={`lane ${t.kind}`}
                  style={{ height: trackHeight }}
                  data-track-id={t.id}
                  data-track-kind={t.kind}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) {
                      selectTrack(t.id)
                      startScrub(e)
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const mediaId = e.dataTransfer.getData('application/x-media-id')
                    if (!mediaId) return
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = e.clientX - rect.left
                    addClip(mediaId, t.id, Math.max(0, x / pps))
                  }}
                >
                  {clips
                    .filter((c) => c.trackId === t.id)
                    .map((c) => (
                      <ClipBox
                        key={c.id}
                        clip={c}
                        pps={pps}
                        selected={c.id === selectedClipId || selectedClipIds.includes(c.id)}
                        locked={!!t.locked}
                        dimmed={!!t.muted || (anySolo && !t.solo)}
                      />
                    ))}
                </div>
              ))}
            </div>
            <Needle pps={pps} onScrub={startScrub} />
          </div>
        </div>
      </div>
    </div>
  )
}

function Ruler({
  duration,
  pps,
  onScrub
}: {
  duration: number
  pps: number
  onScrub: (e: React.MouseEvent) => void
}): JSX.Element {
  const step = pps < 40 ? 5 : pps < 100 ? 2 : 1
  const ticks: number[] = []
  for (let t = 0; t <= duration + step; t += step) ticks.push(t)
  return (
    <div className="ruler" onMouseDown={onScrub}>
      {ticks.map((t) => (
        <div key={t} className="tick" style={{ left: t * pps }}>
          <span>{fmtTime(t)}</span>
        </div>
      ))}
    </div>
  )
}

// The ONLY per-frame subscriber in the timeline. During playback the playhead
// updates ~60×/s; when the whole Timeline subscribed, every tick re-rendered 10
// tracks and 30+ clip boxes (filmstrips, waveforms) — the app froze as projects
// grew. Now a tick re-renders just this needle.
function Needle({ pps, onScrub }: { pps: number; onScrub: (e: React.MouseEvent) => void }): JSX.Element {
  const playhead = useEditor((s) => s.playhead)
  return (
    <div className="playhead-line" style={{ left: playhead * pps }}>
      <div className="playhead-handle" onMouseDown={onScrub} title="Arraste para mover a agulha" />
    </div>
  )
}

const ClipBox = memo(function ClipBox({
  clip,
  pps,
  selected,
  locked,
  dimmed
}: {
  clip: Clip
  pps: number
  selected: boolean
  locked: boolean
  dimmed: boolean
}): JSX.Element {
  const update = useEditor((s) => s.updateClip)
  const setTransition = useEditor((s) => s.setTransition)
  const select = useEditor((s) => s.select)
  const toggleSelect = useEditor((s) => s.toggleSelect)
  const trackHeight = useEditor((s) => s.trackHeight)
  const media = useEditor((s) => s.media.find((m) => m.id === clip.mediaId))
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    if (media?.type === 'video') getThumbnail(media.path).then(setThumb).catch(() => {})
  }, [media?.path, media?.type])

  function startDrag(mode: 'move' | 'trim-left' | 'trim-right', e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    // Shift/Ctrl+click: toggle multi-selection, no drag.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      toggleSelect(clip.id)
      return
    }
    const st0 = useEditor.getState()
    // Clicking a clip already inside a multi-selection keeps the group;
    // otherwise selection collapses to this clip.
    const inGroup = st0.selectedClipIds.length > 1 && st0.selectedClipIds.includes(clip.id)
    if (!inGroup) select(clip.id)
    if (locked) return
    useEditor.getState().commit()
    const startX = e.clientX
    const orig = { start: clip.start, duration: clip.duration, inPoint: clip.inPoint, trackId: clip.trackId }
    // Trim applies to the WHOLE selection, not just the clip under the cursor.
    // Every selected clip is trimmed by the SAME delta and the clamps are
    // COLLECTIVE: the tightest limit in the group stops all of them. Clamping
    // each clip on its own would let a long clip keep growing after a short one
    // hit its source end, and the selection would silently drift out of sync —
    // exactly what you do not want when the pair is a camera + screen take.
    const trackLocked = (id: string): boolean =>
      !!st0.tracks.find((t) => t.id === id)?.locked
    const trimIds = (inGroup ? st0.selectedClipIds : [clip.id]).filter(
      (id) => id === clip.id || !trackLocked(st0.clips.find((c) => c.id === id)?.trackId ?? '')
    )
    const trimOrig = new Map(
      trimIds.map((id) => {
        const c = st0.clips.find((x) => x.id === id) ?? clip
        const m = st0.media.find((mm) => mm.id === c.mediaId)
        return [
          id,
          {
            start: c.start,
            duration: c.duration,
            inPoint: c.inPoint,
            speed: c.speed || 1,
            // A still has no real source length, so it may be stretched freely.
            srcDur: m?.type === 'image' ? Infinity : m?.duration ?? Infinity,
            followers: findRippleFollowers(st0.clips, c)
          }
        ]
      })
    )
    let finalDelta = 0
    // Group drag: remember the original start of every selected clip.
    const groupIds = inGroup ? st0.selectedClipIds.filter((id) => id !== clip.id) : []
    // Remember each group member's track too, not just its start — moving a
    // multi-selection to another track needs the original track to offset from.
    const groupOrig = new Map(
      groupIds.map((id) => {
        const c = st0.clips.find((x) => x.id === id)
        return [id, { start: c?.start ?? 0, trackId: c?.trackId ?? '' }]
      })
    )

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / pps
      if (mode === 'move') {
        let newStart = Math.max(0, orig.start + dx)
        newStart = snap(newStart, clip.id)
        const patch: Partial<Clip> = { start: newStart }
        // cross-track drag: find a lane of the same kind under the pointer
        const lane = document
          .elementsFromPoint(ev.clientX, ev.clientY)
          .find((el) => (el as HTMLElement).dataset?.trackId) as HTMLElement | undefined
        // Cross-track drag used to be disabled whenever more than one clip was
        // selected, which made "select the audio clips, drag them to a new
        // track" quietly impossible. The group now moves by the same track
        // offset as the clip under the cursor.
        let trackDelta = 0
        if (lane && lane.dataset.trackKind === laneKindFor(clip.type)) {
          patch.trackId = lane.dataset.trackId
          const all = useEditor.getState().tracks
          const from = all.findIndex((t) => t.id === orig.trackId)
          const to = all.findIndex((t) => t.id === lane.dataset.trackId)
          if (from >= 0 && to >= 0) trackDelta = to - from
        }
        update(clip.id, patch)
        // Move the rest of the group by the same (snapped) delta, keeping offsets.
        const applied = newStart - orig.start
        const all = useEditor.getState().tracks
        for (const [id, o] of groupOrig) {
          const p: Partial<Clip> = { start: Math.max(0, o.start + applied) }
          if (trackDelta !== 0) {
            const src = all.findIndex((t) => t.id === o.trackId)
            const dest = src >= 0 ? all[src + trackDelta] : undefined
            // Only follow when the shifted lane exists and holds this kind of
            // clip; otherwise that member stays put rather than vanishing into
            // an incompatible track.
            const c = useEditor.getState().clips.find((x) => x.id === id)
            if (dest && c && dest.kind === laneKindFor(c.type)) p.trackId = dest.id
          }
          update(id, p)
        }
      } else {
        finalDelta = clampTrimDelta(trimOrig.values(), dx, mode)
        for (const [id, o] of trimOrig) update(id, trimPatch(o, finalDelta, mode))
      }
    }
    const onUp = () => {
      const durationDelta = mode === 'trim-left' ? -finalDelta : finalDelta
      const hasFollowers = [...trimOrig.values()].some((o) => o.followers.length > 0)
      if (mode !== 'move' && durationDelta !== 0 && hasFollowers) {
        useEditor.setState((st) => ({
          clips: applyTrimRipple(st.clips, trimOrig, durationDelta),
          dirty: true
        }))
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function snap(value: number, selfId: string): number {
    const st = useEditor.getState()
    const candidates = [0, st.playhead]
    for (const c of st.clips) {
      if (c.id === selfId) continue
      candidates.push(c.start, c.start + c.duration)
    }
    const threshold = 8 / pps
    let best = value
    let bestDist = threshold
    for (const cand of candidates) {
      const d = Math.abs(cand - value)
      if (d < bestDist) {
        bestDist = d
        best = cand
      }
    }
    return best
  }

  return (
    <div
      className={`clip ${clip.type} ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''} ${locked ? 'locked' : ''}`}
      style={{ left: clip.start * pps, width: Math.max(6, clip.duration * pps), top: 4, height: trackHeight - 8 }}
      onMouseDown={(e) => startDrag('move', e)}
      onClick={(e) => e.stopPropagation()}
      title={media?.name}
    >
      {thumb && clip.type === 'video' && (
        <div className="clip-thumb" style={{ backgroundImage: `url(${thumb})` }} />
      )}
      {clip.type === 'audio' && media?.peaks && <WaveBars peaks={media.peaks} />}
      {clip.type !== 'audio' && (
        <button
          className={clip.transition ? 'clip-trans on' : 'clip-trans'}
          title={
            clip.transition
              ? `Transição: ${clip.transition.type} (${clip.transition.duration.toFixed(1)}s) — clique para remover`
              : 'Adicionar transição com o clipe anterior (fade 0,7s)'
          }
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setTransition(clip.id, clip.transition ? 'none' : 'fade', clip.transition?.duration ?? 0.7)
          }}
        >
          ⇆
        </button>
      )}
      <div className="trim-handle left" onMouseDown={(e) => startDrag('trim-left', e)} />
      <div className="clip-label">
        {clip.type === 'text' ? `T  ${clip.text?.content?.split('\n')[0] || 'Texto'}` : media?.name || clip.type}
      </div>
      <div className="trim-handle right" onMouseDown={(e) => startDrag('trim-right', e)} />
    </div>
  )
})

function laneKindFor(clipType: string): 'video' | 'audio' {
  return clipType === 'audio' ? 'audio' : 'video'
}

function WaveBars({ peaks }: { peaks: number[] }): JSX.Element {
  const N = Math.min(220, peaks.length)
  const step = peaks.length / N
  const bars = Array.from({ length: N }, (_, i) => peaks[Math.floor(i * step)] || 0)
  return (
    <svg className="wave" viewBox={`0 0 ${N} 100`} preserveAspectRatio="none">
      {bars.map((v, i) => (
        <rect key={i} x={i + 0.1} y={50 - v * 46} width={0.8} height={Math.max(1, v * 92)} />
      ))}
    </svg>
  )
}
