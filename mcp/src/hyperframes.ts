import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { genId, mediaOutputDir } from './project'

export interface HyperframesFxOptions {
  html: string
  name: string
  transparent: boolean
  fps: number
}

function hyperframesCliPath(): string {
  if (process.env.HYPERFRAMES_CLI) return process.env.HYPERFRAMES_CLI
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'node_modules', 'hyperframes', 'dist', 'cli.js'),
    join(process.cwd(), 'mcp', 'node_modules', 'hyperframes', 'dist', 'cli.js')
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new Error('HyperFrames não está instalado. Rode: npm --prefix mcp install')
  return found
}

function hyperframesEnv(): NodeJS.ProcessEnv {
  const here = dirname(fileURLToPath(import.meta.url))
  const appRoot = join(here, '..', '..')
  const bundledFfmpeg = join(appRoot, 'vendor', 'ffmpeg', 'ffmpeg.exe')
  const bundledFfprobe = join(appRoot, 'vendor', 'ffmpeg', 'ffprobe.exe')
  const chromeCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
  ]
  return {
    ...process.env,
    NO_COLOR: '1',
    HYPERFRAMES_NO_TELEMETRY: '1',
    ...(process.env.HYPERFRAMES_FFMPEG_PATH
      ? {}
      : existsSync(bundledFfmpeg)
        ? { HYPERFRAMES_FFMPEG_PATH: bundledFfmpeg }
        : {}),
    ...(process.env.HYPERFRAMES_FFPROBE_PATH
      ? {}
      : existsSync(bundledFfprobe)
        ? { HYPERFRAMES_FFPROBE_PATH: bundledFfprobe }
        : {}),
    ...(process.env.HYPERFRAMES_BROWSER_PATH
      ? {}
      : { HYPERFRAMES_BROWSER_PATH: chromeCandidates.find((p) => p && existsSync(p)) || '' })
  }
}

export function renderHyperframesFx(opts: HyperframesFxOptions): Promise<{ outputPath: string; sourcePath: string }> {
  const id = genId()
  const safeName =
    opts.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'fx'
  const root = process.env.HYPERFRAMES_OUTPUT_DIR || mediaOutputDir()
  const workDir = join(root, 'hyperframes', id)
  mkdirSync(workDir, { recursive: true })
  const sourcePath = join(workDir, 'index.html')
  writeFileSync(sourcePath, opts.html, 'utf8')

  const format = opts.transparent ? 'webm' : 'mp4'
  const outputPath = join(root, `${safeName}-${id}.${format}`)
  const args = [
    hyperframesCliPath(),
    'render',
    `--output=${outputPath}`,
    `--format=${format}`,
    `--fps=${Math.max(1, Math.min(120, Math.round(opts.fps)))}`,
    '--quality=high',
    '--strict',
    '--quiet',
    '--workers=auto',
    workDir
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: workDir,
      windowsHide: true,
      env: hyperframesEnv()
    })
    let output = ''
    proc.stdout.on('data', (d) => (output += d.toString()))
    proc.stderr.on('data', (d) => (output += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) resolve({ outputPath, sourcePath })
      else reject(new Error(output.slice(-4000) || `HyperFrames saiu com código ${code}`))
    })
  })
}
