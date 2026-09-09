import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { Clip, Marker, MediaItem, ProjectData, TextConfig, Track } from './types'
import { defaultEffect, CAMERA_MOTIONS } from './motion'

interface Snapshot {
  media: MediaItem[]
  tracks: Track[]
  clips: Clip[]
  markers: Marker[]
  projectW: number
  projectH: number
  projectFps: number
  masterVolume: number
}

interface EditorState extends Snapshot {
  playhead: number
  isPlaying: boolean
  pps: number
  trackHeight: number // vertical zoom (px per track)
  selectedClipId: string | null
  selectedClipIds: string[] // multi-selection (selectedClipId is the primary)
  _clipboard: Clip[]
  markers: Marker[]
  loopIn: number | null // preview loop range (session-only, not persisted)
  loopOut: number | null
  _past: Snapshot[]
  _future: Snapshot[]
  dirty: boolean

  // derived
  duration: () => number
  trackOrder: (trackId: string) => number

  // history
  commit: () => void
  commitThrottled: () => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean

  // project
  serialize: () => ProjectData
  loadProject: (data: ProjectData, preserveUndo?: boolean) => void
  newProject: () => void
  markClean: () => void

  // actions
  addMedia: (m: MediaItem) => void
  addRecording: (m: MediaItem) => void
  addDualRecording: (screen: MediaItem, cam: MediaItem) => void
  setMediaAudioPaths: (mediaId: string, audioPath: string | null, audioPaths: string[] | null) => void
  relinkMedia: (mediaId: string, newPath: string) => void
  setPeaks: (mediaId: string, peaks: number[]) => void
  removeMedia: (id: string) => void
  removeUnusedMedia: () => number
  addClip: (mediaId: string, trackId: string, start: number) => void
  addTextClip: (trackId: string, start: number) => void
  updateClip: (id: string, patch: Partial<Clip>) => void
  removeClip: (id: string) => void
  splitAtPlayhead: () => void
  detachAudio: (clipId: string) => void
  setDetachedAudioVolume: (clipId: string, volume: number) => void
  addEffect: (clipId: string, type: import('./types').EffectType) => void
  updateEffect: (clipId: string, effectId: string, patch: Partial<import('./types').Effect>) => void
  removeEffect: (clipId: string, effectId: string) => void
  setLook: (clipId: string, look: import('../../shared/looks').LookId) => void
  setTransition: (clipId: string, type: import('./types').TransitionType | 'none', duration: number) => void
  addTrack: (kind: 'video' | 'audio') => void
  removeTrack: (id: string) => void
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  setZoom: (pps: number) => void
  setTrackHeight: (h: number) => void
  select: (id: string | null) => void
  selectedTrackId: string | null
  selectTrack: (id: string | null) => void
  toggleSelect: (id: string) => void
  copySelection: () => void
  pasteAtPlayhead: () => void
  nudgeSelected: (deltaSec: number) => void
  removeSelected: () => void
  removeSelectedKeepGap: () => void
  toggleTrackFlag: (trackId: string, flag: 'muted' | 'solo' | 'locked') => void
  rippleDeleteSelected: () => void
  cutSourceRanges: (clipId: string, ranges: Array<{ start: number; end: number }>) => number
  addMarkerAtPlayhead: () => void
  removeMarker: (id: string) => void
  setLoopIn: (t: number | null) => void
  setLoopOut: (t: number | null) => void
  clearLoop: () => void
  setMasterVolume: (volume: number) => void
  setProject: (patch: Partial<Pick<EditorState, 'projectW' | 'projectH' | 'projectFps'>>) => void
}

