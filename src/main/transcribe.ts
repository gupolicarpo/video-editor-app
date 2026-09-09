import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'

// Local, offline transcription with word-level timestamps (faster-whisper).
// No API key, no upload — the audio never leaves the machine.
// Deliberately Electron-free so the MCP server can reuse it.

export interface Word {
  start: number
  end: number
  text: string
}

export interface Phrase {
  start: number
  end: number
  text: string
  words: Word[]
}

export interface Transcript {
  language: string
  duration: number
  words: Word[]
  phrases: Phrase[]
}

// Filler words to offer for removal, per language. Matched case-insensitively
// against the bare word (punctuation stripped).
const FILLERS: Record<string, string[]> = {
  en: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mmm', 'like', 'yknow'],
  pt: ['é', 'eh', 'ééé', 'hum', 'hmm', 'ahn', 'ahm', 'né', 'tipo', 'assim', 'aham']
}

const PY_SCRIPT = `
import sys, json
from faster_whisper import WhisperModel
audio, model_size, lang = sys.argv[1], sys.argv[2], sys.argv[3]
model = WhisperModel(model_size, device="cpu", compute_type="int8")
kwargs = dict(word_timestamps=True, vad_filter=True)
if lang and lang != "auto":
    kwargs["language"] = lang
segments, info = model.transcribe(audio, **kwargs)
words = []
for s in segments:
    for w in (s.words or []):
        words.append({"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()})
print(json.dumps({"language": info.language, "duration": info.duration, "words": words}))
`

function pythonBin(): string {
  // macOS/Linux ship `python3`; bare `python` is either missing or Python 2
  // there. Windows keeps `python`, which is what its installer registers.
  return process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3')
}

// Is Python + faster-whisper importable? Cached per process.
let availability: Promise<{ ok: boolean; error?: string }> | null = null
export function transcriptionAvailable(): Promise<{ ok: boolean; error?: string }> {
  if (availability) return availability
  availability = new Promise((resolve) => {
    const p = spawn(pythonBin(), ['-c', 'import faster_whisper'])
    p.on('error', () => resolve({ ok: false, error: 'Python não encontrado no PATH.' }))
    p.on('close', (code) =>
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: 'faster-whisper não instalado (pip install faster-whisper).' }
      )
    )
  })
  return availability
}

function cacheKey(mediaPath: string, model: string, lang: string): string {
  let mtime = 0
  try {
    mtime = statSync(mediaPath).mtimeMs
  } catch {
    /* ignore */
  }
  return createHash('sha1').update(`${mediaPath}|${mtime}|${model}|${lang}`).digest('hex').slice(0, 16)
}

// Group words into phrases, breaking on a silence gap. Mirrors video-use's
// pack_transcripts heuristic (MIT): a >=0.5s gap is a natural phrase boundary,
// which is also where a cut sounds clean.
export function groupPhrases(words: Word[], silenceThreshold = 0.5): Phrase[] {
  const phrases: Phrase[] = []
  let cur: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (cur.length > 0 && w.start - cur[cur.length - 1].end >= silenceThreshold) {
      phrases.push(toPhrase(cur))
      cur = []
    }
    cur.push(w)
  }
  if (cur.length) phrases.push(toPhrase(cur))
  return phrases
}

function toPhrase(words: Word[]): Phrase {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.text).join(' '),
    words
  }
}

export function isFiller(word: string, language: string): boolean {
  const bare = word.toLowerCase().replace(/[^\p{L}]/gu, '')
  if (!bare) return false
  const list = FILLERS[language] || FILLERS.en
  return list.includes(bare)
}

