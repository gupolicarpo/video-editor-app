import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import type { Clip, TextConfig, TransitionType, Effect, EffectType, ClipAnim } from '../types'
import { fmtTime } from '../util'
import { TRANSITIONS } from '../transitions'
import { EFFECTS } from '../motion'
import { ANIM_IN, ANIM_LOOP, ANIM_OUT, ANIM_DIRS, inUsesDir, outUsesDir, matchOutFor, matchInFor } from '../animations'
import { KLING_TAIL_MODELS } from '../ai/kling-models'
import { MattePanel } from './MattePanel'
import { MASKS } from '../masks'

const FONTS = [
  'Segoe UI, sans-serif',
  'Arial, sans-serif',
  'Impact, sans-serif',
  'Georgia, serif',
  'Times New Roman, serif',
  'Courier New, monospace',
  'Verdana, sans-serif',
  'Trebuchet MS, sans-serif',
  'Comic Sans MS, cursive'
]

function Range({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}): JSX.Element {
  const commitThrottled = useEditor((s) => s.commitThrottled)
  return (
    <label className="insp-row-field">
      <span className="insp-row-label">{label}</span>
      <input
        className="insp-row-track"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onMouseDown={() => commitThrottled()}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="insp-row-value">{display}</span>
    </label>
  )
}

function MasterVolumeControl(): JSX.Element {
  const masterVolume = useEditor((s) => s.masterVolume)
  const setMasterVolume = useEditor((s) => s.setMasterVolume)
  return (
    <>
      <div className="insp-section">Áudio do projeto</div>
      <Range
        label="Volume mestre"
        value={masterVolume}
        min={0}
        max={2}
        step={0.01}
        display={`${Math.round(masterVolume * 100)}%`}
        onChange={setMasterVolume}
      />
      <p className="hint">Afeta todo o áudio no preview e na exportação.</p>
    </>
  )
}

export type InspTab = 'texto' | 'ajustar' | 'efeitos' | 'audio' | 'ia'