// A recording lands EXACTLY on the playhead. When the preferred lane is already
// busy there we slide the take UP to a free lane (creating one if every lane is
// occupied) instead of sliding it FORWARD to the next gap — sliding forward is
// what used to dump every take at the end of the timeline. Nothing already on
// the timeline moves: rippling the lane right would shift edits the user
// already made and desync paired screen/camera clips.
function freeVideoLane(
  tracks: Track[],
  clips: Clip[],
  start: number,
  dur: number,
  opts: { exclude?: string[]; prefer?: string | null; from?: 'top' | 'bottom' } = {}
): { trackId: string; tracks: Track[] } {
  const eps = 1e-3
  const busy = (id: string): boolean =>
    clips.some(
      (c) => c.trackId === id && c.start < start + dur - eps && c.start + c.duration > start + eps
    )
  const vids = tracks.filter((t) => t.kind === 'video')
  let order = opts.from === 'bottom' ? [...vids].reverse() : vids
  const pref = opts.prefer ? vids.find((t) => t.id === opts.prefer) : undefined
  if (pref) order = [pref, ...order.filter((t) => t.id !== pref.id)]
  for (const t of order) {
    if (opts.exclude?.includes(t.id)) continue
    if (!busy(t.id)) return { trackId: t.id, tracks }
  }
  // Every lane is taken at this instant — add one on top (index 0 is topmost).
  const t: Track = { id: nanoid(6), name: `Vídeo ${vids.length + 1}`, kind: 'video' }
  return { trackId: t.id, tracks: [t, ...tracks] }
}

let lastThrottle = 0

const defaultTracks: Track[] = [
  { id: 'v2', kind: 'video', name: 'Vídeo 2' },
  { id: 'v1', kind: 'video', name: 'Vídeo 1' },
  { id: 'a1', kind: 'audio', name: 'Áudio 1' }
]

const defaultText: TextConfig = {
  content: 'Seu texto aqui',
  fontSizeRel: 0.09,
  color: '#ffffff',
  fontFamily: 'Segoe UI, sans-serif',
  bold: true,
  italic: false,
  align: 'center',
  bgColor: null,
  outline: true
}

function snapshot(s: EditorState): Snapshot {
  return {
    media: s.media,
    tracks: s.tracks,
    clips: s.clips,
    markers: s.markers,
    projectW: s.projectW,
    projectH: s.projectH,
    projectFps: s.projectFps,
    masterVolume: s.masterVolume
  }
}

const baseClip = (over: Partial<Clip>): Clip => ({
  id: nanoid(8),
  mediaId: '',
  trackId: '',
  type: 'video',
  start: 0,
  duration: 3,
  inPoint: 0,
  volume: 1,
  pan: 0,
  scale: 1,
  xFrac: 0,
  yFrac: 0,
  rotate: 0,
  opacity: 1,
  fit: 'contain',
  speed: 1,
  fadeIn: 0,
  fadeOut: 0,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  duck: false,
  ...over
})

