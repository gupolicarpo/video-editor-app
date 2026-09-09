import { app, safeStorage } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, statSync } from 'fs'

// Keys encrypted at rest via Electron safeStorage (Windows DPAPI).
// seedance/veo/deepseek stay plaintext on purpose: the MCP server is a plain
// Node process and reads settings.json directly for those. TOS credentials are
// decrypted by the MCP with the same Windows DPAPI account.
const ENCRYPTED_FIELDS = [
  'seedanceTosAccessKey',
  'seedanceTosSecretKey',
  'lumaApiKey',
  'heygenApiKey',
  'openaiApiKey',
  'klingAccessKey',
  'klingSecretKey',
  'elevenApiKey'
] as const
const ENC_PREFIX = 'enc:'

function encryptField(value: string): string {
  try {
    if (value && !value.startsWith(ENC_PREFIX) && safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    /* fall through to plaintext */
  }
  return value
}

function decryptField(value: string): string {
  try {
    if (value && value.startsWith(ENC_PREFIX)) {
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
    }
  } catch {
    return '' // undecryptable (e.g. copied from another machine) → treat as unset
  }
  return value
}

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
  // DeepSeek (prompt enhancer)
  deepseekApiKey: string
  deepseekBaseUrl: string
  deepseekModel: string
  // Luma (Ray 3.2 video_edit / Modify — reference-guided video-to-video)
  lumaApiKey: string
  elevenApiKey: string
  lumaBaseUrl: string
  lumaModel: string
  // HeyGen (avatar / lip-sync talking head)
  heygenApiKey: string
  // OpenAI (gpt-image-2 — high-quality image edit/reference)
  openaiApiKey: string
  // Kling developer API (JWT: access key + secret) — for direct API calls (gap fill etc.)
  klingAccessKey: string
  klingSecretKey: string
  // AI Producer budget governance
  budgetTotalUsd: number
  budgetMode: 'observe' | 'warn' | 'cap'
  singleActionApprovalUsd: number
  // where AI-generated clips are saved
  mediaDir: string
}

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
  // Google Gemini API base for Veo.
  veoBaseUrl: 'https://generativelanguage.googleapis.com',
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-chat',
  lumaApiKey: '',
  elevenApiKey: '',
  lumaBaseUrl: 'https://agents.lumalabs.ai',
  lumaModel: 'ray-3.2',
  heygenApiKey: '',
  openaiApiKey: '',
  klingAccessKey: '',
  klingSecretKey: '',
  budgetTotalUsd: 10,
  budgetMode: 'warn',
  singleActionApprovalUsd: 0.5,
  mediaDir: ''
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  try {
    const p = settingsPath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      const merged: Settings = { ...defaults, ...raw }
      const legacyChinaDefaults =
        raw.seedanceBaseUrl === 'https://ark.cn-beijing.volces.com/api/v3' &&
        raw.seedanceModel === 'doubao-seedance-2-0-260128'
      if (legacyChinaDefaults) {
        merged.seedanceBaseUrl = defaults.seedanceBaseUrl
        merged.seedanceModel = defaults.seedanceModel
        if (raw.seedanceTosRegion === 'cn-beijing') merged.seedanceTosRegion = defaults.seedanceTosRegion
        if (raw.seedanceTosEndpoint === 'tos-cn-beijing.volces.com') {
          merged.seedanceTosEndpoint = defaults.seedanceTosEndpoint
        }
      }
      for (const f of ENCRYPTED_FIELDS) merged[f] = decryptField(merged[f])
      return merged
    }
  } catch {
    /* ignore, return defaults */
  }
  return { ...defaults }
}

export interface SaveReport {
  ok: boolean
  path: string
  error?: string
  wroteBytes?: number
}

/** Where settings live — surfaced in the UI so a failed save can't hide. */
export function settingsFilePath(): string {
  return settingsPath()
}

export function saveSettings(patch: Partial<Settings>): Settings {
  saveSettingsReport(patch)
  return { ...loadSettings(), ...patch }
}

/**
 * Same write, but it REPORTS. The old version returned the merged object whether
 * or not the file hit the disk, so the UI happily showed "saved" while nothing
 * was persisted — the exact bug that swallowed an API key for a week.
 */
export function saveSettingsReport(patch: Partial<Settings>): SaveReport {
  const p = settingsPath()
  try {
    const next = { ...loadSettings(), ...patch }
    const onDisk: Settings = { ...next }
    for (const f of ENCRYPTED_FIELDS) onDisk[f] = encryptField(onDisk[f])
    const json = JSON.stringify(onDisk, null, 2)
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // tmp + rename: a crash mid-write can't truncate the real file
    const tmp = `${p}.tmp`
    writeFileSync(tmp, json, 'utf-8')
    renameSync(tmp, p)
    const wrote = statSync(p).size
    // Read it back — the only proof that counts.
    const back = JSON.parse(readFileSync(p, 'utf-8'))
    const keys = Object.keys(patch)
    for (const k of keys) {
      if (!(k in back)) return { ok: false, path: p, error: `campo "${k}" não persistiu` }
    }
    return { ok: true, path: p, wroteBytes: wrote }
  } catch (e) {
    return { ok: false, path: p, error: (e as Error).message }
  }
}
