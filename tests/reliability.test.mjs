import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const ffmpeg = join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe')
const ffprobe = join(root, 'vendor', 'ffmpeg', 'ffprobe.exe')

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (data) => (stderr += data.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`))
    )
  })
}

function runStdout(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data.toString()))
    child.stderr.on('data', (data) => (stderr += data.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`))
    )
  })
}

function meanVolume(log) {
  const match = log.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  assert.ok(match, `mean volume was not reported: ${log.slice(-500)}`)
  return Number(match[1])
}

async function bundle(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node18' })
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

function baseClip(overrides) {
  return {
    id: 'clip',
    mediaPath: '',
    type: 'video',
    hasAudio: false,
    trackOrder: 1,
    start: 0,
    duration: 1,
    inPoint: 0,
    volume: 1,
    scale: 1,
    xFrac: 0,
    yFrac: 0,
    opacity: 1,
    fit: 'fill',
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    duck: false,
    ...overrides
  }
}

test('render, MCP parity and autosave recovery', async () => {
  assert.ok(existsSync(ffmpeg), 'bundled ffmpeg.exe is missing')
  assert.ok(existsSync(ffprobe), 'bundled ffprobe.exe is missing')

  const work = await mkdtemp(join(tmpdir(), 'vedit-reliability-'))
  process.env.FFMPEG_PATH = ffmpeg
  process.env.FFPROBE_PATH = ffprobe
  try {
    const engine = await bundle(join(root, 'src', 'main', 'ffmpeg.ts'), join(work, 'ffmpeg.mjs'))
    const audio = await bundle(join(root, 'src', 'shared', 'audio.ts'), join(work, 'audio.mjs'))
    assert.equal(audio.clipVolumeGain(1), 1)
    assert.ok(Math.abs(audio.clipVolumeGain(2) - Math.sqrt(10)) < 0.001, '200% must mean +10 dB')
    const missingProgress = []
    const missingResult = await engine.renderTimeline({
      outputPath: join(work, 'must-not-start.mp4'),
      width: 64,
      height: 64,
      fps: 10,
      duration: 1,
      clips: [baseClip({ mediaPath: join(work, 'missing-source.mp4') })]
    }, (progress) => missingProgress.push(progress))
    assert.equal(missingResult.ok, false)
    assert.match(missingResult.error, /renderização não começou/)
    assert.match(missingResult.error, /missing-source\.mp4/)
    assert.deepEqual(missingProgress, [], 'FFmpeg started before the missing-media check')
    assert.equal(existsSync(join(work, 'must-not-start.mp4')), false)

    const red = join(work, 'red.mp4')
    const blue = join(work, 'blue.mp4')
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red])
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue])

    const output = join(work, 'transition.mp4')
    const result = await engine.renderTimeline({
      outputPath: output,
      width: 64,
      height: 64,
      fps: 10,
      duration: 1.7,
      clips: [
        baseClip({ id: 'a', mediaPath: red }),
        baseClip({
          id: 'b',
          mediaPath: blue,
          start: 0.7,
          transition: { type: 'fade', duration: 0.3 }
        })
      ]
    }, () => {})
    assert.equal(result.ok, true, result.error)
    const meta = await engine.probeMedia(output)
    assert.equal(meta.width, 64)
    assert.equal(meta.height, 64)
    assert.ok(meta.duration > 1.5, `unexpected render duration: ${meta.duration}`)

    // NVIDIA/OBS-style recordings can contain separate game + microphone
    // streams. Chromium plays only the first one, so verify that preparation
    // combines both and that the render engine uses the combined proxy.
    const multiAudio = join(work, 'multi-audio.mp4')
    await run(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', multiAudio
    ])
    const prepared = await engine.prepareMedia(multiAudio, join(work, 'audio-cache'))
    assert.equal(prepared.audioStreamCount, 2)
    assert.ok(prepared.audioPath && existsSync(prepared.audioPath), 'combined audio proxy was not created')
    assert.equal(prepared.audioPaths?.length, 2)
    assert.ok(prepared.audioPaths.every((path) => existsSync(path)), 'individual audio proxies were not created')
    const preparedMeta = await engine.probeMedia(prepared.audioPath)
    assert.equal(preparedMeta.audioStreamCount, 1)
    const mixedVolume = await run(ffmpeg, ['-hide_banner', '-i', prepared.audioPath, '-af', 'volumedetect', '-f', 'null', '-'])
    assert.doesNotMatch(mixedVolume, /max_volume: -91\.0 dB/, 'combined audio is silent')
    const firstTrackVolume = await run(ffmpeg, ['-hide_banner', '-i', prepared.audioPaths[0], '-af', 'volumedetect', '-f', 'null', '-'])
    const secondTrackVolume = await run(ffmpeg, ['-hide_banner', '-i', prepared.audioPaths[1], '-af', 'volumedetect', '-f', 'null', '-'])
    assert.match(firstTrackVolume, /max_volume: -91\.0 dB/, 'first test track should remain silent')
    assert.doesNotMatch(secondTrackVolume, /max_volume: -91\.0 dB/, 'second test track lost its sound')

    const enhancedAudio = join(work, 'enhanced-audio.m4a')
    await engine.enhanceAudio(
      prepared.audioPath,
      0,
      1,
      {
        denoise: true,
        denoiseAmount: 0.3,
        normalize: true,
        voice: true,
        compressor: true,
        gainDb: 3,
        reverb: 0.3,
        delayMs: 180,
        delayMix: 0.25
      },
      enhancedAudio
    )
    const enhancedMeta = await engine.probeMedia(enhancedAudio)
    assert.equal(enhancedMeta.hasAudio, true)
    assert.ok(enhancedMeta.duration > 0.9, `unexpected enhanced audio duration: ${enhancedMeta.duration}`)

    // Worst-case denoise must not mistake a quiet, low-pitched voice for noise.
    const noisyVoice = join(work, 'noisy-voice.wav')
    await run(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.025:sample_rate=48000:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=180:sample_rate=48000:duration=2',
      '-filter_complex', '[1:a]volume=0.4,adelay=1000|1000[voice];[0:a][voice]amix=inputs=2:normalize=0[out]',
      '-map', '[out]', '-c:a', 'pcm_s16le', noisyVoice
    ])
    const denoisedVoice = join(work, 'denoised-voice.m4a')
    await engine.enhanceAudio(
      noisyVoice,
      0,
      3,
      {
        denoise: true,
        denoiseAmount: 1,
        normalize: false,
        voice: false,
        compressor: false,
        gainDb: 0,
        reverb: 0,
        delayMs: 250,
        delayMix: 0
      },
      denoisedVoice
    )
    const originalVoiceStats = await run(ffmpeg, ['-hide_banner', '-ss', '1', '-t', '1.8', '-i', noisyVoice, '-af', 'volumedetect', '-f', 'null', '-'])
    const denoisedVoiceStats = await run(ffmpeg, ['-hide_banner', '-ss', '1', '-t', '1.8', '-i', denoisedVoice, '-af', 'volumedetect', '-f', 'null', '-'])
    const originalNoiseStats = await run(ffmpeg, ['-hide_banner', '-ss', '0.1', '-t', '0.8', '-i', noisyVoice, '-af', 'volumedetect', '-f', 'null', '-'])
    const denoisedNoiseStats = await run(ffmpeg, ['-hide_banner', '-ss', '0.1', '-t', '0.8', '-i', denoisedVoice, '-af', 'volumedetect', '-f', 'null', '-'])
    assert.ok(
      meanVolume(denoisedNoiseStats) <= meanVolume(originalNoiseStats) - 1,
      'denoise did not measurably reduce the background-only section'
    )
    assert.ok(
      meanVolume(denoisedVoiceStats) >= meanVolume(originalVoiceStats) - 12.5,
      'denoise removed more than its voice-safe 12 dB ceiling'
    )

    // Codex-authored HyperFrames FX must render locally with a real alpha plane.
    const hyperframesCli = join(root, 'mcp', 'node_modules', 'hyperframes', 'dist', 'cli.js')
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    assert.ok(existsSync(hyperframesCli), 'HyperFrames CLI dependency is missing')
    assert.ok(existsSync(chrome), 'Chrome is required for local HyperFrames rendering')
    process.env.HYPERFRAMES_CLI = hyperframesCli
    process.env.HYPERFRAMES_OUTPUT_DIR = work
    process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg
    process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe
    process.env.HYPERFRAMES_BROWSER_PATH = chrome
    const hyperframes = await bundle(join(root, 'mcp', 'src', 'hyperframes.ts'), join(work, 'hyperframes.mjs'))
    const fxHtml = await readFile(join(root, 'mcp', 'test-fixtures', 'hyperframes-smoke', 'index.html'), 'utf8')
    const fx = await hyperframes.renderHyperframesFx({
      html: fxHtml,
      name: 'smoke-fx',
      transparent: true,
      fps: 10
    })
    const fxMeta = await engine.probeMedia(fx.outputPath)
    assert.equal(fxMeta.width, 320)
    assert.equal(fxMeta.height, 180)
    assert.ok(fxMeta.duration >= 0.9)
    const alphaProbe = JSON.parse(
      await runStdout(ffprobe, ['-v', 'error', '-show_entries', 'stream_tags=alpha_mode', '-of', 'json', fx.outputPath])
    )
    assert.equal(alphaProbe.streams?.[0]?.tags?.ALPHA_MODE, '1', 'HyperFrames WebM lost its alpha channel')

    const editorStore = await bundle(join(root, 'src', 'renderer', 'src', 'store.ts'), join(work, 'store.mjs'))
    editorStore.useEditor.setState({
      media: [{
        id: 'multi', name: 'multi.mp4', path: multiAudio, audioPath: prepared.audioPath,
        audioPaths: prepared.audioPaths, type: 'video', duration: 1, width: 64, height: 64,
        hasAudio: true, hasVideo: true, fps: 10
      }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'Video 1' },
        { id: 'a1', kind: 'audio', name: 'Audio 1' }
      ],
      clips: [{ ...baseClip({ id: 'video', mediaPath: undefined }), mediaId: 'multi', trackId: 'v1' }]
    })
    editorStore.useEditor.getState().detachAudio('video')
    const detachedState = editorStore.useEditor.getState()
    const detached = detachedState.clips.filter((clip) => clip.type === 'audio')
    assert.equal(detached.length, 2)
    assert.equal(new Set(detached.map((clip) => clip.trackId)).size, 2)
    assert.deepEqual(detached.map((clip) => clip.audioSourcePath), prepared.audioPaths)
    assert.ok(detached.every((clip) => clip.detachedFromClipId === 'video'))
    assert.equal(detachedState.clips.find((clip) => clip.id === 'video').volume, 0)
    editorStore.useEditor.getState().setDetachedAudioVolume('video', 0.25)
    const volumeState = editorStore.useEditor.getState()
    assert.equal(volumeState.clips.find((clip) => clip.id === 'video').volume, 0)
    assert.deepEqual(volumeState.clips.filter((clip) => clip.type === 'audio').map((clip) => clip.volume), [0.25, 0.25])

    const multiOutput = join(work, 'multi-audio-render.mp4')
    const multiResult = await engine.renderTimeline({
      outputPath: multiOutput,
      width: 64,
      height: 64,
      fps: 10,
      duration: 1,
      clips: [baseClip({ mediaPath: multiAudio, audioPath: prepared.audioPath, hasAudio: true })]
    }, () => {})
    assert.equal(multiResult.ok, true, multiResult.error)
    const renderedVolume = await run(ffmpeg, ['-hide_banner', '-i', multiOutput, '-af', 'volumedetect', '-f', 'null', '-'])
    assert.doesNotMatch(renderedVolume, /max_volume: -91\.0 dB/, 'export ignored the combined audio')

    // A heavily cut talking-head project must share its source decoders. The
    // previous one-input-per-cut design exhausted memory around 486 H.264 clips.
    const denseOutput = join(work, 'dense-cut-render.mp4')
    const denseClips = Array.from({ length: 486 }, (_, i) =>
      baseClip({
        id: `dense-${i}`,
        mediaPath: multiAudio,
        audioPath: prepared.audioPath,
        hasAudio: true,
        start: i * 0.25,
        duration: 0.1,
        inPoint: (i % 9) * 0.1
      })
    )
    const denseResult = await engine.renderTimeline({
      outputPath: denseOutput,
      width: 64,
      height: 64,
      fps: 10,
      duration: 121.35,
      clips: denseClips
    }, () => {})
    assert.equal(denseResult.ok, true, denseResult.error)
    const denseMeta = await engine.probeMedia(denseOutput)
    assert.equal(denseMeta.hasAudio, true)
    assert.equal(denseMeta.width, 64)
    assert.ok(Math.abs(denseMeta.duration - 121.35) < 0.25, `chunk join changed duration: ${denseMeta.duration}`)
    assert.ok(statSync(denseOutput).size < 5_000_000, 'chunk join produced an abnormally large file')
    const denseTailVolume = await run(ffmpeg, [
      '-hide_banner', '-ss', '121.2', '-t', '0.14', '-i', denseOutput,
      '-af', 'volumedetect', '-f', 'null', '-'
    ])
    assert.doesNotMatch(denseTailVolume, /max_volume: -91\.0 dB/, 'late cut audio was not positioned on the timeline')

    const impossibleSpace = await engine.renderTimeline({
      outputPath: join(work, 'too-large.mp4'),
      width: 7680,
      height: 4320,
      fps: 60,
      duration: 86400,
      clips: Array.from({ length: 61 }, (_, i) =>
        baseClip({ id: `space-${i}`, mediaPath: multiAudio, start: i, duration: 1 })
      )
    }, () => {})
    assert.equal(impossibleSpace.ok, false)
    assert.match(impossibleSpace.error, /Espaço insuficiente/)

    const mcpRender = await bundle(join(root, 'mcp', 'src', 'render.ts'), join(work, 'mcp-render.mjs'))
    const project = {
      version: 1,
      projectW: 64,
      projectH: 64,
      projectFps: 10,
      media: [],
      tracks: [{ id: 'v1', kind: 'video', name: 'Video', muted: true }],
      clips: [],
      markers: []
    }
    const mapped = mcpRender.commonRenderProps(project, {
      ...baseClip({ mediaPath: undefined }),
      mediaId: 'm1',
      trackId: 'v1',
      anim: { in: 'fade', inDur: 0.4 },
      mask: 'circle'
    })
    assert.equal(mapped.volume, 0)
    assert.deepEqual(mapped.anim, { in: 'fade', inDur: 0.4 })
    assert.equal(mapped.mask, 'circle')

    const projectPath = join(work, 'autosave.vedit.json')
    process.env.VEDIT_PROJECT = projectPath
    const mcpProject = await bundle(join(root, 'mcp', 'src', 'project.ts'), join(work, 'mcp-project.mjs'))
    mcpProject.saveProject({ ...mcpProject.defaultProject(), projectW: 100 })
    mcpProject.saveProject({ ...mcpProject.defaultProject(), projectW: 200 })
    assert.ok(existsSync(`${projectPath}.bak`), 'autosave backup was not created')
    await writeFile(projectPath, '{broken', 'utf8')
    assert.equal(mcpProject.loadProject().projectW, 100)
  } finally {
    delete process.env.VEDIT_PROJECT
    delete process.env.HYPERFRAMES_CLI
    delete process.env.HYPERFRAMES_OUTPUT_DIR
    delete process.env.HYPERFRAMES_FFMPEG_PATH
    delete process.env.HYPERFRAMES_FFPROBE_PATH
    delete process.env.HYPERFRAMES_BROWSER_PATH
    await rm(work, { recursive: true, force: true })
  }
})

test('Claude and Codex client configurations point to the shared MCP server', async () => {
  const claudeCode = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
  assert.equal(claudeCode.mcpServers['video-editor'].command, 'node')
  assert.match(claudeCode.mcpServers['video-editor'].args[0], /mcp[\\/]dist[\\/]index\.js$/)

  const codex = await readFile(join(root, '.codex', 'config.toml'), 'utf8')
  assert.match(codex, /\[mcp_servers\.video-editor\]/)
  assert.match(codex, /mcp\\dist\\index\.js|mcp\/dist\/index\.js/)

  const manifest = JSON.parse(await readFile(join(root, 'mcp', 'extension', 'manifest.json'), 'utf8'))
  const extensionPackage = JSON.parse(await readFile(join(root, 'mcp', 'extension', 'package.json'), 'utf8'))
  const serverPackage = JSON.parse(await readFile(join(root, 'mcp', 'package.json'), 'utf8'))
  assert.equal(manifest.server.entry_point, 'index.js')
  assert.equal(manifest.version, extensionPackage.version)
  assert.equal(manifest.version, serverPackage.version)
})