export const useEditor = create<EditorState>((set, get) => ({
  media: [],
  tracks: defaultTracks,
  clips: [],
  playhead: 0,
  isPlaying: false,
  pps: 80,
  trackHeight: 64,
  selectedClipId: null,
  selectedClipIds: [],
  _clipboard: [],
  markers: [],
  loopIn: null,
  loopOut: null,
  projectW: 1920,
  projectH: 1080,
  projectFps: 30,
  masterVolume: 1,
  _past: [],
  _future: [],
  dirty: false,

  duration: () => get().clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0),

  trackOrder: (trackId) => {
    const tracks = get().tracks
    const idx = tracks.findIndex((t) => t.id === trackId)
    return idx < 0 ? 0 : tracks.length - idx
  },

  commit: () =>
    set((s) => ({ _past: [...s._past, snapshot(s)].slice(-60), _future: [], dirty: true })),

  commitThrottled: () => {
    const now = Date.now()
    if (now - lastThrottle > 500) {
      lastThrottle = now
      get().commit()
    }
  },

  undo: () =>
    set((s) => {
      if (s._past.length === 0) return {}
      const prev = s._past[s._past.length - 1]
      return {
        ...prev,
        _past: s._past.slice(0, -1),
        _future: [snapshot(s), ...s._future].slice(0, 60),
        dirty: true,
        selectedClipId: prev.clips.some((c) => c.id === s.selectedClipId) ? s.selectedClipId : null
      }
    }),

  redo: () =>
    set((s) => {
      if (s._future.length === 0) return {}
      const next = s._future[0]
      return {
        ...next,
        _past: [...s._past, snapshot(s)].slice(-60),
        _future: s._future.slice(1),
        dirty: true
      }
    }),

  canUndo: () => get()._past.length > 0,
  canRedo: () => get()._future.length > 0,

  serialize: () => {
    const s = get()
    return {
      version: 1,
      projectW: s.projectW,
      projectH: s.projectH,
      projectFps: s.projectFps,
      masterVolume: s.masterVolume,
      media: s.media,
      tracks: s.tracks,
      clips: s.clips,
      markers: s.markers
    }
  },

  loadProject: (data, preserveUndo = false) => {
    // Repair image durations mangled by the old JPG probe (still frames that came
    // in at ~0.04s). Bump the media and any sliver-thin image clip to a usable
    // length so they can be grabbed and stretched.
    const media = (data.media || []).map((m) =>
      m.type === 'image' && (!m.duration || m.duration < 0.5) ? { ...m, duration: 5 } : m
    )
    const clips = (data.clips || []).map((c) => {
      const b = baseClip(c)
      if (b.type === 'image' && b.duration < 0.3) return { ...b, duration: 5, inPoint: 0 }
      return b
    })
    const current = get()
    set({
      media,
      tracks: data.tracks?.length ? data.tracks : defaultTracks,
      clips,
      markers: data.markers || [],
      projectW: data.projectW || 1920,
      projectH: data.projectH || 1080,
      projectFps: data.projectFps || 30,
      masterVolume: data.masterVolume ?? 1,
      playhead: 0,
      selectedClipId: null,
      selectedClipIds: [],
      _past: preserveUndo ? [...current._past, snapshot(current)].slice(-60) : [],
      _future: [],
      dirty: false
    })
  },

  newProject: () =>
    set({
      media: [],
      tracks: defaultTracks,
      clips: [],
      markers: [],
      masterVolume: 1,
      loopIn: null,
      loopOut: null,
      playhead: 0,
      selectedClipId: null,
      selectedClipIds: [],
      _past: [],
      _future: [],
      dirty: false
    }),

  markClean: () => set({ dirty: false }),

  addMedia: (m) => {
    get().commit()
    set((s) => ({ media: [...s.media, m] }))
  },

  // Screen + camera take (OBS-style, but as SEPARATE clips so the facecam stays
  // editable): screen goes full-frame on a lower video track, the camera lands on
  // the track above it at the same start — small, bottom-right, circle-masked.
  // Both start at the current end of the project, so takes stack end-to-end.
  addDualRecording: (screen, cam) => {
    get().commit()
    const s = get()
    const start = Math.max(0, s.playhead)
    const dur = Math.min(screen.duration || 3, cam.duration || 3)
    // Screen is the base layer, so it looks for a free lane from the bottom up;
    // the camera takes another free lane and must end up ABOVE it or the PiP
    // would be composited underneath the screen capture.
    const a = freeVideoLane(s.tracks, s.clips, start, dur, { from: 'bottom' })
    const b = freeVideoLane(a.tracks, s.clips, start, dur, { exclude: [a.trackId] })
    const tracks = b.tracks
    const idx = (id: string): number => tracks.findIndex((t) => t.id === id)
    const [camId, screenId] =
      idx(b.trackId) < idx(a.trackId) ? [b.trackId, a.trackId] : [a.trackId, b.trackId]
    const camTrack = { id: camId }
    const screenTrack = { id: screenId }
    const screenClip = baseClip({
      mediaId: screen.id,
      trackId: screenTrack.id,
      type: 'video',
      start,
      duration: dur,
      fit: 'contain'
    })
    const camClip = baseClip({
      mediaId: cam.id,
      trackId: camTrack.id,
      type: 'video',
      start,
      duration: dur,
      fit: 'cover',
      scale: 0.28,
      xFrac: 0.33,
      yFrac: 0.32,
      mask: 'circle'
    })
    set(() => ({
      media: [...s.media, screen, cam],
      tracks,
      clips: [...s.clips, screenClip, camClip],
      selectedClipId: camClip.id,
      playhead: start + dur
    }))
  },

  // A saved recording lands ON THE PLAYHEAD — never at the end of the timeline.
  // The lane is the one the user is working in (selected clip's track →
  // last-clicked track → first free video track); if that lane is busy at the
  // playhead the take goes to a free lane above instead of being pushed forward
  // in time. The playhead then jumps to the end of the new clip, so consecutive
  // takes chain naturally from the needle.
  addRecording: (m) => {
    get().commit()
    const s = get()
    const dur = m.duration || 3
    const start = Math.max(0, s.playhead)
    const selClip = s.clips.find((c) => c.id === s.selectedClipId)
    const prefer =
      (selClip && s.tracks.find((t) => t.id === selClip.trackId && t.kind === 'video')?.id) ||
      s.tracks.find((t) => t.id === s.selectedTrackId && t.kind === 'video')?.id ||
      null
    const { trackId, tracks } = freeVideoLane(s.tracks, s.clips, start, dur, { prefer })
    const clip = baseClip({
      mediaId: m.id,
      trackId,
      type: 'video',
      start,
      duration: dur,
      fit: 'contain'
    })
    set(() => ({
      media: [...s.media, m],
      tracks,
      clips: [...s.clips, clip],
      selectedClipId: clip.id,
      playhead: start + dur
    }))
  },

  setPeaks: (mediaId, peaks) =>
    set((s) => ({ media: s.media.map((m) => (m.id === mediaId ? { ...m, peaks } : m)) })),

  setMediaAudioPaths: (mediaId, audioPath, audioPaths) =>
    set((s) => ({
      media: s.media.map((m) => (m.id === mediaId ? { ...m, audioPath, audioPaths, peaks: undefined } : m)),
      dirty: true
    })),

  // A file moved/renamed on disk; point the existing media entry (and every
  // clip that already references it) at the new location instead of making
  // the user re-import and re-place every clip.
  relinkMedia: (mediaId, newPath) => {
    get().commit()
    set((s) => ({
      media: s.media.map((m) => (m.id === mediaId ? { ...m, path: newPath } : m)),
      dirty: true
    }))
  },

  removeMedia: (id) => {
    get().commit()
    set((s) => ({
      media: s.media.filter((m) => m.id !== id),
      clips: s.clips.filter((c) => c.mediaId !== id)
    }))
  },

  // Drop library items that no clip references. Returns how many were removed.
  removeUnusedMedia: () => {
    const s = get()
    const used = new Set(s.clips.map((c) => c.mediaId))
    const unused = s.media.filter((m) => !used.has(m.id))
    if (unused.length === 0) return 0
    s.commit()
    set((st) => ({ media: st.media.filter((m) => used.has(m.id)) }))
    return unused.length
  },

  addClip: (mediaId, trackId, start) => {
    const m = get().media.find((x) => x.id === mediaId)
    if (!m) return
    if (!get().tracks.find((t) => t.id === trackId)) return
    get().commit()
    const clip = baseClip({
      mediaId,
      trackId,
      type: m.type,
      start: Math.max(0, start),
      // A still's own "duration" is meaningless (a JPG reports ~0.04s), so images
      // always start at a usable length; only video/audio inherit media duration.
      duration: m.type === 'image' ? 5 : m.duration || 3,
      // Images (icons/overlays, often transparent PNGs) show whole — cropping
      // them to fill would cut off the graphic. Full-frame backgrounds can be
      // switched to 'cover' in the Inspector.
      fit: 'contain'
    })
    set((s) => ({ clips: [...s.clips, clip], selectedClipId: clip.id }))
  },

  addTextClip: (trackId, start) => {
    if (!get().tracks.find((t) => t.id === trackId)) return
    get().commit()
    const clip = baseClip({
      type: 'text',
      trackId,
      start: Math.max(0, start),
      duration: 4,
      yFrac: 0.32,
      text: { ...defaultText }
    })
    set((s) => ({ clips: [...s.clips, clip], selectedClipId: clip.id }))
  },

  updateClip: (id, patch) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      dirty: true
    })),

  removeClip: (id) => {
    get().commit()
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId
    }))
  },

  // Cuts EVERY selected clip at the playhead in one go, so a video and the
  // audio/overlays stacked with it stay aligned — cutting them one at a time
  // was how takes drifted out of sync.
  splitAtPlayhead: () => {
    const s = get()
    const ids = s.selectedClipIds.length
      ? s.selectedClipIds
      : s.selectedClipId
        ? [s.selectedClipId]
        : []
    if (ids.length === 0) return
    const playhead = s.playhead
    const targets = s.clips.filter(
      (c) =>
        ids.includes(c.id) &&
        playhead > c.start + 0.05 &&
        playhead < c.start + c.duration - 0.05
    )
    // Nothing the playhead actually crosses — leave the timeline untouched
    // rather than committing an empty undo step.
    if (targets.length === 0) return
    s.commit()

    const cut = new Set(targets.map((c) => c.id))
    const halves: Clip[] = []
    for (const target of targets) {
      const offset = playhead - target.start
      halves.push({
        ...target,
        duration: offset,
        // The left half ends mid-clip: an exit animation belongs to the right.
        anim: target.anim ? { ...target.anim, out: undefined, outDur: undefined } : undefined
      })
      halves.push({
        ...target,
        id: nanoid(8),
        start: playhead,
        duration: target.duration - offset,
        inPoint: target.inPoint + offset * target.speed,
        text: target.text ? { ...target.text } : undefined,
        // A transition blends a clip with the one before it. The right half now
        // starts mid-clip, so carrying the original's transition over would
        // duplicate it in the middle of what used to be one continuous shot.
        transition: undefined,
        anim: target.anim ? { ...target.anim, in: undefined, inDur: undefined } : undefined
      })
    }
    set((st) => ({
      clips: [...st.clips.filter((c) => !cut.has(c.id)), ...halves],
      // Keep the left halves selected so a second cut continues from there.
      selectedClipIds: targets.map((c) => c.id),
      selectedClipId: targets[0].id
    }))
  },

  // Split the audio off a video clip onto a (auto-created) audio track, and
  // mute the original video clip so the sound isn't doubled.
  detachAudio: (clipId) => {
    const s = get()
    const clip = s.clips.find((c) => c.id === clipId)
    if (!clip || clip.type !== 'video') return
    const media = s.media.find((m) => m.id === clip.mediaId)
    if (!media || !media.hasAudio) return
    s.commit()
    set((st) => {
      let tracks = st.tracks
      const sources = media.audioPaths?.length ? media.audioPaths : [media.audioPath || media.path]
      const audioTracks = tracks.filter((t) => t.kind === 'audio')
      while (audioTracks.length < sources.length) {
        const track = { id: nanoid(6), kind: 'audio' as const, name: `Áudio ${audioTracks.length + 1}` }
        tracks = [...tracks, track]
        audioTracks.push(track)
      }
      const audioClips: Clip[] = sources.map((audioSourcePath, i) => ({
        ...clip,
        id: nanoid(8),
        trackId: audioTracks[i].id,
        type: 'audio',
        audioSourcePath,
        detachedFromClipId: clip.id,
        volume: clip.volume > 0 ? clip.volume : 1,
        scale: 1,
        xFrac: 0,
        yFrac: 0,
        opacity: 1,
        fit: 'contain',
        brightness: 0,
        contrast: 1,
        saturation: 1,
        effects: undefined,
        text: undefined,
        transition: undefined
      }))
      return {
        tracks,
        clips: st.clips.map((c) => (c.id === clipId ? { ...c, volume: 0 } : c)).concat(audioClips),
        dirty: true
      }
    })
  },

  setDetachedAudioVolume: (clipId, volume) =>
    set((st) => {
      const video = st.clips.find((c) => c.id === clipId && c.type === 'video')
      if (!video) return st
      const belongsToVideo = (c: Clip): boolean =>
        c.type === 'audio' &&
        (c.detachedFromClipId === clipId ||
          (!c.detachedFromClipId &&
            !!c.audioSourcePath &&
            c.mediaId === video.mediaId &&
            Math.abs(c.start - video.start) < 0.001 &&
            Math.abs(c.duration - video.duration) < 0.001))
      return {
        clips: st.clips.map((c) =>
          c.id === clipId ? { ...c, volume: 0 } : belongsToVideo(c) ? { ...c, volume } : c
        ),
        dirty: true
      }
    }),

  addEffect: (clipId, type) => {
    get().commit()
    const eff = { id: nanoid(6), ...defaultEffect(type, get().clips.find((c) => c.id === clipId)?.duration ?? 4) }
    const isCamera = CAMERA_MOTIONS.has(type)
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id !== clipId) return c
        // Camera motions swap (one at a time); a "look" replaces only the same look.
        const kept = (c.effects || []).filter((e) =>
          isCamera ? !CAMERA_MOTIONS.has(e.type) : e.type !== type
        )
        return { ...c, effects: [...kept, eff] }
      })
    }))
  },

  updateEffect: (clipId, effectId, patch) =>
    set((st) => ({
      clips: st.clips.map((c) =>
        c.id === clipId
          ? { ...c, effects: (c.effects || []).map((e) => (e.id === effectId ? { ...e, ...patch } : e)) }
          : c
      ),
      dirty: true
    })),

  removeEffect: (clipId, effectId) => {
    get().commit()
    set((st) => ({
      clips: st.clips.map((c) =>
        c.id === clipId ? { ...c, effects: (c.effects || []).filter((e) => e.id !== effectId) } : c
      )
    }))
  },

  // A clip carries at most one look; picking a new one replaces the old.
  setLook: (clipId, look) => {
    get().commit()
    set((st) => ({
      clips: st.clips.map((c) =>
        c.id === clipId ? { ...c, look: look === 'none' ? undefined : look } : c
      )
    }))
  },

  setTransition: (clipId, type, duration) => {
    const s = get()
    const clip = s.clips.find((c) => c.id === clipId)
    if (!clip) return
    s.commitThrottled()
    if (type === 'none') {
      set((st) => ({ clips: st.clips.map((c) => (c.id === clipId ? { ...c, transition: undefined } : c)) }))
      return
    }
    // Find the clip just before this one on the same track.
    const prev = s.clips
      .filter((c) => c.id !== clipId && c.trackId === clip.trackId && c.start < clip.start)
      .sort((a, b) => b.start + b.duration - (a.start + a.duration))[0]
    let newStart = clip.start
    if (prev) {
      const prevEnd = prev.start + prev.duration
      // Only auto-overlap when the clips are touching or already overlapping.
      if (clip.start <= prevEnd + 0.1) {
        newStart = Math.max(prev.start + 0.1, prevEnd - duration)
      }
    }
    // A crossfade needs the incoming clip to START BEFORE the previous one ends
    // (the export only pairs clips that genuinely overlap). Pulling it back left
    // a gap of exactly `duration` — black frames — because everything after it
    // stayed put. Ripple the whole chain by the same amount so the cut stays
    // tight, which is what every NLE does when you drop a transition on a seam.
    const shift = clip.start - newStart
    const laterIds = new Set(
      shift > 0.001
        ? s.clips
            .filter((c) => c.trackId === clip.trackId && c.start > clip.start + 0.001)
            .map((c) => c.id)
        : []
    )
    set((st) => ({
      clips: st.clips.map((c) => {
        if (c.id === clipId) return { ...c, start: newStart, transition: { type, duration } }
        if (laterIds.has(c.id)) return { ...c, start: Math.max(0, c.start - shift) }
        return c
      })
    }))
  },

  addTrack: (kind) => {
    get().commit()
    set((s) => {
      const count = s.tracks.filter((t) => t.kind === kind).length + 1
      const track: Track = {
        id: nanoid(6),
        kind,
        name: `${kind === 'video' ? 'Vídeo' : 'Áudio'} ${count}`
      }
      if (kind === 'video') return { tracks: [track, ...s.tracks] }
      return { tracks: [...s.tracks, track] }
    })
  },

  removeTrack: (id) => {
    get().commit()
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      clips: s.clips.filter((c) => c.trackId !== id)
    }))
  },

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (p) => set({ isPlaying: p }),
  // Floor low enough that "Caber" can fit a whole long recording (a 56-minute
  // timeline in ~1200px of ruler needs ~0.35 px/s) instead of hitting a wall
  // and refusing to zoom out any further.
  setZoom: (pps) => set({ pps: Math.min(400, Math.max(0.2, pps)) }),
  setTrackHeight: (h) => set({ trackHeight: Math.min(120, Math.max(18, h)) }),
  select: (id) => set({ selectedClipId: id, selectedClipIds: id ? [id] : [] }),
  selectedTrackId: null,
  selectTrack: (id) => set({ selectedTrackId: id }),

  // Shift/Ctrl+click: toggle membership; the clicked clip becomes primary.
  toggleSelect: (id) =>
    set((s) => {
      const has = s.selectedClipIds.includes(id)
      const ids = has ? s.selectedClipIds.filter((x) => x !== id) : [...s.selectedClipIds, id]
      return { selectedClipIds: ids, selectedClipId: has ? (ids[ids.length - 1] ?? null) : id }
    }),

  copySelection: () => {
    const s = get()
    const ids = s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : []
    const copied = s.clips.filter((c) => ids.includes(c.id)).map((c) => JSON.parse(JSON.stringify(c)) as Clip)
    if (copied.length) set({ _clipboard: copied })
  },

  // Paste keeping relative offsets: earliest copied clip lands on the playhead,
  // on the track the user clicked.
  //
  // The clipboard's own trackId used to win unconditionally, so the obvious way
  // to duplicate audio onto a new track — copy, click the new track, paste —
  // silently dropped the copy right back where it came from, stacked on the
  // original. Anchoring on the selected track is what makes that workflow work.
  pasteAtPlayhead: () => {
    const s = get()
    if (s._clipboard.length === 0) return

    const idxOf = (id: string): number => s.tracks.findIndex((t) => t.id === id)
    const kindFor = (c: Clip): 'video' | 'audio' => (c.type === 'audio' ? 'audio' : 'video')

    // Source tracks in the timeline's own top-to-bottom order, so a copy that
    // spans several tracks keeps its shape instead of collapsing onto one.
    const srcIds = [...new Set(s._clipboard.map((c) => c.trackId))].sort((a, b) => {
      const ia = idxOf(a)
      const ib = idxOf(b)
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
    })
    const anchorIdx = idxOf(srcIds[0])
    const targetIdx = s.selectedTrackId ? idxOf(s.selectedTrackId) : -1
    const delta = targetIdx >= 0 && anchorIdx >= 0 ? targetIdx - anchorIdx : 0

    const retarget = (c: Clip): string | null => {
      const want = delta !== 0 ? s.tracks[idxOf(c.trackId) + delta] : undefined
      if (want && want.kind === kindFor(c)) return want.id
      // No shifted track of the right kind (edge of the stack, or a kind
      // mismatch) — fall back to the original, and drop it only if that is
      // gone too.
      return s.tracks.some((t) => t.id === c.trackId) ? c.trackId : null
    }

    const t0 = Math.min(...s._clipboard.map((c) => c.start))
    const shift = s.playhead - t0
    const pasted = s._clipboard
      .map((c) => ({ clip: c, trackId: retarget(c) }))
      .filter((x): x is { clip: Clip; trackId: string } => x.trackId !== null)
      .map(({ clip, trackId }) => ({
        ...clip,
        id: nanoid(8),
        trackId,
        start: Math.max(0, clip.start + shift)
      }))
    if (pasted.length === 0) return
    s.commit()
    set((st) => ({
      clips: [...st.clips, ...pasted],
      selectedClipIds: pasted.map((c) => c.id),
      selectedClipId: pasted[0].id
    }))
  },

  nudgeSelected: (deltaSec) => {
    const s = get()
    const ids = s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : []
    if (ids.length === 0) return
    s.commitThrottled()
    set((st) => ({
      clips: st.clips.map((c) => (ids.includes(c.id) ? { ...c, start: Math.max(0, c.start + deltaSec) } : c)),
      dirty: true
    }))
  },

  // Deleting closes the gap by default, matching what trimming already does:
  // shortening a clip pulls the following ones back, so deleting one leaving a
  // hole behind was the odd one out. Use removeSelectedKeepGap (Shift+Del) for
  // the rare case where the hole is wanted.
  removeSelected: () => {
    get().rippleDeleteSelected()
  },

  removeSelectedKeepGap: () => {
    const s = get()
    const ids = new Set(s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : [])
    if (ids.size === 0) return
    s.commit()
    set((st) => ({
      clips: st.clips.filter((c) => !ids.has(c.id)),
      selectedClipId: null,
      selectedClipIds: []
    }))
  },

  toggleTrackFlag: (trackId, flag) => {
    get().commit()
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, [flag]: !t[flag] } : t))
    }))
  },

  // Delete the selection and close the gaps: clips on the same track that come
  // after each removed clip shift left by its duration.
  rippleDeleteSelected: () => {
    const s = get()
    const ids = new Set(s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : [])
    if (ids.size === 0) return
    s.commit()
    set((st) => {
      const removed = st.clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start)
      let clips = st.clips.filter((c) => !ids.has(c.id))
      for (const r of removed) {
        clips = clips.map((c) =>
          c.trackId === r.trackId && c.start >= r.start + r.duration - 0.001
            ? { ...c, start: Math.max(0, c.start - r.duration) }
            : c
        )
      }
      return { clips, selectedClipId: null, selectedClipIds: [] }
    })
  },

  // Cut ranges (expressed in SOURCE time) out of a clip. The clip is replaced by
  // one clip per surviving segment, laid out back-to-back so no gap is left.
  // Returns the number of seconds removed.
  cutSourceRanges: (clipId, ranges) => {
    const s = get()
    const clip = s.clips.find((c) => c.id === clipId)
    if (!clip || ranges.length === 0) return 0

    const srcStart = clip.inPoint
    const srcEnd = clip.inPoint + clip.duration * clip.speed
    // Clamp to the clip's own source window and merge.
    const cuts = ranges
      .map((r) => ({ start: Math.max(r.start, srcStart), end: Math.min(r.end, srcEnd) }))
      .filter((r) => r.end - r.start > 0.02)
      .sort((a, b) => a.start - b.start)
    if (cuts.length === 0) return 0

    // Surviving source segments.
    const keeps: Array<{ start: number; end: number }> = []
    let cursor = srcStart
    for (const c of cuts) {
      if (c.start > cursor) keeps.push({ start: cursor, end: c.start })
      cursor = Math.max(cursor, c.end)
    }
    if (cursor < srcEnd) keeps.push({ start: cursor, end: srcEnd })
    const survivors = keeps.filter((k) => k.end - k.start > 0.05)
    if (survivors.length === 0) return 0

    s.commit()
    let out = clip.start
    const made: Clip[] = survivors.map((k) => {
      const dur = (k.end - k.start) / clip.speed
      const c: Clip = { ...JSON.parse(JSON.stringify(clip)), id: nanoid(8), inPoint: k.start, start: out, duration: dur }
      out += dur
      return c
    })
    // Derive the shift from how much the clip actually shrank, never from the
    // raw cut list — overlapping cuts would otherwise be counted twice and the
    // downstream clips would slide too far left (and overlap).
    const newTotal = made.reduce((a, c) => a + c.duration, 0)
    const shift = clip.duration - newTotal
    const removed = shift * clip.speed
    set((st) => ({
      clips: st.clips
        .filter((c) => c.id !== clipId)
        .map((c) =>
          c.trackId === clip.trackId && c.start >= clip.start + clip.duration - 0.001
            ? { ...c, start: Math.max(0, c.start - shift) }
            : c
        )
        .concat(made),
      selectedClipId: made[0].id,
      selectedClipIds: made.map((c) => c.id)
    }))
    return removed
  },

  addMarkerAtPlayhead: () => {
    const s = get()
    s.commit()
    const m: Marker = { id: nanoid(6), time: +s.playhead.toFixed(3) }
    set((st) => ({ markers: [...st.markers, m].sort((a, b) => a.time - b.time) }))
  },

  removeMarker: (id) => {
    get().commit()
    set((s) => ({ markers: s.markers.filter((m) => m.id !== id) }))
  },

  setLoopIn: (t) => set({ loopIn: t }),
  setLoopOut: (t) => set({ loopOut: t }),
  clearLoop: () => set({ loopIn: null, loopOut: null }),

  setMasterVolume: (volume) => set({ masterVolume: Math.max(0, Math.min(2, volume)), dirty: true }),

  setProject: (patch) => {
    get().commit()
    set(patch)
  }
}))
