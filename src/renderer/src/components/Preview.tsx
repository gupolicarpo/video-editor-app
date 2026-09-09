import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '../store'
import type { Clip } from '../types'
import { fmtTime, clamp } from '../util'
import { previewTransition } from '../transitions'
import { computeMotion } from '../motion'
import { computeAnim, clipPathOf } from '../animations'
import { maskClipPath } from '../masks'
import { LOOKS, getLook, lookCss, lookFilterId, lookMatrix } from '../../../shared/looks'
import { clipVolumeGain } from '../../../shared/audio'

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement

function fadeFactor(clip: Clip, t: number): number {
  const local = t - clip.start
  let f = 1
  if (clip.fadeIn > 0 && local < clip.fadeIn) f = Math.min(f, local / clip.fadeIn)
  const remain = clip.duration - local
  if (clip.fadeOut > 0 && remain < clip.fadeOut) f = Math.min(f, remain / clip.fadeOut)
  return clamp(f, 0, 1)
}

// 30ms ramp at every clip edge (mirrors the export's afade). The preview plays
// each clip in its own <video>, so at a clip join one element's audio stops dead
// and the next starts dead — a pop. This ramps the volume through the join, and
// because a clip fades IN from silence it also masks the seek glitch when its
// <video> is (re)positioned at activation. Applied to VOLUME only — putting it on
// opacity too would flash black at every boundary.
const MICRO_FADE = 0.03
function audioGain(clip: Clip, t: number): number {
  const local = t - clip.start
  const remain = clip.duration - local
  const maxF = Math.max(0.001, clip.duration / 2)
  const fin = Math.min(clip.fadeIn > 0 ? clip.fadeIn : MICRO_FADE, maxF)
  const fout = Math.min(clip.fadeOut > 0 ? clip.fadeOut : MICRO_FADE, maxF)
  let f = 1
  if (local < fin) f = Math.min(f, local / fin)
  if (remain < fout) f = Math.min(f, remain / fout)
  return clamp(f, 0, 1)
}

function cssFilter(clip: Clip): string {
  const base = `brightness(${(1 + clip.brightness).toFixed(3)}) contrast(${clip.contrast.toFixed(3)}) saturate(${clip.saturation.toFixed(3)})`
  const look = getLook(clip.look)
  // Same order the engine uses in eqOf(): manual eq first, then the look.
  return look ? `${base} ${lookCss(look)}` : base
}

/**
 * The <filter> elements the looks reference. Mounted once, hidden.
 *
 * `color-interpolation-filters="sRGB"` is load-bearing: the SVG default is
 * linearRGB, which would silently grade in a different space than ffmpeg's
 * colorchannelmixer and put the preview several codes off the export.
 */
function LookFilterDefs(): JSX.Element {
  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        {LOOKS.filter((l) => l.id !== 'none').map((l) => {
          const m = lookMatrix(l)
          const values = [
            m[0], m[1], m[2], 0, 0,
            m[3], m[4], m[5], 0, 0,
            m[6], m[7], m[8], 0, 0,
            0, 0, 0, 1, 0
          ].join(' ')
          return (
            <filter key={l.id} id={lookFilterId(l.id)} colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={values} />
            </filter>
          )
        })}
      </defs>
    </svg>
  )
}

