import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// Reuse the same engine the desktop app uses (no Electron deps in this module).
import { renderTimeline, type RenderClip, type RenderPayload } from '../../src/main/ffmpeg'
import { clipVolumeGain } from '../../src/shared/audio'
import type { Clip, ProjectData } from './project'
import { trackOrder, durationOf, genId } from './project'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

function escFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

// Render a text clip to a full-canvas transparent PNG using ffmpeg drawtext.
async function rasterizeText(clip: Clip, W: number, H: number): Promise<string> {
  const t = clip.text!
  const size = Math.max(8, Math.round(t.fontSizeRel * H))
  const fontFile = `C:/Windows/Fonts/${t.bold ? 'segoeuib' : 'segoeui'}.ttf`
  const txtPath = join(tmpdir(), `vedit-txt-${genId()}.txt`)
  writeFileSync(txtPath, t.content, 'utf-8')

  const xoff = Math.round(clip.xFrac * W)
  const yoff = Math.round(clip.yFrac * H)
  const color = t.color.replace('#', '0x')
  const parts = [
    `fontfile='${escFilterPath(fontFile)}'`,
    `textfile='${escFilterPath(txtPath)}'`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `x=(w-text_w)/2+${xoff}`,
    `y=(h-text_h)/2+${yoff}`,
    `line_spacing=${Math.round(size * 0.25)}`
  ]
  if (t.outline) parts.push(`borderw=${Math.max(1, Math.round(size * 0.08))}`, `bordercolor=black@0.85`)
  if (t.bgColor) parts.push(`box=1`, `boxcolor=${t.bgColor.replace('#', '0x')}@1`, `boxborderw=${Math.round(size * 0.3)}`)

  const out = join(tmpdir(), `vedit-txtpng-${genId()}.png`)
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=black@0:s=${W}x${H}:d=1`,
    '-vf', `drawtext=${parts.join(':')}`,
    '-frames:v', '1',
    out
  ]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG, args)
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800)))))
  })
  return out
}

export function commonRenderProps(project: ProjectData, c: Clip) {
  const anySolo = project.tracks.some((track) => track.solo)
  const track = project.tracks.find((item) => item.id === c.trackId)
  const silenced = !!track && (!!track.muted || (anySolo && !track.solo))
  return {
    id: c.id,
    trackOrder: trackOrder(project, c.trackId),
    start: c.start,
    duration: c.duration,
    inPoint: c.inPoint,
    volume: silenced ? 0 : clipVolumeGain(c.volume) * (project.masterVolume ?? 1),
    scale: c.scale,
    xFrac: c.xFrac,
    rotate: c.rotate ?? 0,
    yFrac: c.yFrac,
    opacity: c.opacity,
    fit: c.fit,
    speed: c.speed,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
    brightness: c.brightness,
    contrast: c.contrast,
    saturation: c.saturation,
    duck: c.duck,
    transition: c.transition,
    effects: c.effects,
    anim: c.anim,
    mask: c.mask
  }
}

export async function renderProject(
  project: ProjectData,
  outputPath: string,
  onProgress?: (p: number) => void
): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  const duration = durationOf(project)
  if (duration <= 0) return { ok: false, error: 'A timeline está vazia.' }

  const clips: RenderClip[] = []
  for (const c of project.clips) {
    const common = commonRenderProps(project, c)
    if (c.type === 'text') {
      try {
        const png = await rasterizeText(c, project.projectW, project.projectH)
        clips.push({ ...common, mediaPath: png, type: 'image', inPoint: 0, scale: 1, xFrac: 0, yFrac: 0, rotate: 0, fit: 'fill', hasAudio: false })
      } catch {
        /* skip text clip that failed to rasterize */
      }
    } else {
      const m = project.media.find((mm) => mm.id === c.mediaId)
      if (!m) continue
      clips.push({
        ...common,
        mediaPath: c.type === 'audio' ? c.audioSourcePath || m.audioPath || m.path : m.path,
        audioPath: c.type === 'video' ? m.audioPath : null,
        type: c.type,
        hasAudio: c.type === 'audio' ? true : c.type === 'video' ? m.hasAudio : false
      })
    }
  }

  const payload: RenderPayload = {
    outputPath,
    width: project.projectW,
    height: project.projectH,
    fps: project.projectFps,
    duration,
    clips
  }
  return renderTimeline(payload, (p) => onProgress?.(p.percent))
}