export async function transcribeMedia(
  mediaPath: string,
  cacheDir: string,
  opts: { model?: string; language?: string } = {}
): Promise<{ ok: boolean; transcript?: Transcript; error?: string }> {
  const avail = await transcriptionAvailable()
  if (!avail.ok) return { ok: false, error: avail.error }

  const model = opts.model || 'base'
  const lang = opts.language || 'auto'
  mkdirSync(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, `${cacheKey(mediaPath, model, lang)}.json`)
  if (existsSync(cachePath)) {
    try {
      return { ok: true, transcript: JSON.parse(readFileSync(cachePath, 'utf-8')) }
    } catch {
      /* stale cache → re-transcribe */
    }
  }

  const scriptPath = join(tmpdir(), `vedit-whisper-${Date.now()}.py`)
  writeFileSync(scriptPath, PY_SCRIPT, 'utf-8')
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const p = spawn(pythonBin(), [scriptPath, mediaPath, model, lang])
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d.toString()))
      p.stderr.on('data', (d) => (err += d.toString()))
      p.on('error', reject)
      p.on('close', (code) => (code === 0 && out.trim() ? resolve(out) : reject(new Error(err.slice(-600) || 'falhou'))))
    })
    const parsed = JSON.parse(raw.trim().split('\n').pop() as string) as {
      language: string
      duration: number
      words: Word[]
    }
    const transcript: Transcript = {
      language: parsed.language,
      duration: parsed.duration,
      words: parsed.words,
      phrases: groupPhrases(parsed.words)
    }
    writeFileSync(cachePath, JSON.stringify(transcript), 'utf-8')
    return { ok: true, transcript }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  } finally {
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath)
    } catch {
      /* ignore */
    }
  }
}

// Ranges of the SOURCE timeline worth cutting: filler words and long silences.
export interface DeadRange {
  start: number
  end: number
  reason: 'filler' | 'silence'
  text?: string
}

export function findDeadRanges(
  t: Transcript,
  opts: { removeFillers?: boolean; maxSilence?: number; pad?: number } = {}
): DeadRange[] {
  const removeFillers = opts.removeFillers ?? true
  const maxSilence = opts.maxSilence ?? 0.6 // gaps longer than this get trimmed
  const speechGuard = opts.pad ?? 0.12 // protect imprecise word boundaries
  const out: DeadRange[] = []

  if (removeFillers) {
    // Whisper word timestamps are estimates, so cutting a filler that touches
    // another word can remove part of that word. Only offer fillers surrounded
    // by real pauses, and place both cut points inside those pauses.
    for (let i = 1; i < t.words.length - 1; i++) {
      const prev = t.words[i - 1]
      const w = t.words[i]
      const next = t.words[i + 1]
      const gapBefore = w.start - prev.end
      const gapAfter = next.start - w.end
      if (isFiller(w.text, t.language) && gapBefore >= speechGuard && gapAfter >= speechGuard) {
        out.push({
          start: prev.end + speechGuard,
          end: next.start - speechGuard,
          reason: 'filler',
          text: w.text
        })
      }
    }
  }

  // Keep exactly `maxSilence` of a long gap, split evenly around both words.
  // The old implementation kept only 2 * pad (0.08s by default), which made
  // speech sound chopped even when the UI said 0.60s.
  for (let i = 1; i < t.words.length; i++) {
    const gap = t.words[i].start - t.words[i - 1].end
    if (gap > maxSilence) {
      const keepAtEachSide = maxSilence / 2
      out.push({
        start: t.words[i - 1].end + keepAtEachSide,
        end: t.words[i].start - keepAtEachSide,
        reason: 'silence'
      })
    }
  }

  // Merge overlaps and drop slivers.
  out.sort((a, b) => a.start - b.start)
  const merged: DeadRange[] = []
  for (const r of out) {
    if (r.end - r.start < 0.05) continue
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

// Build an SRT from words, chunked N words per caption (video-use style).
export function buildSrt(t: Transcript, wordsPerChunk = 2, uppercase = true, offset = 0): string {
  const fmt = (s: number): string => {
    const ms = Math.max(0, Math.round(s * 1000))
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
    const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
    const mil = String(ms % 1000).padStart(3, '0')
    return `${h}:${m}:${sec},${mil}`
  }
  const lines: string[] = []
  let n = 1
  for (let i = 0; i < t.words.length; i += wordsPerChunk) {
    const chunk = t.words.slice(i, i + wordsPerChunk)
    if (!chunk.length) break
    let text = chunk.map((w) => w.text).join(' ')
    if (uppercase) text = text.toUpperCase()
    lines.push(String(n++))
    lines.push(`${fmt(chunk[0].start + offset)} --> ${fmt(chunk[chunk.length - 1].end + offset)}`)
    lines.push(text)
    lines.push('')
  }
  return lines.join('\n')
}
