import type { LookId } from '../../shared/looks'

export type MediaType = 'video' | 'audio' | 'image'
export type ClipType = MediaType | 'text'

export interface MediaItem {
  id: string
  name: string
  path: string
  audioPath?: string | null // all embedded audio tracks mixed for preview/export
  audioPaths?: string[] | null // individual embedded tracks for detach-audio
  type: MediaType
  duration: number
  width: number
  height: number
  hasAudio: boolean
  hasVideo: boolean
  fps: number
  peaks?: number[] // downsampled audio waveform (0..1), for audio clips
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted?: boolean // silence this track's clips (visuals still show)
  solo?: boolean // when any track is solo, only solo tracks are audible
  locked?: boolean // clips can't be dragged/trimmed
}

export type FitMode = 'contain' | 'cover' | 'fill'

export type TransitionType =
  | 'fade'
  | 'dissolve'
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  | 'wipeleft'
  | 'wiperight'
  | 'zoom'
  | 'circle'

export interface Transition {
  type: TransitionType
  duration: number // seconds
}

export type EffectType =
  | 'zoompunch'
  | 'kenburns'
  | 'snapzoom'
  | 'breathe'
  | 'panright'
  | 'panleft'
  | 'panup'
  | 'pandown'
  | 'tilt'
  | 'shake'
  | 'vignette'
  | 'blur'
  | 'bw'

export interface Effect {
  id: string
  type: EffectType
  at: number // start time within the clip (s)
  duration: number // effect length (s)
  amount: number // intensity (zoom %, shake px, vignette/blur strength)
}

// Element animations (entrance / loop / exit), à la CapCut/FlexClip.
export type AnimIn =
  | 'none'
  | 'fade'
  | 'popup'
  | 'slideL'
  | 'slideR'
  | 'slideU'
  | 'slideD'
  | 'fall'
  | 'zoom'
  | 'rotate'
  | 'grow' // scales along the chosen axis with the opposite edge anchored
  | 'wipe' // revealed by an alpha mask sweeping across; nothing moves
  | 'flip' // orthographic 3D card turn about the Y axis (scaleX = cos θ)
  | 'flip3d' // same about the X axis
  | 'spin3d'
  | 'bounce'
  | 'jump'
  | 'drift'
  | 'dash'
  | 'breath'
  | 'heartbeat'
  | 'scrapbook'
  | 'tumble'
  | 'stomp'
export type AnimLoop =
  | 'none'
  | 'pulse'
  | 'shake'
  | 'sway'
  | 'sway3d'
  | 'wiggle'
  | 'jiggle'
  | 'float'
  | 'jump'
  | 'heartbeat'
  | 'neon'
  | 'spin'
  | 'spin3d'
  | 'flip'
  | 'credits'
  | 'creditsOnce'
  | 'balloon'
export type AnimOut =
  | 'none'
  | 'fade'
  | 'popout'
  | 'slideL'
  | 'slideR'
  | 'slideU'
  | 'slideD'
  | 'zoom'
  | 'rotate'
  | 'wipe'
  | 'flip'
  | 'flip3d'
  | 'spin3d'
  | 'bounce'
  | 'jump'
  | 'drift'
  | 'dash'
  | 'breath'
  | 'heartbeat'
  | 'scrapbook'
  | 'tumble'
  | 'stomp'

// Direction an entrance comes FROM / an exit goes TO.
export type AnimDir =
  | 'center'
  | 'right'
  | 'left'
  | 'down'
  | 'up'
  | 'upright'
  | 'upleft'
  | 'downright'
  | 'downleft'

export interface ClipAnim {
  in?: AnimIn
  inDur?: number // seconds
  inDir?: AnimDir
  loop?: AnimLoop
  loopSpeed?: number // rate multiplier: 1 = default, 2 = twice as fast
  out?: AnimOut
  outDur?: number // seconds
  outDir?: AnimDir
}

export interface TextConfig {
  content: string
  fontSizeRel: number // fraction of canvas height
  color: string
  fontFamily: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  bgColor: string | null // null = transparent
  outline: boolean
}

export interface Clip {
  id: string
  mediaId: string // '' for text clips
  trackId: string
  type: ClipType
  start: number // position on the timeline (s)
  duration: number // length on the timeline (s)
  inPoint: number // trim offset inside the source (s)
  volume: number // 0..2
  pan: number // -1 (esquerda) .. 1 (direita), 0 = centro
  audioSourcePath?: string // one detached embedded audio track
  detachedFromClipId?: string // video clip that owns this detached audio
  // transform for picture-in-picture / layering
  scale: number // 1 = full canvas box
  xFrac: number
  yFrac: number
  /** Giro fixo em graus (0..360). Nao confundir com as animacoes de rotacao. */
  rotate?: number
  opacity: number // 0..1
  fit: FitMode
  // playback
  speed: number // 1 = normal
  // fades (seconds)
  fadeIn: number
  fadeOut: number
  // color (eq semantics)
  brightness: number // -1..1, 0 = none
  contrast: number // 0..2, 1 = none
  saturation: number // 0..3, 1 = none
  // named colour look (Efeitos › Textura); stacks on top of the eq above
  look?: LookId
  // audio
  duck: boolean // lower this clip when other audio overlaps
  // transition played at this clip's incoming edge (blends with the clip before it)
  transition?: Transition
  // motion / focus effects
  effects?: Effect[]
  // element animations (in / loop / out)
  anim?: ClipAnim
  // shape mask (narrator inside a circle, etc.) — same shape in preview and export
  mask?: MaskShape
  // text
  text?: TextConfig
}

// A shape the clip is cropped to. 'none' = full rectangle.
export type MaskShape = 'none' | 'circle' | 'ellipse' | 'roundrect'

export interface Marker {
  id: string
  time: number // timeline position (s)
  label?: string
  color?: string
}

export interface ProjectData {
  version: number
  projectW: number
  projectH: number
  projectFps: number
  masterVolume?: number
  media: MediaItem[]
  tracks: Track[]
  clips: Clip[]
  markers?: Marker[]
}
