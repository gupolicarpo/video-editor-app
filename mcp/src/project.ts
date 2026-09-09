import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import type { Clip, ProjectData, TextConfig, Track } from '../../src/renderer/src/types'

export type {
  Clip,
  ClipType,
  FitMode,
  MediaItem,
  MediaType,
  ProjectData,
  TextConfig,
  Track
} from '../../src/renderer/src/types'

export interface Settings {
  seedanceApiKey: string
  seedanceBaseUrl: string
  seedanceModel: string
  seedanceTosRegion: string
  seedanceTosEndpoint: string
  seedanceTosBucket: string
  seedanceTosAccessKey: string
  seedanceTosSecretKey: string
  veoApiKey: string
  veoBaseUrl: string
  deepseekApiKey: string
  deepseekBaseUrl: string
  deepseekModel: string
  mediaDir: string
}

function userDataDir(): string {
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming')
  return join(appData, 'video-editor-app')
}

export function projectPath(): string {
  return process.env.VEDIT_PROJECT || join(userDataDir(), 'autosave.vedit.json')
}

export function settingsPath(): string {
  return join(userDataDir(), 'settings.json')
}

export function mediaOutputDir(): string {
  const s = loadSettings()
  const dir = s.mediaDir || join(userDataDir(), 'generated')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function audioCacheDir(): string {
  const dir = join(dirname(projectPath()), 'audio-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

const DEFAULT_TRACKS: Track[] = [
  { id: 'v2', kind: 'video', name: 'Vídeo 2' },
  { id: 'v1', kind: 'video', name: 'Vídeo 1' },
  { id: 'a1', kind: 'audio', name: 'Áudio 1' }
]

export function defaultProject(): ProjectData {
  return {
    version: 1,
    projectW: 1920,
    projectH: 1080,
    projectFps: 30,
    masterVolume: 1,
    media: [],
    tracks: [...DEFAULT_TRACKS],
    clips: []
  }
}

export function loadProject(): ProjectData {
  const p = projectPath()
  for (const candidate of [p, `${p}.bak`]) {
    if (!existsSync(candidate)) continue
    try {
      const data = JSON.parse(readFileSync(candidate, 'utf-8'))
      return { ...defaultProject(), ...data }
    } catch {
      /* try the backup */
    }
  }
  return defaultProject()
}

export function saveProject(project: ProjectData): void {
  const p = projectPath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  if (existsSync(p)) copyFileSync(p, `${p}.bak`)
  writeFileSync(tmp, JSON.stringify(project), 'utf-8')
  renameSync(tmp, p)
}

export function loadSettings(): Settings {
  const defaults: Settings = {
    seedanceApiKey: '',
    seedanceBaseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    seedanceModel: 'dreamina-seedance-2-0-260128',
    seedanceTosRegion: 'ap-southeast-1',
    seedanceTosEndpoint: 'tos-ap-southeast-1.bytepluses.com',
    seedanceTosBucket: '',
    seedanceTosAccessKey: '',
    seedanceTosSecretKey: '',
    veoApiKey: '',
    veoBaseUrl: 'https://generativelanguage.googleapis.com',
    deepseekApiKey: '',
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-chat',
    mediaDir: ''
  }
  try {
    const p = settingsPath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      const settings: Settings = { ...defaults, ...raw }
      if (
        raw.seedanceBaseUrl === 'https://ark.cn-beijing.volces.com/api/v3' &&
        raw.seedanceModel === 'doubao-seedance-2-0-260128'
      ) {
        settings.seedanceBaseUrl = defaults.seedanceBaseUrl
        settings.seedanceModel = defaults.seedanceModel
        if (raw.seedanceTosRegion === 'cn-beijing') settings.seedanceTosRegion = defaults.seedanceTosRegion
        if (raw.seedanceTosEndpoint === 'tos-cn-beijing.volces.com') {
          settings.seedanceTosEndpoint = defaults.seedanceTosEndpoint
        }
      }
      settings.seedanceTosAccessKey = decryptDpapi(settings.seedanceTosAccessKey)
      settings.seedanceTosSecretKey = decryptDpapi(settings.seedanceTosSecretKey)
      return settings
    }
  } catch {
    /* ignore */
  }
  return defaults
}

function decryptDpapi(value: string): string {
  if (!value?.startsWith('enc:')) return value || ''
  if (process.platform !== 'win32') return ''
  try {
    const script =
      '$bytes=[Convert]::FromBase64String($env:VEDIT_DPAPI);' +
      '$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,' +
      '[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
      '[Convert]::ToBase64String($plain)'
    const base64 = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, VEDIT_DPAPI: value.slice(4) }
      }
    ).trim()
    return Buffer.from(base64, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

let counter = 0
export function genId(): string {
  counter = (counter + 1) % 100000
  return (Date.now().toString(36) + counter.toString(36)).slice(-10)
}

export function trackOrder(project: ProjectData, trackId: string): number {
  const idx = project.tracks.findIndex((t) => t.id === trackId)
  return idx < 0 ? 0 : project.tracks.length - idx
}

export function durationOf(project: ProjectData): number {
  return project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)
}

export function baseClip(over: Partial<Clip>): Clip {
  return {
    id: genId(),
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
  }
}

export const DEFAULT_TEXT: TextConfig = {
  content: 'Texto',
  fontSizeRel: 0.09,
  color: '#ffffff',
  fontFamily: 'Segoe UI, sans-serif',
  bold: true,
  italic: false,
  align: 'center',
  bgColor: null,
  outline: true
}