export function Inspector({
  requestTab
}: {
  // A one-shot jump from outside (the toolbar's Cor/Áudio mode buttons) — a
  // new nonce switches to `tab` once, then normal per-clip reset resumes.
  requestTab?: { tab: InspTab; nonce: number } | null
} = {}): JSX.Element {
  const clip = useEditor((s) => s.clips.find((c) => c.id === s.selectedClipId))
  const allClips = useEditor((s) => s.clips)
  const tracks = useEditor((s) => s.tracks)
  const media = useEditor((s) => s.media.find((m) => m.id === clip?.mediaId))
  const update = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const setTransition = useEditor((s) => s.setTransition)
  const addEffect = useEditor((s) => s.addEffect)
  const detachAudio = useEditor((s) => s.detachAudio)
  const setDetachedAudioVolume = useEditor((s) => s.setDetachedAudioVolume)
  const remove = useEditor((s) => s.removeClip)
  const inspectorRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<InspTab>('ajustar')

  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 })
    setTab(clip?.type === 'text' ? 'texto' : 'ajustar')
    // Only the clip identity should reset the tab — switching props of the
    // same clip (e.g. dragging a slider) must not yank the user back to tab 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id])

  useEffect(() => {
    if (requestTab) setTab(requestTab.tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestTab?.nonce])

  if (!clip) {
    return (
      <div className="inspector empty" ref={inspectorRef}>
        <h3>Inspetor</h3>
        <MasterVolumeControl />
        <p className="hint">Selecione um clipe na timeline para editar suas propriedades.</p>
      </div>
    )
  }

  const isText = clip.type === 'text'
  const isVisual = clip.type === 'video' || clip.type === 'image'
  const hasAudio = clip.type === 'audio' || (clip.type === 'video' && !!media?.hasAudio)
  const audioPreparing = clip.type === 'video' && !!media?.hasAudio && media.audioPaths === undefined
  const canSpeed = clip.type === 'video' || clip.type === 'audio'
  const maxFade = Math.max(0.1, Math.min(5, clip.duration))
  const detachedAudioClips =
    clip.type === 'video'
      ? allClips.filter(
          (c) =>
            c.type === 'audio' &&
            (c.detachedFromClipId === clip.id ||
              (!c.detachedFromClipId &&
                !!c.audioSourcePath &&
                c.mediaId === clip.mediaId &&
                Math.abs(c.start - clip.start) < 0.001 &&
                Math.abs(c.duration - clip.duration) < 0.001))
        )
      : []
  const displayedVolume = detachedAudioClips.length
    ? detachedAudioClips.reduce((sum, c) => sum + c.volume, 0) / detachedAudioClips.length
    : clip.volume

  const updateText = (patch: Partial<TextConfig>): void => {
    commit()
    update(clip.id, { text: { ...(clip.text as TextConfig), ...patch } })
  }
  const set = (patch: Partial<Clip>): void => update(clip.id, patch)

  // Which tabs this clip type actually has something to show in — a text
  // clip has no motion-effects section, an image has no audio tab, etc.
  // Same grouping FlexClip uses for its clip inspector: a short, fixed tab
  // bar instead of one long scroll through every feature at once.
  const tabs: Array<{ id: InspTab; label: string }> = []
  if (isText) tabs.push({ id: 'texto', label: 'Texto' })
  tabs.push({ id: 'ajustar', label: 'Ajustar' })
  if (isVisual || isText) tabs.push({ id: 'efeitos', label: 'Efeitos' })
  if (hasAudio) tabs.push({ id: 'audio', label: 'Áudio' })
  if (clip.type === 'video') tabs.push({ id: 'ia', label: 'IA' })
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id

  return (
    <div className="inspector" ref={inspectorRef}>
      <h3>Propriedades</h3>
      <div className="insp-name" title={media?.path}>
        {isText ? '📝 Texto' : clip.type === 'audio' ? `🔊 Áudio isolado · ${media?.name || 'Áudio'}` : media?.name || clip.type}
      </div>

      <div className="insp-row">
        <span>Início</span>
        <span>{fmtTime(clip.start)}</span>
      </div>
      <div className="insp-row">
        <span>Duração</span>
        <span>{fmtTime(clip.duration)}</span>
      </div>

      <div className="seg-tabs insp-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={activeTab === t.id ? 'seg on' : 'seg'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- TEXT ---- */}
      {activeTab === 'texto' && isText && clip.text && (
        <>
          <label className="field">
            Conteúdo
            <textarea
              rows={3}
              value={clip.text.content}
              onChange={(e) => updateText({ content: e.target.value })}
            />
          </label>
          <Range
            label="Tamanho"
            value={clip.text.fontSizeRel}
            min={0.02}
            max={0.3}
            step={0.005}
            display={`${Math.round(clip.text.fontSizeRel * 100)}`}
            onChange={(v) => set({ text: { ...clip.text!, fontSizeRel: v } })}
          />
          <div className="ai-row">
            <label className="field small">
              Cor
              <input type="color" value={clip.text.color} onChange={(e) => updateText({ color: e.target.value })} />
            </label>
            <label className="field small">
              Fundo
              <input
                type="color"
                value={clip.text.bgColor || '#000000'}
                onChange={(e) => updateText({ bgColor: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            Fonte
            <select value={clip.text.fontFamily} onChange={(e) => updateText({ fontFamily: e.target.value })}>
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f.split(',')[0]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Alinhamento do texto
            <select value={clip.text.align} onChange={(e) => updateText({ align: e.target.value as any })}>
              <option value="left">Esquerda</option>
              <option value="center">Centro</option>
              <option value="right">Direita</option>
            </select>
          </label>
          <div className="chk-row">
            <label>
              <input type="checkbox" checked={clip.text.bold} onChange={(e) => updateText({ bold: e.target.checked })} /> Negrito
            </label>
            <label>
              <input type="checkbox" checked={clip.text.italic} onChange={(e) => updateText({ italic: e.target.checked })} /> Itálico
            </label>
            <label>
              <input type="checkbox" checked={clip.text.outline} onChange={(e) => updateText({ outline: e.target.checked })} /> Contorno
            </label>
            <label>
              <input
                type="checkbox"
                checked={clip.text.bgColor !== null}
                onChange={(e) => updateText({ bgColor: e.target.checked ? '#000000' : null })}
              />{' '}
              Caixa
            </label>
          </div>
        </>
      )}

      {/* ---- AUDIO ---- */}
      {activeTab === 'audio' && hasAudio && (
        <>
          {/* Master volume affects the whole project, not just this clip — it
              used to live outside the per-clip view (still does, when nothing
              is selected) but was invisible the moment you selected a clip,
              which is exactly when you're most likely to reach for it. */}
          <MasterVolumeControl />
          <div className="insp-divider" />
          <Range
            label={
              clip.type === 'audio'
                ? 'Volume deste áudio'
                : detachedAudioClips.length
                  ? 'Volume das faixas deste vídeo'
                  : 'Volume deste vídeo'
            }
            value={displayedVolume}
            min={0}
            max={2}
            step={0.01}
            display={`${Math.round(displayedVolume * 100)}%`}
            onChange={(v) =>
              detachedAudioClips.length ? setDetachedAudioVolume(clip.id, v) : set({ volume: v })
            }
          />
          {clip.type === 'audio' && (
            <p className="hint">Este controle altera somente o clipe selecionado. Em 200%, ele sobe cerca de 10 dB (aproximadamente o dobro percebido).</p>
          )}
          {detachedAudioClips.length === 0 ? (
            <Range
              label="Pan (esquerda/direita)"
              value={clip.pan}
              min={-1}
              max={1}
              step={0.01}
              display={clip.pan === 0 ? 'centro' : clip.pan < 0 ? `${Math.round(-clip.pan * 100)}% E` : `${Math.round(clip.pan * 100)}% D`}
              onChange={(v) => set({ pan: v })}
            />
          ) : (
            <p className="hint">
              O áudio deste vídeo foi separado em faixas próprias — selecione Áudio 1/2 na timeline
              pra ajustar o pan de cada uma.
            </p>
          )}
          {(() => {
            // Silence is invisible — name the cause instead of leaving the user
            // to hunt. Three mutes exist: clip volume 0, its track muted, or any
            // other track in solo.
            const tr = tracks.find((t) => t.id === clip.trackId)
            const anySolo = tracks.some((t) => t.solo)
            const reasons: string[] = []
            if (displayedVolume === 0) reasons.push('volume do clipe está em 0')
            if (tr?.muted) reasons.push(`a faixa "${tr.name}" está mutada (M)`)
            if (anySolo && !tr?.solo) {
              const s2 = tracks.filter((t) => t.solo).map((t) => t.name).join(', ')
              reasons.push(`outra faixa está em Solo (${s2}) — só ela toca`)
            }
            return reasons.length ? (
              <p className="ai-error">🔇 Este clipe está SILENCIADO: {reasons.join('; ')}.</p>
            ) : null
          })()}
          {clip.type === 'video' && media?.hasAudio && detachedAudioClips.length === 0 && (
            <button className="btn btn-sec full" disabled={audioPreparing} onClick={() => detachAudio(clip.id)}>
              {audioPreparing
                ? 'Preparando faixas de áudio…'
                : media.audioPaths && media.audioPaths.length > 1
                  ? `🔉 Separar ${media.audioPaths.length} áudios (faixas próprias)`
                  : '🔉 Separar áudio (faixa própria)'}
            </button>
          )}
          {clip.type === 'video' && detachedAudioClips.length > 0 && (
            <p className="hint">Volume das faixas separadas deste vídeo. Selecione Áudio 1 ou Áudio 2 para ajustar individualmente.</p>
          )}
          {clip.type === 'audio' && (
            <label className="chk-single">
              <input type="checkbox" checked={clip.duck} onChange={(e) => { commit(); set({ duck: e.target.checked }) }} />{' '}
              Abaixar como música de fundo (ducking)
            </label>
          )}
          {clip.type === 'audio' && media && <AudioEnhancePanel clip={clip} mediaPath={clip.audioSourcePath || media.audioPath || media.path} />}
          {media && (
            <VoiceIsolatePanel
              clip={clip}
              mediaPath={clip.type === 'audio' ? clip.audioSourcePath || media.audioPath || media.path : media.path}
            />
          )}
          {/* Transcript-driven editing lives here rather than in IA: it works off
              the audio track and audio-only clips (no video/IA tab) need it too. */}
          {media && <TranscriptPanel clip={clip} mediaPath={clip.audioSourcePath || media.audioPath || media.path} />}
        </>
      )}

      {/* ---- FADES (all clips) ---- */}
      {activeTab === 'ajustar' && (
        <>
          <div className="insp-section">Fade (transição suave)</div>
          <Range
            label="Fade in"
            value={clip.fadeIn}
            min={0}
            max={maxFade}
            step={0.05}
            display={`${clip.fadeIn.toFixed(2)}s`}
            onChange={(v) => set({ fadeIn: v })}
          />
          <Range
            label="Fade out"
            value={clip.fadeOut}
            min={0}
            max={maxFade}
            step={0.05}
            display={`${clip.fadeOut.toFixed(2)}s`}
            onChange={(v) => set({ fadeOut: v })}
          />

          {/* ---- SPEED ---- */}
          {canSpeed && (
            <>
              <div className="insp-section">Velocidade</div>
              <Range
                label="Velocidade"
                value={clip.speed}
                min={0.25}
                max={4}
                step={0.05}
                display={`${clip.speed.toFixed(2)}×`}
                onChange={(v) => set({ speed: v })}
              />
            </>
          )}

          {/* ---- TRANSFORM (visual + text position) ---- */}
          {(isVisual || isText) && (
            <>
              <div className="insp-section">Posição{isVisual ? ' / Tamanho' : ''}</div>
              {isVisual && (
                <>
                  <p className="hint" style={{ marginTop: -4 }}>
                    Dica: arraste no preview e use as alças dos cantos para redimensionar.
                  </p>
                  <Range
                    label="Tamanho"
                    value={clip.scale}
                    min={0.05}
                    max={4}
                    step={0.01}
                    display={`${Math.round(clip.scale * 100)}%`}
                    onChange={(v) => set({ scale: v })}
                  />
                </>
              )}
              <Range label="Posição X" value={clip.xFrac} min={-1} max={1} step={0.01} display={`${Math.round(clip.xFrac * 100)}%`} onChange={(v) => set({ xFrac: v })} />
              <Range label="Posição Y" value={clip.yFrac} min={-1} max={1} step={0.01} display={`${Math.round(clip.yFrac * 100)}%`} onChange={(v) => set({ yFrac: v })} />
              <Range label="Opacidade" value={clip.opacity} min={0} max={1} step={0.01} display={`${Math.round(clip.opacity * 100)}%`} onChange={(v) => set({ opacity: v })} />
              <Range
                label="Girar"
                value={clip.rotate ?? 0}
                min={0}
                max={360}
                step={1}
                display={`${Math.round(clip.rotate ?? 0)}°`}
                onChange={(v) => set({ rotate: v })}
              />
              <div className="align-grid rot-grid">
                <button className="btn-mini" title="Girar 90° à esquerda" onClick={() => { commit(); set({ rotate: (((clip.rotate ?? 0) - 90) % 360 + 360) % 360 }) }}>↺ 90°</button>
                <button className="btn-mini" title="Girar 90° à direita" onClick={() => { commit(); set({ rotate: (((clip.rotate ?? 0) + 90) % 360) }) }}>↻ 90°</button>
                <button className="btn-mini" title="Virar de cabeça para baixo" onClick={() => { commit(); set({ rotate: (((clip.rotate ?? 0) + 180) % 360) }) }}>180°</button>
                <button className="btn-mini" title="Sem giro" onClick={() => { commit(); set({ rotate: 0 }) }} disabled={!(clip.rotate ?? 0)}>Zerar</button>
              </div>
              {isVisual && (
                <label className="field">
                  Preenchimento
                  <select value={clip.fit} onChange={(e) => { commit(); set({ fit: e.target.value as any }) }}>
                    <option value="contain">Conter (sem cortar)</option>
                    <option value="cover">Cobrir (preenche, corta)</option>
                    <option value="fill">Esticar</option>
                  </select>
                </label>
              )}
              {isVisual && (
                <label className="field">
                  Máscara (forma)
                  <select
                    value={clip.mask ?? 'none'}
                    onChange={(e) => { commit(); set({ mask: e.target.value as any }) }}
                  >
                    {MASKS.map((m) => (
                      <option key={m.shape} value={m.shape}>{m.label}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="align-grid">
                <button className="btn-mini" title="Esquerda" onClick={() => { commit(); set({ xFrac: (isVisual ? clip.scale : 0.5) / 2 - 0.5 }) }}>⬅</button>
                <button className="btn-mini" title="Centro H" onClick={() => { commit(); set({ xFrac: 0 }) }}>⬌</button>
                <button className="btn-mini" title="Direita" onClick={() => { commit(); set({ xFrac: 0.5 - (isVisual ? clip.scale : 0.5) / 2 }) }}>➡</button>
                <button className="btn-mini" title="Topo" onClick={() => { commit(); set({ yFrac: (isVisual ? clip.scale : 0.3) / 2 - 0.5 }) }}>⬆</button>
                <button className="btn-mini" title="Centro V" onClick={() => { commit(); set({ yFrac: 0 }) }}>⬍</button>
                <button className="btn-mini" title="Base" onClick={() => { commit(); set({ yFrac: 0.5 - (isVisual ? clip.scale : 0.3) / 2 }) }}>⬇</button>
              </div>
            </>
          )}

          {/* ---- COLOR (visual) ---- */}
          {isVisual && (
            <>
              <div className="insp-section">Cor</div>
              <Range label="Brilho" value={clip.brightness} min={-1} max={1} step={0.01} display={clip.brightness.toFixed(2)} onChange={(v) => set({ brightness: v })} />
              <Range label="Contraste" value={clip.contrast} min={0} max={2} step={0.01} display={clip.contrast.toFixed(2)} onChange={(v) => set({ contrast: v })} />
              <Range label="Saturação" value={clip.saturation} min={0} max={3} step={0.01} display={clip.saturation.toFixed(2)} onChange={(v) => set({ saturation: v })} />
              {clip.type === 'video' && media && <AutoGradeButton clip={clip} mediaPath={media.path} />}
              <button className="btn-mini full-mini" onClick={() => { commit(); set({ brightness: 0, contrast: 1, saturation: 1 }) }}>
                Redefinir cor
              </button>
            </>
          )}
        </>
      )}

      {/* ---- TRANSITION (incoming) ---- */}
      {activeTab === 'efeitos' && (isVisual || isText) && (
        <>
          <div className="insp-section">Transição de entrada</div>
          <p className="hint" style={{ marginTop: -4 }}>
            Mistura este clipe com o anterior na mesma faixa.
          </p>
          <label className="field">
            Efeito
            <select
              value={clip.transition?.type ?? 'none'}
              onChange={(e) =>
                setTransition(clip.id, e.target.value as TransitionType | 'none', clip.transition?.duration ?? 0.7)
              }
            >
              <option value="none">Nenhuma</option>
              {TRANSITIONS.map((tr) => (
                <option key={tr.value} value={tr.value}>
                  {tr.label}
                </option>
              ))}
            </select>
          </label>
          {clip.transition && (
            <Range
              label="Duração"
              value={clip.transition.duration}
              min={0.2}
              max={Math.min(2, clip.duration)}
              step={0.05}
              display={`${clip.transition.duration.toFixed(2)}s`}
              onChange={(v) => setTransition(clip.id, clip.transition!.type, v)}
            />
          )}
        </>
      )}

      {/* ---- MOTION EFFECTS (visual) ---- */}
      {activeTab === 'efeitos' && isVisual && (
        <>
          <div className="insp-section">🎬 Efeitos de movimento</div>
          <label className="field">
            Adicionar efeito
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addEffect(clip.id, e.target.value as EffectType)
              }}
            >
              <option value="">+ escolher…</option>
              {EFFECTS.map((ef) => (
                <option key={ef.type} value={ef.type}>
                  {ef.label}
                </option>
              ))}
            </select>
          </label>
          {(clip.effects || []).map((ef) => (
            <EffectRow key={ef.id} clip={clip} effect={ef} />
          ))}
        </>
      )}

      {/* ---- ELEMENT ANIMATION (in / loop / out) ---- */}
      {activeTab === 'efeitos' && (isVisual || isText) && <AnimSection clip={clip} />}

      {/* ---- IA / advanced tools (video only) ---- */}
      {activeTab === 'ia' && clip.type === 'video' && media && (
        <>
          <MattePanel clip={clip} mediaPath={media.path} />
          <EnhancePanel clip={clip} mediaPath={media.path} />
          <GapFillPanel clip={clip} />
        </>
      )}

      <button className="btn danger full insp-delete" onClick={() => remove(clip.id)}>
        Excluir clipe
      </button>
    </div>
  )
}

function EnhancePanel({ clip, mediaPath }: { clip: Clip; mediaPath: string }): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const updateClip = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const [strength, setStrength] = useState<'leve' | 'medio' | 'forte'>('medio')
  const [upscale, setUpscale] = useState(true)
  const [warm, setWarm] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lookBusy, setLookBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState('')

  useEffect(() => window.api.onEnhanceProgress((p) => setPct(Math.round(p))), [])
  useEffect(() => window.api.onLookProgress((p) => setPct(Math.round(p))), [])

  async function applyLook(): Promise<void> {
    setErr('')
    setLookBusy(true)
    setPct(0)
    try {
      const res = await window.api.applyLook({ path: mediaPath, inPoint: clip.inPoint, duration: clip.duration })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        const id = nanoid(8)
        addMedia({
          id,
          name: res.mediaPath.split(/[\\/]/).pop() || 'look.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        commit()
        updateClip(clip.id, { mediaId: id, inPoint: 0, duration: meta.duration })
      } else {
        setErr(res.error || 'Falha ao aplicar o look.')
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setLookBusy(false)
    }
  }

  async function apply(): Promise<void> {
    setErr('')
    setBusy(true)
    setPct(0)
    try {
      const res = await window.api.enhanceClip({
        path: mediaPath,
        inPoint: clip.inPoint,
        duration: clip.duration,
        strength,
        upscale,
        warm
      })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        const id = nanoid(8)
        addMedia({
          id,
          name: res.mediaPath.split(/[\\/]/).pop() || 'enhanced.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        commit()
        updateClip(clip.id, { mediaId: id, inPoint: 0, duration: meta.duration })
      } else {
        setErr(res.error || 'Falha ao melhorar.')
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="insp-section">✨ Melhorar imagem</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Reduz ruído, ajusta cor e aumenta a nitidez — ideal para vídeo de webcam.
      </p>
      <label className="field">
        Intensidade
        <select value={strength} onChange={(e) => setStrength(e.target.value as any)}>
          <option value="leve">Leve</option>
          <option value="medio">Média</option>
          <option value="forte">Forte</option>
        </select>
      </label>
      <label className="chk-single">
        <input type="checkbox" checked={upscale} onChange={(e) => setUpscale(e.target.checked)} /> Aumentar para 1080p
      </label>
      <label className="chk-single">
        <input type="checkbox" checked={warm} onChange={(e) => setWarm(e.target.checked)} /> Tom de pele mais quente
      </label>
      <button className="btn btn-primary full" onClick={apply} disabled={busy || lookBusy}>
        {busy ? `Processando… ${pct}%` : '✨ Aplicar melhoria'}
      </button>

      <div className="insp-section">🎬 Look de Referência</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Aplica o grade cinematográfico (pele natural, pretos neutros, fundo elegante) calibrado pela imagem de
        referência. Melhor no vídeo cru. Inclui clarity + upscale 1080p.
      </p>
      <button className="btn full" onClick={applyLook} disabled={busy || lookBusy}>
        {lookBusy ? `Aplicando look… ${pct}%` : '🎬 Aplicar look de referência'}
      </button>

      {err && <div className="ai-error">{err}</div>}
    </>
  )
}

interface TWord {
  start: number
  end: number
  text: string
}
interface TPhrase {
  start: number
  end: number
  text: string
  words: TWord[]
}
interface TranscriptT {
  language: string
  duration: number
  words: TWord[]
  phrases: TPhrase[]
}
interface DeadRange {
  start: number
  end: number
  reason: 'filler' | 'silence'
  text?: string
}

// Transcript-driven editing: transcribe locally (faster-whisper — nothing is
// uploaded), then cut filler words and dead air straight off the transcript.
function TranscriptPanel({ clip, mediaPath }: { clip: Clip; mediaPath: string }): JSX.Element {
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const cutSourceRanges = useEditor((s) => s.cutSourceRanges)
  const [avail, setAvail] = useState<{ ok: boolean; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [t, setT] = useState<TranscriptT | null>(null)
  const [dead, setDead] = useState<DeadRange[]>([])
  const [removeFillers, setRemoveFillers] = useState(true)
  const [maxSilence, setMaxSilence] = useState(0.6)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.api.transcriptionAvailable().then(setAvail)
  }, [])
  // A different clip/source invalidates the shown transcript.
  useEffect(() => {
    setT(null)
    setDead([])
    setErr('')
  }, [clip.id, mediaPath])

  async function run(): Promise<void> {
    setErr('')
    setBusy(true)
    try {
      const res = await window.api.transcribeMedia({
        path: mediaPath,
        deadOpts: { removeFillers, maxSilence }
      })
      if (res.ok) {
        setT(res.transcript)
        setDead(res.dead)
      } else setErr(res.error || 'Falha ao transcrever.')
    } finally {
      setBusy(false)
    }
  }

  // Only the dead ranges that fall inside this clip's trimmed source window.
  const srcStart = clip.inPoint
  const srcEnd = clip.inPoint + clip.duration * clip.speed
  const inWindow = dead.filter((d) => d.end > srcStart && d.start < srcEnd)
  const cuttable = inWindow.reduce((a, d) => a + (Math.min(d.end, srcEnd) - Math.max(d.start, srcStart)), 0)
  const fillers = inWindow.filter((d) => d.reason === 'filler').length
  const silences = inWindow.filter((d) => d.reason === 'silence').length

  // Source time → timeline time, so clicking a phrase moves the playhead.
  const toTimeline = (srcT: number): number => clip.start + (srcT - clip.inPoint) / clip.speed

  return (
    <>
      <div className="insp-section">📝 Transcrição & corte por texto</div>
      {avail && !avail.ok ? (
        <p className="hint">⚠️ {avail.error} A transcrição roda local (faster-whisper), sem enviar seu áudio.</p>
      ) : (
        <>
          {!t && (
            <p className="hint" style={{ marginTop: -4 }}>
              Transcreve local e offline (nada sai da sua máquina) e mostra onde estão os vícios de
              linguagem e o silêncio morto.
            </p>
          )}
          <button className="btn btn-sec full" onClick={run} disabled={busy}>
            {busy ? 'Transcrevendo…' : t ? '↻ Retranscrever' : '📝 Transcrever'}
          </button>

          {t && (
            <>
              <div className="insp-row">
                <span>Idioma / palavras</span>
                <span>
                  {t.language} · {t.words.length}
                </span>
              </div>

              <label className="chk-single">
                <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} />{' '}
                Remover vícios de linguagem ("é", "hum", "uh"…)
              </label>
              <Range
                label="Silêncio máximo tolerado"
                value={maxSilence}
                min={0.2}
                max={2}
                step={0.05}
                display={`${maxSilence.toFixed(2)}s`}
                onChange={setMaxSilence}
              />
              <button className="btn-mini full-mini" onClick={run} disabled={busy}>
                Recalcular cortes
              </button>

              <div className="insp-row">
                <span>Cortável</span>
                <span>
                  {cuttable.toFixed(1)}s ({fillers} vícios, {silences} silêncios)
                </span>
              </div>
              <button
                className="btn btn-primary full"
                disabled={cuttable < 0.05}
                onClick={() => {
                  const removed = cutSourceRanges(clip.id, inWindow)
                  if (removed > 0) setErr('')
                }}
                title="Corta os trechos mortos e fecha os buracos"
              >
                ✂ Remover {cuttable.toFixed(1)}s de tempo morto
              </button>
              <button
                className="btn-mini full-mini"
                onClick={() => window.api.saveSrt({ transcript: t, offset: clip.start - clip.inPoint })}
              >
                💬 Exportar legendas (.srt)
              </button>

              <div className="transcript-box">
                {t.phrases.map((p, i) => {
                  const outside = p.end <= srcStart || p.start >= srcEnd
                  return (
                    <div
                      key={i}
                      className={`transcript-phrase ${outside ? 'outside' : ''}`}
                      title={`${p.start.toFixed(2)}s — clique para ir`}
                      onClick={() => setPlayhead(Math.max(0, toTimeline(p.start)))}
                    >
                      <span className="tp-time">{p.start.toFixed(1)}s</span>{' '}
                      {p.words.map((w, j) => (
                        <span key={j} className={isFillerWord(w.text, t.language) ? 'tp-filler' : undefined}>
                          {w.text}{' '}
                        </span>
                      ))}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {err && <div className="ai-error">{err}</div>}
        </>
      )}
    </>
  )
}

const FILLER_WORDS: Record<string, string[]> = {
  en: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mmm', 'like', 'yknow'],
  pt: ['é', 'eh', 'ééé', 'hum', 'hmm', 'ahn', 'ahm', 'né', 'tipo', 'assim', 'aham']
}
function isFillerWord(word: string, language: string): boolean {
  const bare = word.toLowerCase().replace(/[^\p{L}]/gu, '')
  if (!bare) return false
  return (FILLER_WORDS[language] || FILLER_WORDS.en).includes(bare)
}

// Measures the clip (ffmpeg signalstats) and applies a bounded correction.
// Non-destructive: it just sets brightness/contrast/saturation, so it shows up
// in the preview immediately and is undoable.
function AutoGradeButton({ clip, mediaPath }: { clip: Clip; mediaPath: string }): JSX.Element {
  const update = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState('')

  async function run(): Promise<void> {
    setBusy(true)
    setInfo('')
    try {
      const g = await window.api.autoGrade({ path: mediaPath, inPoint: clip.inPoint, duration: clip.duration })
      if (g.ok) {
        commit()
        update(clip.id, { brightness: g.brightness, contrast: g.contrast, saturation: g.saturation })
        const exp = g.stats.yMean < 0.42 ? 'escuro' : g.stats.yMean > 0.6 ? 'claro' : 'ok'
        setInfo(`luz ${Math.round(g.stats.yMean * 100)}% (${exp}) · contraste ${Math.round(g.stats.yRange * 100)}%`)
      } else {
        setInfo(g.error || 'Falha ao medir.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-mini full-mini" onClick={run} disabled={busy} title="Mede o clipe e corrige exposição/contraste com ajuste sutil (±8%)">
        {busy ? 'Medindo…' : '🎯 Auto-corrigir cor'}
      </button>
      {info && <p className="hint" style={{ marginTop: 2 }}>{info}</p>}
    </>
  )
}

function GapFillPanel({ clip }: { clip: Clip }): JSX.Element {
  const clips = useEditor((s) => s.clips)
  const media = useEditor((s) => s.media)
  const addMedia = useEditor((s) => s.addMedia)
  const addClip = useEditor((s) => s.addClip)
  const updateClip = useEditor((s) => s.updateClip)
  const [provider, setProvider] = useState<'kling' | 'seedance'>('kling')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => window.api.onAiProgress((p) => setStatus(p.message)), [])

  // Previous clip on the same track (the one whose end is just before this clip).
  const prev = clips
    .filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start + c.duration <= clip.start + 0.05)
    .sort((a, b) => b.start + b.duration - (a.start + a.duration))[0]
  const prevEnd = prev ? prev.start + prev.duration : 0
  const gap = prev ? +(clip.start - prevEnd).toFixed(2) : 0
  const prevMedia = prev ? media.find((m) => m.id === prev.mediaId) : undefined
  const thisMedia = media.find((m) => m.id === clip.mediaId)
  const canFill = !!(prev && prevMedia?.hasVideo && thisMedia?.hasVideo && gap >= 0.5)

  async function run(): Promise<void> {
    setErr('')
    if (!canFill || !prev || !prevMedia || !thisMedia) {
      setErr('Deixe um espaço (≥0,5s) entre este clipe e um clipe de vídeo anterior na mesma faixa.')
      return
    }
    const durationSec = Math.max(1, Math.round(gap))
    const estimatedUsd = provider === 'seedance' ? +(0.25 * durationSec).toFixed(2) : 0
    let reserve = await window.api.budgetReserve({ tool: `gapfill:${provider}`, operation: 'gap_fill', estimatedUsd })
    if (reserve.needApproval) {
      if (!confirm(`${reserve.reason}\n\nProsseguir?`)) return
      reserve = await window.api.budgetReserve({ tool: `gapfill:${provider}`, operation: 'gap_fill', estimatedUsd, approved: true })
    }
    if (!reserve.ok) {
      setErr(reserve.reason || 'Bloqueado pelo orçamento.')
      return
    }
    setBusy(true)
    setStatus('Iniciando…')
    try {
      const res = await window.api.gapFill({
        aPath: prevMedia.path,
        aTime: prev.inPoint + prev.duration - 0.05,
        bPath: thisMedia.path,
        bTime: clip.inPoint,
        prompt,
        provider,
        model: model || undefined,
        durationSec
      })
      await window.api.budgetReconcile({ entryId: reserve.entryId, actualUsd: estimatedUsd, success: !!res.ok })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        const id = nanoid(8)
        addMedia({
          id,
          name: res.mediaPath.split(/[\\/]/).pop() || 'gapfill.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        addClip(id, clip.trackId, prevEnd)
        const newId = useEditor.getState().selectedClipId
        if (newId) updateClip(newId, { duration: gap, inPoint: 0 })
        setStatus('✅ Trecho gerado e encaixado no buraco.')
      } else {
        setErr(res.error || 'Falha ao preencher o corte.')
        setStatus('')
      }
    } catch (e: any) {
      await window.api.budgetReconcile({ entryId: reserve.entryId, actualUsd: 0, success: false })
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="insp-section">🪄 Preencher corte com IA</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Gera o trecho que falta entre o clipe anterior e este, usando o último frame de um e o primeiro do outro.
      </p>
      {!canFill ? (
        <p className="hint">
          {prev
            ? `Buraco atual: ${gap.toFixed(2)}s — precisa de ≥0,5s entre dois clipes de vídeo.`
            : 'Coloque este clipe depois de outro clipe de vídeo (na mesma faixa), com um espaço entre eles.'}
        </p>
      ) : (
        <>
          <div className="insp-row">
            <span>Buraco a preencher</span>
            <span>{gap.toFixed(2)}s</span>
          </div>
          <div className="provider-switch">
            <button className={provider === 'kling' ? 'seg active' : 'seg'} onClick={() => { setProvider('kling'); setModel('') }}>
              Kling (rosto ✓, API paga)
            </button>
            <button className={provider === 'seedance' ? 'seg active' : 'seg'} onClick={() => { setProvider('seedance'); setModel('') }}>
              Seedance (API paga)
            </button>
          </div>
          {provider === 'kling' ? (
            <label className="field small">
              Modelo (aceitam last-frame)
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">— escolher —</option>
                {KLING_TAIL_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field small">
              Modelo (livre)
              <input
                value={model}
                placeholder="dreamina-seedance-2-0-260128"
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <textarea
              rows={2}
              value={prompt}
              placeholder="Descreva a transição (ex: a câmera continua o movimento suavemente)…"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <button className="btn btn-primary full" onClick={run} disabled={busy}>
            {busy ? 'Processando…' : `🪄 Preencher (${provider === 'kling' ? 'Kling' : 'Seedance'})`}
          </button>
          {status && <div className="ai-status">{status}</div>}
          {err && <div className="ai-error">{err}</div>}
        </>
      )}
    </>
  )
}

function VoiceIsolatePanel({ clip, mediaPath }: { clip: Clip; mediaPath: string }): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const updateClip = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  const [saldo, setSaldo] = useState<number | null>(null)
  const [semChave, setSemChave] = useState(false)

  // ElevenLabs charges 1000 credits per minute; hard limits are 500MB / 1h.
  const custo = Math.max(1, Math.ceil((clip.duration / 60) * 1000))
  const longoDemais = clip.duration > 3600

  const lerSaldo = (): void => {
    void window.api.elevenBalance().then((b) => {
      setSemChave(!b.ok && /sem chave/i.test(b.error || ''))
      setSaldo(b.ok ? (b.remaining ?? null) : null)
      if (!b.ok && !/sem chave/i.test(b.error || '')) setErr(`Não consegui ler seu saldo: ${b.error}`)
    })
  }
  useEffect(lerSaldo, [])

  async function run(): Promise<void> {
    setErr('')
    setDone('')
    setBusy('Enviando o áudio ao ElevenLabs…')
    try {
      const res = await window.api.elevenIsolate({
        path: mediaPath,
        inPoint: clip.inPoint,
        duration: clip.duration,
        isVideo: clip.type === 'video'
      })
      if (!res.ok || !res.mediaPath) {
        setErr(res.error || 'Falhou sem mensagem — verifique sua conexão e a chave.')
        return
      }
      setBusy('Recolocando o áudio limpo no clipe…')
      const meta = await window.api.probe(res.mediaPath)
      const id = nanoid(8)
      addMedia({
        id,
        name: res.mediaPath.split(/[\/]/).pop() || 'isolado',
        path: res.mediaPath,
        type: meta.type,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        hasAudio: meta.hasAudio,
        hasVideo: meta.hasVideo,
        fps: meta.fps
      })
      commit()
      // A detached-audio clip plays from `audioSourcePath` (preview line ~415 and
      // the export payload both prefer it over the media), so swapping mediaId
      // alone left the ORIGINAL noisy file playing while the clean one sat unused
      // on disk. Clear it so the new media is the only source.
      updateClip(clip.id, {
        mediaId: id,
        inPoint: 0,
        audioSourcePath: undefined
      })
      setDone('✓ Voz isolada — o clipe já usa o áudio limpo (Ctrl+Z desfaz).')
      lerSaldo()
    } catch (e) {
      setErr(`Erro inesperado: ${(e as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <div className="insp-section">🎧 Remover ruído (ElevenLabs)</div>
      {semChave ? (
        <p className="ai-error">
          ⚠ Falta a chave do ElevenLabs. Abra <b>⚙ Configurações</b> → seção <b>ElevenLabs</b> e cole
          sua API key (elevenlabs.io → My Account → API Keys).
        </p>
      ) : (
        <>
          <button
            className="btn full"
            onClick={run}
            disabled={!!busy || longoDemais || (saldo !== null && saldo < custo)}
          >
            {busy ? '⏳ ' + busy : `🎧 Isolar voz (${clip.duration.toFixed(0)}s ≈ ${custo.toLocaleString('pt-BR')} créditos)`}
          </button>
          {saldo !== null && (
            <p className="hint">
              Sua conta: <b>{saldo.toLocaleString('pt-BR')}</b> créditos
              {saldo < custo
                ? ' — insuficiente para este clipe.'
                : ` · sobram ${(saldo - custo).toLocaleString('pt-BR')} depois deste.`}
            </p>
          )}
          {longoDemais && <p className="ai-error">Clipe acima de 1 hora — o limite do ElevenLabs. Corte antes.</p>}
        </>
      )}
      {done && <p className="ok">{done}</p>}
      {err && <p className="ai-error">{err}</p>}
    </>
  )
}

function AudioEnhancePanel({ clip, mediaPath }: { clip: Clip; mediaPath: string }): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const updateClip = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const [denoise, setDenoise] = useState(true)
  const [denoiseAmount, setDenoiseAmount] = useState(25)
  const [normalize, setNormalize] = useState(false)
  const [voice, setVoice] = useState(false)
  const [compressor, setCompressor] = useState(false)
  const [gainDb, setGainDb] = useState(0)
  const [reverbEnabled, setReverbEnabled] = useState(false)
  const [reverb, setReverb] = useState(25)
  const [delayEnabled, setDelayEnabled] = useState(false)
  const [delayMs, setDelayMs] = useState(250)
  const [delayMix, setDelayMix] = useState(25)
  const [channels, setChannels] = useState<'original' | 'mono' | 'stereo'>('original')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function apply(): Promise<void> {
    setErr('')
    setBusy(true)
    try {
      const res = await window.api.enhanceAudio({
        path: mediaPath,
        inPoint: clip.inPoint,
        duration: clip.duration,
        denoise,
        denoiseAmount: denoiseAmount / 100,
        normalize,
        voice,
        compressor,
        gainDb,
        reverb: reverbEnabled ? reverb / 100 : 0,
        delayMs,
        delayMix: delayEnabled ? delayMix / 100 : 0,
        channels
      })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        const id = nanoid(8)
        addMedia({
          id,
          name: res.mediaPath.split(/[\\/]/).pop() || 'audio.m4a',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        commit()
        updateClip(clip.id, { mediaId: id, inPoint: 0, duration: meta.duration })
      } else {
        setErr(res.error || 'Falha ao melhorar o áudio.')
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="insp-section">🎚 Ferramentas de áudio</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Corrige e estiliza o áudio sem precisar abrir outro aplicativo.
      </p>
      <label className="chk-single">
        <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} /> Remover ruído de fundo
      </label>
      {denoise && (
        <>
          <label className="field">
            Intensidade da redução <b>{denoiseAmount}%</b>
            <input
              type="range"
              min={5}
              max={100}
              step={1}
              value={denoiseAmount}
              onChange={(e) => setDenoiseAmount(Number(e.target.value))}
            />
          </label>
          <p className="hint" style={{ marginTop: -6 }}>
            Comece em 25%. Mesmo em 100%, a redução é limitada para preservar a voz.
          </p>
        </>
      )}
      <label className="field">
        Canais
        <select value={channels} onChange={(e) => setChannels(e.target.value as typeof channels)}>
          <option value="original">Original (não mexe)</option>
          <option value="mono">Forçar mono</option>
          <option value="stereo">Forçar estéreo</option>
        </select>
      </label>
      <label className="chk-single">
        <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> Normalizar volume
        (broadcast)
      </label>
      <label className="chk-single">
        <input type="checkbox" checked={compressor} onChange={(e) => setCompressor(e.target.checked)} /> Compressor
        (equilibra partes altas e baixas)
      </label>
      <label className="chk-single">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Realçar voz (corte de
        graves/agudos)
      </label>
      <label className="field">
        Amplificar / ganho <b>{gainDb > 0 ? '+' : ''}{gainDb.toFixed(1)} dB</b>
        <input type="range" min={-12} max={12} step={0.5} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value))} />
      </label>
      <label className="chk-single">
        <input type="checkbox" checked={reverbEnabled} onChange={(e) => setReverbEnabled(e.target.checked)} /> Reverb
        (ambiente)
      </label>
      {reverbEnabled && (
        <label className="field">
          Intensidade do reverb <b>{reverb}%</b>
          <input type="range" min={5} max={100} step={1} value={reverb} onChange={(e) => setReverb(Number(e.target.value))} />
        </label>
      )}
      <label className="chk-single">
        <input type="checkbox" checked={delayEnabled} onChange={(e) => setDelayEnabled(e.target.checked)} /> Delay
        (eco)
      </label>
      {delayEnabled && (
        <>
          <label className="field">
            Tempo do delay <b>{delayMs} ms</b>
            <input type="range" min={50} max={1000} step={10} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))} />
          </label>
          <label className="field">
            Intensidade do eco <b>{delayMix}%</b>
            <input type="range" min={5} max={100} step={1} value={delayMix} onChange={(e) => setDelayMix(Number(e.target.value))} />
          </label>
        </>
      )}
      <button className="btn btn-primary full" onClick={apply} disabled={busy}>
        {busy ? 'Processando…' : '🎚 Aplicar ferramentas'}
      </button>
      <p className="hint">O original não é apagado. Se não gostar do resultado, use Ctrl+Z.</p>
      {err && <div className="ai-error">{err}</div>}
    </>
  )
}

function AnimSection({ clip }: { clip: Clip }): JSX.Element {
  const update = useEditor((s) => s.updateClip)
  const commit = useEditor((s) => s.commit)
  const a = clip.anim || {}
  const setAnim = (patch: Partial<ClipAnim>): void => {
    commit()
    update(clip.id, { anim: { ...a, ...patch } })
  }
  const maxDur = Math.max(0.1, Math.min(4, clip.duration))
  return (
    <>
      <div className="insp-section">✨ Animação do elemento</div>
      <label className="field">
        Entrada
        <select value={a.in || 'none'} onChange={(e) => setAnim({ in: e.target.value as ClipAnim['in'] })}>
          {ANIM_IN.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {inUsesDir(a.in) && (
        <div className="anim-dir">
          <span className="anim-dir-label">Direção</span>
          <div className="anim-dir-grid">
            {ANIM_DIRS.map((d) => (
              <button
                key={d.dir}
                title={d.title}
                className={`anim-dir-btn ${(a.inDir || 'center') === d.dir ? 'active' : ''}`}
                onClick={() => setAnim({ inDir: d.dir })}
              >
                {d.glyph}
              </button>
            ))}
          </div>
        </div>
      )}
      {a.in && a.in !== 'none' && (
        <Range
          label="Duração da entrada"
          value={a.inDur ?? 0.6}
          min={0.1}
          max={maxDur}
          step={0.05}
          display={`${(a.inDur ?? 0.6).toFixed(2)}s`}
          onChange={(v) => update(clip.id, { anim: { ...a, inDur: v } })}
        />
      )}
      {a.in && a.in !== 'none' && (
        <button
          className="btn btn-sec full"
          title="Saída espelha a entrada"
          onClick={() => setAnim({ out: matchOutFor(a.in), outDir: a.inDir, outDur: a.inDur })}
        >
          ⇄ Match Out (saída = entrada)
        </button>
      )}
      <label className="field">
        Loop (durante o clipe)
        <select value={a.loop || 'none'} onChange={(e) => setAnim({ loop: e.target.value as ClipAnim['loop'] })}>
          {ANIM_LOOP.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {a.loop && a.loop !== 'none' && (
        <>
          <Range
            label="Velocidade do loop"
            value={a.loopSpeed ?? 1}
            min={0.1}
            max={4}
            step={0.05}
            display={`${(a.loopSpeed ?? 1).toFixed(2)}×`}
            onChange={(v) => update(clip.id, { anim: { ...a, loopSpeed: v } })}
          />
          {a.loop === 'spin' && (
            <p className="hint" style={{ marginTop: -2 }}>
              Uma volta a cada {(3 / (a.loopSpeed ?? 1)).toFixed(1)}s
            </p>
          )}
        </>
      )}
      <label className="field">
        Saída
        <select value={a.out || 'none'} onChange={(e) => setAnim({ out: e.target.value as ClipAnim['out'] })}>
          {ANIM_OUT.map((o) => (
            <option key={o.type} value={o.type}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {outUsesDir(a.out) && (
        <div className="anim-dir">
          <span className="anim-dir-label">Direção</span>
          <div className="anim-dir-grid">
            {ANIM_DIRS.map((d) => (
              <button
                key={d.dir}
                title={d.title}
                className={`anim-dir-btn ${(a.outDir || 'center') === d.dir ? 'active' : ''}`}
                onClick={() => setAnim({ outDir: d.dir })}
              >
                {d.glyph}
              </button>
            ))}
          </div>
        </div>
      )}
      {a.out && a.out !== 'none' && (
        <Range
          label="Duração da saída"
          value={a.outDur ?? 0.6}
          min={0.1}
          max={maxDur}
          step={0.05}
          display={`${(a.outDur ?? 0.6).toFixed(2)}s`}
          onChange={(v) => update(clip.id, { anim: { ...a, outDur: v } })}
        />
      )}
      {a.out && a.out !== 'none' && (
        <button
          className="btn btn-sec full"
          title="Entrada espelha a saída"
          onClick={() => setAnim({ in: matchInFor(a.out), inDir: a.outDir, inDur: a.outDur })}
        >
          ⇄ Match In (entrada = saída)
        </button>
      )}
      <p className="hint" style={{ marginTop: 2 }}>
        Pré-visualize dando play. A entrada toca no início do clipe, o loop durante todo ele, e a saída no fim.
      </p>
    </>
  )
}

function EffectRow({ clip, effect }: { clip: Clip; effect: Effect }): JSX.Element {
  const update = useEditor((s) => s.updateEffect)
  const removeEffect = useEditor((s) => s.removeEffect)
  const commit = useEditor((s) => s.commit)
  const label = EFFECTS.find((e) => e.type === effect.type)?.label || effect.type
  const pxFmt = (v: number): string => `${Math.round(v)}px`
  const pctFmt = (v: number): string => `${Math.round(v * 100)}%`
  const isPan = ['panleft', 'panright', 'panup', 'pandown'].includes(effect.type)
  const amt = isPan
    ? { min: 0, max: 200, step: 5, fmt: pxFmt }
    : effect.type === 'shake'
      ? { min: 0, max: 30, step: 1, fmt: pxFmt }
      : effect.type === 'tilt'
        ? { min: 0, max: 15, step: 0.5, fmt: (v: number) => `${v.toFixed(1)}°` }
        : effect.type === 'blur'
          ? { min: 0, max: 20, step: 0.5, fmt: (v: number) => `${v.toFixed(1)}px` }
          : effect.type === 'vignette' || effect.type === 'bw'
            ? { min: 0, max: 1, step: 0.02, fmt: pctFmt }
            : effect.type === 'breathe'
              ? { min: 0, max: 0.15, step: 0.005, fmt: pctFmt }
              : { min: 0, max: 0.5, step: 0.01, fmt: pctFmt }
  const set = (patch: Partial<Effect>): void => update(clip.id, effect.id, patch)
  const maxT = Math.max(0.1, clip.duration)
  return (
    <div className="effect-row">
      <div className="effect-head">
        <span>{label}</span>
        <button className="track-del" onClick={() => removeEffect(clip.id, effect.id)}>
          ✕
        </button>
      </div>
      <label className="field">
        Início <b>{effect.at.toFixed(2)}s</b>
        <input type="range" min={0} max={maxT} step={0.05} value={effect.at} onMouseDown={() => commit()} onChange={(e) => set({ at: Number(e.target.value) })} />
      </label>
      <label className="field">
        Duração <b>{effect.duration.toFixed(2)}s</b>
        <input type="range" min={0.1} max={maxT} step={0.05} value={effect.duration} onMouseDown={() => commit()} onChange={(e) => set({ duration: Number(e.target.value) })} />
      </label>
      <label className="field">
        Intensidade <b>{amt.fmt(effect.amount)}</b>
        <input type="range" min={amt.min} max={amt.max} step={amt.step} value={effect.amount} onMouseDown={() => commit()} onChange={(e) => set({ amount: Number(e.target.value) })} />
      </label>
    </div>
  )
}