export function Preview(): JSX.Element {
  const clips = useEditor((s) => s.clips)
  const media = useEditor((s) => s.media)
  const projectW = useEditor((s) => s.projectW)
  const projectH = useEditor((s) => s.projectH)
  const masterVolume = useEditor((s) => s.masterVolume)
  const isPlaying = useEditor((s) => s.isPlaying)
  const setPlaying = useEditor((s) => s.setPlaying)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const select = useEditor((s) => s.select)

  const refs = useRef<Map<string, MediaEl>>(new Map())
  const proxyAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioBoosts = useRef<
    Map<HTMLMediaElement, { source: MediaElementAudioSourceNode; gain: GainNode; pan: StereoPannerNode }>
  >(new Map())
  const rafRef = useRef<number>(0)
  const lastTs = useRef<number>(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageH, setStageH] = useState(360)

  const mediaById = useCallback((id: string) => media.find((m) => m.id === id), [media])

  const activateAudio = useCallback((): void => {
    if (!audioContextRef.current) audioContextRef.current = new AudioContext()
    void audioContextRef.current.resume().catch(() => {})
  }, [])

  // HTMLMediaElement.volume stops at 1 and has no pan control at all. The
  // timeline permits 200% volume and ±1 pan, so route anything that needs
  // either through a Gain→StereoPanner graph. Plain clips (100% vol, center
  // pan) keep the native <audio>.volume path, avoiding a WebAudio graph for
  // the common case. StereoPannerNode implements the Web Audio spec's pan
  // law itself (equal-power for mono sources, linear crossfade for stereo) —
  // matched on the export side in ffmpeg.ts rather than re-derived here, so
  // "preview is export" holds without hand-rolling the curve twice.
  const setPreviewAudio = useCallback((el: HTMLMediaElement, volume: number, pan: number): void => {
    const level = Math.max(0, volume)
    const p = Math.max(-1, Math.min(1, pan))
    let boost = audioBoosts.current.get(el)
    if (!boost && (level > 1 || p !== 0)) {
      activateAudio()
      const context = audioContextRef.current!
      try {
        const source = context.createMediaElementSource(el)
        const gain = context.createGain()
        const panner = context.createStereoPanner()
        source.connect(gain).connect(panner).connect(context.destination)
        boost = { source, gain, pan: panner }
        audioBoosts.current.set(el, boost)
      } catch {
        // Browsers can reject a second source for the same element. Native
        // volume still handles 0..100% / centered pan in that rare case.
        el.volume = 1
        return
      }
    }
    if (boost) {
      el.volume = 1
      boost.gain.gain.value = level
      boost.pan.pan.value = p
    } else {
      el.volume = Math.min(1, level)
    }
  }, [activateAudio])

  const releaseAudioBoost = useCallback((el: MediaEl | null | undefined): void => {
    if (!el || el.tagName === 'IMG') return
    const mediaEl = el as HTMLMediaElement
    const boost = audioBoosts.current.get(mediaEl)
    if (!boost) return
    try {
      boost.source.disconnect()
      boost.gain.disconnect()
      boost.pan.disconnect()
    } catch {
      /* already disconnected */
    }
    audioBoosts.current.delete(mediaEl)
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageH(el.clientHeight))
    ro.observe(el)
    setStageH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const sync = useCallback((t: number, playing: boolean, hard = false) => {
    const st = useEditor.getState()
    // The primary active video (bottom-most video track) is the playback clock.
    let masterId: string | null = null
    if (playing && !hard) {
      let best: { id: string; ord: number } | null = null
      for (const c of st.clips) {
        if (c.type !== 'video' || t < c.start || t >= c.start + c.duration) continue
        const ord = st.trackOrder(c.trackId)
        if (!best || ord < best.ord) best = { id: c.id, ord }
      }
      masterId = best?.id ?? null
    }
    const anySolo = st.tracks.some((tr) => tr.solo)
    const trackSilenced = (trackId: string): boolean => {
      const tr = st.tracks.find((x) => x.id === trackId)
      if (!tr) return false
      return !!tr.muted || (anySolo && !tr.solo)
    }
    for (const clip of st.clips) {
      if (clip.type === 'text') continue
      const el = refs.current.get(clip.id)
      if (!el) continue
      const proxyAudio = proxyAudioRefs.current.get(clip.id)
      const active = t >= clip.start && t < clip.start + clip.duration
      const isImg = el.tagName === 'IMG'
      const av = el as HTMLMediaElement
      if (active) {
        if (el.style.visibility !== 'visible') el.style.visibility = 'visible'
        el.style.opacity = String(clip.opacity * fadeFactor(clip, t))
        el.style.filter = cssFilter(clip)
        if (!isImg) {
          const desired = clip.inPoint + (t - clip.start) * clip.speed
          // Audio drift is audible well before video drift is visible — keep a
          // much tighter tolerance for <audio> elements (seek there is cheap).
          // The MASTER video is never seeked while playing: the playhead follows
          // it (see tick), and seeking the clock against itself on long-GOP
          // masters is what caused the stall storms.
          const isMaster =
            playing && !hard && el.tagName === 'VIDEO' && masterId !== null && clip.id === masterId
          const tolerance = hard || !playing ? 0.02 : el.tagName === 'AUDIO' ? 0.08 : 0.35
          if (!isMaster && Math.abs(av.currentTime - desired) > tolerance) av.currentTime = desired
          if (av.playbackRate !== clip.speed) av.playbackRate = clip.speed
          const volume = trackSilenced(clip.trackId)
            ? 0
            : clipVolumeGain(clip.volume) * st.masterVolume * audioGain(clip, t)
          if (proxyAudio) av.volume = 0
          else setPreviewAudio(av, volume, clip.pan)
          if (playing && av.paused) av.play().catch(() => {})
          if (!playing && !av.paused) av.pause()
          if (proxyAudio) {
            const audioTolerance = hard || !playing ? 0.02 : 0.08
            if (Math.abs(proxyAudio.currentTime - desired) > audioTolerance) proxyAudio.currentTime = desired
            if (proxyAudio.playbackRate !== clip.speed) proxyAudio.playbackRate = clip.speed
            setPreviewAudio(proxyAudio, volume, clip.pan)
            if (playing && proxyAudio.paused) proxyAudio.play().catch(() => {})
            if (!playing && !proxyAudio.paused) proxyAudio.pause()
          }
        }
      } else {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
        if (!isImg && !av.paused) av.pause()
        if (proxyAudio && !proxyAudio.paused) proxyAudio.pause()
        // Pre-warm a clip about to start: park its <video> on the first frame it
        // will show, so activation is a play() with the frame already decoded
        // instead of a seek-then-play (which stutters and can click). 0.3s ahead.
        if (!isImg && playing) {
          const ahead = clip.start - t
          if (ahead > 0 && ahead < 0.3 && Math.abs(av.currentTime - clip.inPoint) > 0.05) {
            av.currentTime = clip.inPoint
          }
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current)
      sync(useEditor.getState().playhead, false)
      return
    }
    sync(useEditor.getState().playhead, true, true)
    lastTs.current = performance.now()
    // THE MEDIA IS THE CLOCK. The old tick advanced a wall clock and dragged the
    // videos after it with seeks; on our masters (keyframe every ~5.7s) each
    // drift-seek stalls the decoder for dozens of frames, the wall clock keeps
    // marching, drift grows, another seek fires — a seek storm that looked like
    // "video can't keep up with audio". Now the playhead FOLLOWS the currentTime
    // of the active primary video (bottom-most video track = main footage), whose
    // element keeps its own A/V in perfect sync and is never seeked while
    // playing. Wall-clock time only drives sections with no active video.
    const pickMaster = (st: ReturnType<typeof useEditor.getState>, t: number) => {
      const actives = st.clips.filter(
        (c) => c.type === 'video' && t >= c.start && t < c.start + c.duration
      )
      if (!actives.length) return null
      actives.sort((a, b) => st.trackOrder(a.trackId) - st.trackOrder(b.trackId))
      return actives[0]
    }
    const tick = (now: number) => {
      const dt = (now - lastTs.current) / 1000
      lastTs.current = now
      const st = useEditor.getState()
      let next = st.playhead + dt
      const master = pickMaster(st, st.playhead)
      if (master) {
        const el = refs.current.get(master.id) as HTMLVideoElement | undefined
        if (el && el.readyState >= 2 && !el.seeking) {
          const mediaT = master.start + (el.currentTime - master.inPoint) / Math.max(0.05, master.speed)
          // Follow the element unless it's wildly off (fresh mount mid-scrub).
          if (Math.abs(mediaT - st.playhead) < 1.5) next = Math.max(st.playhead, mediaT)
        }
      }
      // Loop range (keys I/O): jump back to loopIn when passing loopOut.
      if (st.loopIn !== null && st.loopOut !== null && st.loopOut > st.loopIn && next >= st.loopOut) {
        next = st.loopIn
        st.setPlayhead(next)
        sync(next, true, true)
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const dur = st.duration()
      if (next >= dur && dur > 0) {
        st.setPlayhead(dur)
        st.setPlaying(false)
        sync(dur, false)
        return
      }
      st.setPlayhead(next)
      sync(next, true)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying])

  const playhead = useEditor((s) => s.playhead)
  // SCRUB SETTLING. The flight recorder caught 78 main-thread stalls — every
  // one with playing=false: dragging the needle fired an immediate seek on every
  // active video per mousemove tick, and on long-GOP masters each seek costs
  // 300-600ms. While dragging, the needle now moves free; the expensive seeks
  // (and clip mounting) fire once, 120ms after the hand stops.
  const [settled, setSettled] = useState(playhead)
  useEffect(() => {
    if (isPlaying) return
    const t = setTimeout(() => setSettled(playhead), 120)
    return () => clearTimeout(t)
  }, [playhead, isPlaying])
  useEffect(() => {
    if (!isPlaying) sync(settled, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, clips, masterVolume, isPlaying])

  // Only mount media NEAR the playhead. Every clip used to be a live <video>/<img>
  // in the DOM at once; with many tracks/clips (and <video>s holding decoders even
  // while paused) the preview crawled. A ±1.5s window keeps just a handful mounted
  // — wide enough that the next clip is ready before it's active (see pre-warm).
  const MOUNT_WINDOW = 1.5
  const mountT = isPlaying ? playhead : settled
  const nearPlayhead = (c: Clip): boolean =>
    mountT >= c.start - MOUNT_WINDOW && mountT <= c.start + c.duration + MOUNT_WINDOW
  const visual = clips
    .filter((c) => (c.type === 'video' || c.type === 'image' || c.type === 'text') && nearPlayhead(c))
    .map((c) => ({ c, order: useEditor.getState().trackOrder(c.trackId) }))
    .sort((a, b) => a.order - b.order || a.c.start - b.c.start)
  const audioClips = clips.filter((c) => c.type === 'audio' && nearPlayhead(c))
  const videoAudioClips = clips.filter(
    (c) => c.type === 'video' && nearPlayhead(c) && !!mediaById(c.mediaId)?.audioPath
  )

  // Ref callbacks must be IDENTITY-STABLE per clip. An inline `(el) => ...` is a
  // new function every render, and React then detaches/reattaches the ref each
  // render — which ran the destructive cleanup below against LIVE elements and
  // blanked every video on screen. Cached per id, null only means real unmount.
  const refCbs = useRef<Map<string, (el: MediaEl | null) => void>>(new Map())
  const setRef = (id: string): ((el: MediaEl | null) => void) => {
    let cb = refCbs.current.get(id)
    if (!cb) {
      cb = (el) => {
        if (el) {
          refs.current.set(id, el)
          return
        }
        // Real unmount: a detached <video> still PLAYING is protected from GC by
        // Chromium and keeps decoding forever (measured: 912 MB of ghosts). Stop
        // it and drop the source before releasing the reference.
        const old = refs.current.get(id)
        if (old && old.tagName !== 'IMG') {
          const av = old as HTMLMediaElement
          try {
            releaseAudioBoost(old)
            av.pause()
            av.removeAttribute('src')
            av.load()
          } catch {
            /* already gone */
          }
        }
        refs.current.delete(id)
      }
      refCbs.current.set(id, cb)
    }
    return cb
  }

  const proxyRefCbs = useRef<Map<string, (el: HTMLAudioElement | null) => void>>(new Map())
  const setProxyAudioRef = (id: string): ((el: HTMLAudioElement | null) => void) => {
    let cb = proxyRefCbs.current.get(id)
    if (!cb) {
      cb = (el) => {
        if (el) {
          proxyAudioRefs.current.set(id, el)
          return
        }
        const old = proxyAudioRefs.current.get(id)
        if (old) {
          try {
            releaseAudioBoost(old)
            old.pause()
            old.removeAttribute('src')
            old.load()
          } catch {
            /* already gone */
          }
        }
        proxyAudioRefs.current.delete(id)
      }
      proxyRefCbs.current.set(id, cb)
    }
    return cb
  }

  // Vignette (and grain) are stage-level overlays here, while the engine bakes
  // them per clip. Identical for a full-frame clip — which is every case they
  // are used in — and already how the vignette effect behaved before looks.
  const stageVignette = visual.reduce((mx, { c }) => {
    const active = playhead >= c.start && playhead < c.start + c.duration
    if (!active) return mx
    return Math.max(mx, computeMotion(c, playhead).vignette, getLook(c.look)?.vignette ?? 0)
  }, 0)
  const stageGrain = visual.reduce((mx, { c }) => {
    const active = playhead >= c.start && playhead < c.start + c.duration
    return active ? Math.max(mx, getLook(c.look)?.grain ?? 0) : mx
  }, 0)

  const dur = useEditor.getState().duration()
  const selected = clips.find((c) => c.id === selectedClipId)
  const selVisual = selected && (selected.type === 'video' || selected.type === 'image')
  const selectedActive =
    selected && playhead >= selected.start && playhead < selected.start + selected.duration

  return (
    <div className="preview">
      <div className="stage-wrap">
        <div className="stage" ref={stageRef} style={{ aspectRatio: `${projectW} / ${projectH}` }}>
          <LookFilterDefs />
          {visual.length === 0 && <div className="stage-empty">Pré-visualização</div>}
          {visual.map(({ c, order }) => {
            const active = playhead >= c.start && playhead < c.start + c.duration
            if (c.type === 'text') {
              return (
                <TextLayer
                  key={c.id}
                  clip={c}
                  order={order}
                  stageH={stageH}
                  visible={active}
                  playing={isPlaying}
                  selected={c.id === selectedClipId}
                  stageRef={stageRef}
                />
              )
            }
            const m = mediaById(c.mediaId)
            if (!m) return null
            const box = boxStyle(c, order)
            const tr = previewTransition(c, playhead)
            if (tr.active) {
              if (tr.transform) box.transform = tr.transform
              if (tr.clipPath) box.clipPath = tr.clipPath
              if (tr.opacity !== undefined) box.opacity = tr.opacity
            }
            // motion effects (zoom punch, ken burns, pan, tilt, shake…)
            const mo = computeMotion(c, playhead)
            if (mo.scale !== 1 || mo.dx || mo.dy || mo.rotate) {
              const motionT = `scale(${mo.scale.toFixed(4)}) translate(${(mo.dx / 19.2).toFixed(3)}%, ${(mo.dy / 10.8).toFixed(3)}%) rotate(${mo.rotate.toFixed(2)}deg)`
              box.transform = `${motionT} ${box.transform || ''}`.trim()
            }
            // element animations (in / loop / out)
            const an = computeAnim(c, playhead)
            // O giro FIXO soma ao giro da animacao e sai na MESMA posicao da
            // cadeia (girar antes de escalar), que e a ordem do export — sem
            // isso preview e arquivo final divergiriam.
            const rotDeg = an.rotate + (c.rotate ?? 0)
            if (an.scaleX !== 1 || an.scaleY !== 1 || an.tx || an.ty || rotDeg) {
              const animT = `translate(${an.tx.toFixed(3)}%, ${an.ty.toFixed(3)}%) scale(${an.scaleX.toFixed(4)}, ${an.scaleY.toFixed(4)}) rotate(${rotDeg.toFixed(2)}deg)`
              box.transform = `${animT} ${box.transform || ''}`.trim()
            }
            if (an.opacity !== 1) {
              const base = box.opacity === undefined ? 1 : Number(box.opacity)
              box.opacity = base * an.opacity
            }
            // `wipe` reveals via a mask, so it must not override a transition's clip-path.
            const animClip = clipPathOf(an)
            if (animClip && !box.clipPath) box.clipPath = animClip
            // Shape mask (narrator-in-a-circle). Only when nothing else already
            // claimed the clip-path, and combined via the box's own clip.
            const maskClip = maskClipPath(c.mask)
            if (maskClip && !box.clipPath) box.clipPath = maskClip
            const cssFilters: string[] = []
            if (mo.blur > 0) cssFilters.push(`blur(${mo.blur}px)`)
            if (mo.grayscale > 0) cssFilters.push(`grayscale(${mo.grayscale})`)
            if (cssFilters.length) box.filter = cssFilters.join(' ')
            const inner: React.CSSProperties = {
              width: '100%',
              height: '100%',
              objectFit: c.fit,
              opacity: c.opacity,
              visibility: 'hidden'
            }
            return (
              <div
                key={c.id}
                // Marked so the app-wide "click outside clears the selection"
                // handler treats this as a selecting click, instead of relying
                // on stopPropagation below (which does not run during playback).
                className="stage-layer"
                style={box}
                onMouseDown={(e) => {
                  if (!isPlaying) {
                    e.stopPropagation()
                    select(c.id)
                  }
                }}
              >
                {m.type === 'image' ? (
                  <img ref={setRef(c.id)} src={window.api.mediaUrl(m.path)} style={inner} draggable={false} />
                ) : (
                  <video
                    ref={setRef(c.id)}
                    src={window.api.mediaUrl(m.path)}
                    style={inner}
                    preload="auto"
                    playsInline
                    muted={!!m.audioPath}
                  />
                )}
              </div>
            )
          })}

          {stageVignette > 0 && <div className="vignette-overlay" style={{ opacity: stageVignette }} />}
          {/* Grain has no exact CSS twin for ffmpeg's per-pixel `noise`; this is
              a matched-density stand-in so the look reads right while editing. */}
          {stageGrain > 0 && <div className="grain-overlay" style={{ opacity: stageGrain * 0.5 }} />}

          {selected && selVisual && selectedActive && (
            <SelectionOverlay clip={selected} stageRef={stageRef} />
          )}
        </div>
      </div>

      <div style={{ display: 'none' }}>
        {audioClips.map((c) => {
          const m = mediaById(c.mediaId)
          if (!m) return null
          return <audio key={c.id} ref={setRef(c.id)} src={window.api.mediaUrl(c.audioSourcePath || m.audioPath || m.path)} preload="auto" />
        })}
        {videoAudioClips.map((c) => {
          const m = mediaById(c.mediaId)
          if (!m?.audioPath) return null
          return <audio key={`${c.id}:mixed-audio`} ref={setProxyAudioRef(c.id)} src={window.api.mediaUrl(m.audioPath)} preload="auto" />
        })}
      </div>

      <div className="transport">
        <button className="btn" onClick={() => useEditor.getState().setPlayhead(0)} title="Início">
          ⏮
        </button>
        <button className="btn btn-primary" onClick={() => { activateAudio(); setPlaying(!isPlaying) }}>
          {isPlaying ? '⏸ Pausar' : '▶ Reproduzir'}
        </button>
        <span className="time-readout">
          {fmtTime(playhead)} / {fmtTime(dur)}
        </span>
        <AudioMeter t={playhead} />
      </div>
    </div>
  )
}

// Approximate output level at time t, derived from each audible clip's
// precomputed peak envelope × volume × fades × track mute/solo. No WebAudio
// graph — zero risk of rerouting/silencing real playback.
function AudioMeter({ t }: { t: number }): JSX.Element | null {
  const peakHold = useRef(0)
  const st = useEditor.getState()
  const anySolo = st.tracks.some((tr) => tr.solo)
  let sum = 0
  for (const clip of st.clips) {
    if (clip.type !== 'audio' && clip.type !== 'video') continue
    if (t < clip.start || t >= clip.start + clip.duration) continue
    if (clip.volume <= 0) continue
    const tr = st.tracks.find((x) => x.id === clip.trackId)
    if (tr && (tr.muted || (anySolo && !tr.solo))) continue
    const m = st.media.find((x) => x.id === clip.mediaId)
    if (!m?.peaks?.length || !m.hasAudio) continue
    const srcT = clip.inPoint + (t - clip.start) * clip.speed
    const idx = Math.max(0, Math.min(m.peaks.length - 1, Math.floor((srcT / m.duration) * m.peaks.length)))
    sum += m.peaks[idx] * Math.min(1, clipVolumeGain(clip.volume) * st.masterVolume) * fadeFactor(clip, t)
  }
  const level = Math.min(1, sum)
  peakHold.current = Math.max(level, peakHold.current * 0.96)
  const color = level > 0.9 ? '#f0683c' : level > 0.7 ? '#e6b84a' : '#4ade6c'
  return (
    <div className="audio-meter" title="Nível de áudio (aprox.)">
      <div className="audio-meter-fill" style={{ width: `${level * 100}%`, background: color }} />
      <div className="audio-meter-peak" style={{ left: `${peakHold.current * 100}%` }} />
    </div>
  )
}

function TextLayer({
  clip,
  order,
  stageH,
  visible,
  playing,
  selected,
  stageRef
}: {
  clip: Clip
  order: number
  stageH: number
  visible: boolean
  playing: boolean
  selected: boolean
  stageRef: React.RefObject<HTMLDivElement>
}): JSX.Element | null {
  const t = clip.text
  const update = useEditor((s) => s.updateClip)
  const select = useEditor((s) => s.select)
  if (!t) return null
  const fontSize = t.fontSizeRel * stageH
  const playheadNow = useEditor.getState().playhead
  const tr = previewTransition(clip, playheadNow)
  const an = computeAnim(clip, playheadNow)
  const opacity =
    clip.opacity *
    fadeFactor(clip, playheadNow) *
    (tr.active && tr.opacity !== undefined ? tr.opacity : 1) *
    an.opacity
  const rotDeg = an.rotate + (clip.rotate ?? 0)
  const animT =
    an.scaleX !== 1 || an.scaleY !== 1 || an.tx || an.ty || rotDeg
      ? ` translate(${an.tx.toFixed(3)}%, ${an.ty.toFixed(3)}%) scale(${an.scaleX.toFixed(4)}, ${an.scaleY.toFixed(4)}) rotate(${rotDeg.toFixed(2)}deg)`
      : ''

  function startDrag(e: React.MouseEvent): void {
    if (playing) return
    e.stopPropagation()
    e.preventDefault()
    select(clip.id)
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const sx = e.clientX
    const sy = e.clientY
    const ox = clip.xFrac
    const oy = clip.yFrac
    const onMove = (ev: MouseEvent) => {
      update(clip.id, {
        xFrac: clamp(ox + (ev.clientX - sx) / rect.width, -1, 1),
        yFrac: clamp(oy + (ev.clientY - sy) / rect.height, -1, 1)
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${50 + clip.xFrac * 100}%`,
    top: `${50 + clip.yFrac * 100}%`,
    transform: `translate(-50%, -50%)${animT} ${tr.transform || ''}`,
    clipPath: tr.clipPath || clipPathOf(an),
    zIndex: order,
    maxWidth: `${Math.min(94, 200 * Math.min(0.5 + clip.xFrac, 0.5 - clip.xFrac)).toFixed(2)}%`,
    textAlign: t.align,
    color: t.color,
    fontFamily: t.fontFamily,
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    fontSize: `${fontSize}px`,
    lineHeight: 1.25,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    padding: t.bgColor ? `${fontSize * 0.25}px ${fontSize * 0.4}px` : 0,
    background: t.bgColor || 'transparent',
    opacity,
    visibility: visible ? 'visible' : 'hidden',
    cursor: playing ? 'default' : 'move',
    outline: selected ? '1.5px dashed var(--accent-2)' : 'none',
    WebkitTextStroke: t.outline ? `${Math.max(1, fontSize * 0.03)}px rgba(0,0,0,0.85)` : undefined,
    textShadow: t.outline ? '0 2px 6px rgba(0,0,0,0.5)' : undefined,
    userSelect: 'none'
  }
  return (
    <div style={style} onMouseDown={startDrag}>
      {t.content}
    </div>
  )
}

function boxStyle(c: Clip, order: number): React.CSSProperties {
  const wPct = c.scale * 100
  const hPct = c.scale * 100
  const leftPct = 50 + c.xFrac * 100 - wPct / 2
  const topPct = 50 + c.yFrac * 100 - hPct / 2
  return {
    position: 'absolute',
    left: `${leftPct}%`,
    top: `${topPct}%`,
    width: `${wPct}%`,
    height: `${hPct}%`,
    zIndex: order,
    overflow: 'hidden'
  }
}

function SelectionOverlay({
  clip,
  stageRef
}: {
  clip: Clip
  stageRef: React.RefObject<HTMLDivElement>
}): JSX.Element {
  const update = useEditor((s) => s.updateClip)
  const wPct = clip.scale * 100
  const leftPct = 50 + clip.xFrac * 100 - wPct / 2
  const topPct = 50 + clip.yFrac * 100 - wPct / 2

  function startMove(e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const startX = e.clientX
    const startY = e.clientY
    const ox = clip.xFrac
    const oy = clip.yFrac
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / rect.width
      const dy = (ev.clientY - startY) / rect.height
      update(clip.id, { xFrac: clamp(ox + dx, -1.5, 1.5), yFrac: clamp(oy + dy, -1.5, 1.5) })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function startResize(e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const cx = rect.left + rect.width * (0.5 + clip.xFrac)
    const cy = rect.top + rect.height * (0.5 + clip.yFrac)
    const onMove = (ev: MouseEvent) => {
      const dxFrac = Math.abs(ev.clientX - cx) / rect.width
      const dyFrac = Math.abs(ev.clientY - cy) / rect.height
      update(clip.id, { scale: clamp(Math.max(dxFrac, dyFrac) * 2, 0.05, 4) })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const corners = ['nw', 'ne', 'se', 'sw'] as const
  return (
    <div
      className="sel-frame"
      style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${wPct}%`, height: `${wPct}%` }}
      onMouseDown={startMove}
    >
      {corners.map((pos) => (
        <div key={pos} className={`sel-handle ${pos}`} onMouseDown={startResize} />
      ))}
    </div>
  )
}
