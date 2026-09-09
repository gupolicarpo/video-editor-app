import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'

type SeedanceMode = 'generate' | 'motion' | 'edit' | 'extend' | 'connect'
type ImageRole = 'reference_image' | 'first_frame' | 'last_frame'
type ImageRef = { path: string; role: ImageRole }

const SEEDANCE_MODELS = [
  { value: 'dreamina-seedance-2-0-260128', label: 'Standard (melhor qualidade)' },
  { value: 'dreamina-seedance-2-0-fast-260128', label: 'Fast (mais rápido)' },
  { value: 'dreamina-seedance-2-0-mini-260615', label: 'Mini (mais econômico)' }
]

const MODE_LABELS: Record<SeedanceMode, string> = {
  generate: 'Gerar',
  motion: 'Movimento',
  edit: 'Editar',
  extend: 'Estender',
  connect: 'Conectar'
}

const MODE_NEEDS_CLIP = new Set<SeedanceMode>(['motion', 'edit', 'extend', 'connect'])

// Full natural-language examples — the user edits them freely.
const EDIT_PRESETS: Array<{ label: string; prompt: string }> = [
  {
    label: 'Trocar fundo',
    prompt: 'Troque o fundo por uma praia tropical ao pôr do sol, mantendo a pessoa, suas roupas e o movimento exatamente iguais.'
  },
  {
    label: 'Remover elemento',
    prompt: 'Remova o carro vermelho ao fundo e preencha de forma natural, mantendo o resto da cena igual.'
  },
  {
    label: 'Trocar elemento',
    prompt: 'Substitua a xícara de café na mesa por um copo de suco de laranja, mantendo a iluminação e a câmera.'
  },
  {
    label: 'Mudar estilo',
    prompt: 'Converta o vídeo para um estilo de animação 3D estilo Pixar, preservando os movimentos e a composição.'
  },
  {
    label: 'Estender vídeo',
    prompt: 'Continue esta cena de forma natural por mais alguns segundos, mantendo o mesmo ambiente e movimento de câmera.'
  }
]

// Luma Ray 3.2 video_edit — relight / restyle while keeping motion.
const LUMA_PRESETS: Array<{ label: string; prompt: string }> = [
  {
    label: 'Luz profissional',
    prompt:
      'Relight this person with soft, professional studio lighting and natural, flattering skin tones. Keep the same face, expression, performance, clothing and background. Cinematic, high-end, crisp look.'
  },
  {
    label: 'Cinematográfico',
    prompt:
      'Give this video a cinematic color grade with rich contrast, gentle teal-orange tones and soft film highlights, while keeping the person, motion and composition exactly the same.'
  },
  {
    label: 'Trocar fundo',
    prompt:
      'Replace the background with a clean modern studio while keeping the person, their clothing, lighting on the face and all movement exactly the same.'
  },
  {
    label: 'Golden hour',
    prompt:
      'Relight the scene with warm golden-hour sunlight coming from the side, soft shadows and a gentle glow, keeping the same subject, performance and background layout.'
  }
]

export function AIPanel({ onNeedKeys }: { onNeedKeys: () => void }): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const updateClip = useEditor((s) => s.updateClip)
  const selClip = useEditor((s) => s.clips.find((c) => c.id === s.selectedClipId))
  const selMedia = useEditor((s) => s.media.find((m) => m.id === selClip?.mediaId))

  const [provider, setProvider] = useState<'seedance' | 'veo' | 'luma'>('seedance')
  const [mode, setMode] = useState<SeedanceMode>('generate')
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState('16:9')
  const [model, setModel] = useState('dreamina-seedance-2-0-260128')
  const [resolution, setResolution] = useState('1080p')
  const [duration, setDuration] = useState(5)
  const [genAudio, setGenAudio] = useState(true)
  const [watermark, setWatermark] = useState(false)
  const [returnLastFrame, setReturnLastFrame] = useState(false)
  const [imageRefs, setImageRefs] = useState<ImageRef[]>([])
  const [videoRefs, setVideoRefs] = useState<string[]>([])
  const [audioRefs, setAudioRefs] = useState<string[]>([])
  const [replaceClip, setReplaceClip] = useState(true)
  const [busy, setBusy] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [keys, setKeys] = useState({
    seedance: false,
    seedanceTos: false,
    veo: false,
    deepseek: false,
    luma: false
  })

  const canEdit = !!(selClip && selClip.type === 'video' && selMedia)

  useEffect(() => {
    window.api
      .getSettings()
      .then((s: any) => {
        if (s.seedanceModel) setModel(s.seedanceModel)
        setKeys({
          seedance: !!s.seedanceApiKey,
          seedanceTos: !!(
            s.seedanceTosRegion &&
            s.seedanceTosEndpoint &&
            s.seedanceTosBucket &&
            s.seedanceTosAccessKey &&
            s.seedanceTosSecretKey
          ),
          veo: !!s.veoApiKey,
          deepseek: !!s.deepseekApiKey,
          luma: !!s.lumaApiKey
        })
      })
    const off = window.api.onAiProgress((s) => setStatus(s.message))
    return off
  }, [])

  useEffect(() => {
    if ((model.includes('fast') || model.includes('mini')) && !['480p', '720p'].includes(resolution)) {
      setResolution('720p')
    }
  }, [model, resolution])

  async function enhance(): Promise<void> {
    setError('')
    if (!prompt.trim()) {
      setError('Escreva uma ideia primeiro para o DeepSeek melhorar.')
      return
    }
    if (!keys.deepseek) {
      setError('Configure a API key do DeepSeek em ⚙ Configurações.')
      onNeedKeys()
      return
    }
    setEnhancing(true)
    try {
      const res = await window.api.enhancePrompt({
        prompt,
        mode: provider === 'seedance' && mode !== 'generate' ? 'edit' : 'generate'
      })
      if (res.ok && res.prompt) setPrompt(res.prompt)
      else setError(res.error || 'Falha ao melhorar o prompt.')
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setEnhancing(false)
    }
  }

  async function addImageRefs(role: ImageRole): Promise<void> {
    if (
      role !== 'reference_image' &&
      (imageRefs.some((ref) => ref.role === 'reference_image') || videoRefs.length > 0 || audioRefs.length > 0)
    ) {
      setError('Quadro inicial/final não pode ser misturado com referências multimodais.')
      return
    }
    if (role === 'reference_image' && imageRefs.some((ref) => ref.role !== 'reference_image')) {
      setError('Imagens de referência não podem ser misturadas com quadro inicial/final.')
      return
    }
    const paths = await window.api.openFiles()
    const imgs = paths.filter((p) => /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i.test(p))
    if (role === 'reference_image') {
      setImageRefs((prev) => [...prev, ...imgs.map((path) => ({ path, role }))].slice(0, 9))
    } else if (imgs[0]) {
      setImageRefs((prev) => [...prev.filter((ref) => ref.role !== role), { path: imgs[0], role }].slice(0, 9))
    }
  }

  async function addVideoRefs(): Promise<void> {
    if (imageRefs.some((ref) => ref.role !== 'reference_image')) {
      setError('Vídeo de referência não pode ser misturado com quadro inicial/final.')
      return
    }
    const paths = await window.api.openFiles()
    const videos = paths.filter((path) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(path))
    const maxExtra = MODE_NEEDS_CLIP.has(mode) ? 2 : 3
    setVideoRefs((prev) => [...prev, ...videos].slice(0, maxExtra))
  }

  async function addAudioRefs(): Promise<void> {
    if (imageRefs.some((ref) => ref.role !== 'reference_image')) {
      setError('Áudio de referência não pode ser misturado com quadro inicial/final.')
      return
    }
    const paths = await window.api.openFiles()
    const audios = paths.filter((path) => /\.(mp3|wav)$/i.test(path))
    setAudioRefs((prev) => [...prev, ...audios].slice(0, 3))
  }

  function selectMode(nextMode: SeedanceMode): void {
    if (MODE_NEEDS_CLIP.has(nextMode)) {
      setImageRefs((prev) => prev.filter((ref) => ref.role === 'reference_image'))
      setVideoRefs((prev) => prev.slice(0, 2))
    }
    setMode(nextMode)
  }

  async function runLuma(): Promise<void> {
    setError('')
    if (!keys.luma) {
      setError('Configure a chave de API da Luma em ⚙ Configurações.')
      onNeedKeys()
      return
    }
    if (!canEdit) {
      setError('Selecione um clipe de vídeo na timeline para editar com a Luma.')
      return
    }
    if (!prompt.trim()) {
      setError('Descreva a edição (ex: nova iluminação, fundo, estilo).')
      return
    }
    setBusy(true)
    setStatus('Iniciando…')
    try {
      const res = await window.api.lumaModify({
        videoPath: selMedia!.path,
        videoIn: selClip!.inPoint,
        videoDur: selClip!.duration,
        prompt,
        resolution: ['540p', '720p', '1080p'].includes(resolution) ? resolution : '720p'
      })
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        const id = nanoid(8)
        addMedia({
          id,
          name: res.mediaPath.split(/[\\/]/).pop() || 'luma-edit.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        if (replaceClip && selClip) {
          updateClip(selClip.id, { mediaId: id, inPoint: 0, duration: meta.duration, type: 'video' })
          setStatus('✅ Clipe substituído pelo resultado da Luma.')
        } else {
          setStatus('✅ Vídeo da Luma adicionado à biblioteca de Mídia.')
        }
        setPrompt('')
      } else {
        setError(res.error || 'Falha na edição com a Luma.')
        setStatus('')
      }
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  async function run(): Promise<void> {
    if (provider === 'luma') return runLuma()
    setError('')
    const currentSettings: any = await window.api.getSettings()
    const liveKeys = {
      ...keys,
      seedance: !!currentSettings.seedanceApiKey,
      seedanceTos: !!(
        currentSettings.seedanceTosRegion &&
        currentSettings.seedanceTosEndpoint &&
        currentSettings.seedanceTosBucket &&
        currentSettings.seedanceTosAccessKey &&
        currentSettings.seedanceTosSecretKey
      ),
      veo: !!currentSettings.veoApiKey
    }
    setKeys(liveKeys)
    const hasKey = provider === 'seedance' ? liveKeys.seedance : liveKeys.veo
    if (!hasKey) {
      setError(`Configure a chave de API do ${provider === 'seedance' ? 'Seedance' : 'Veo'} primeiro.`)
      onNeedKeys()
      return
    }
    if (!prompt.trim()) {
      setError('Escreva um prompt descrevendo o que você quer.')
      return
    }
    const needsClip = provider === 'seedance' && MODE_NEEDS_CLIP.has(mode)
    const replacing = provider === 'seedance' && (mode === 'edit' || mode === 'extend')
    if (needsClip && !canEdit) {
      setError('Selecione um clipe de vídeo na timeline para este modo.')
      return
    }
    if (provider === 'seedance' && mode === 'connect' && videoRefs.length === 0) {
      setError('Para conectar cenas, selecione o clipe da timeline e adicione pelo menos mais um vídeo.')
      return
    }
    if (
      provider === 'seedance' &&
      audioRefs.length > 0 &&
      imageRefs.length === 0 &&
      !needsClip &&
      videoRefs.length === 0
    ) {
      setError('Áudio de referência precisa ser usado junto com uma imagem ou um vídeo.')
      return
    }
    if (provider === 'seedance' && (needsClip || videoRefs.length > 0) && !liveKeys.seedanceTos) {
      setError('Configure o bucket TOS em ⚙ Configurações para enviar vídeos locais de referência.')
      onNeedKeys()
      return
    }

    setBusy(true)
    setStatus('Iniciando…')
    try {
      const payload: any = {
        provider,
        mode: provider === 'seedance' ? mode : 'generate',
        prompt,
        aspectRatio: aspect,
        resolution,
        durationSec: duration,
        generateAudio: genAudio
      }
      if (provider === 'seedance') {
        payload.model = model
        payload.watermark = watermark
        payload.returnLastFrame = returnLastFrame
        payload.imageRefs = imageRefs
        payload.audioPaths = audioRefs
        payload.videoReferences = []
        if (needsClip && selClip && selMedia) {
          payload.videoReferences.push({
            path: selMedia.path,
            inPoint: selClip.inPoint,
            duration: Math.min(selClip.duration, 15)
          })
        }
        for (const path of videoRefs) payload.videoReferences.push({ path })
      }
      const res = await window.api.generate(payload)
      if (res.ok && res.mediaPath) {
        const meta = await window.api.probe(res.mediaPath)
        const id = nanoid(8)
        addMedia({
          id,
          name: res.mediaPath.split(/[\\/]/).pop() || 'gerado.mp4',
          path: res.mediaPath,
          type: meta.type,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          fps: meta.fps
        })
        if (replacing && replaceClip && selClip) {
          updateClip(selClip.id, { mediaId: id, inPoint: 0, duration: meta.duration, type: 'video' })
          setStatus('✅ Clipe substituído pelo resultado da edição.')
        } else {
          setStatus('✅ Vídeo adicionado à biblioteca de Mídia.')
        }
        if (res.lastFramePath) {
          const frameMeta = await window.api.probe(res.lastFramePath)
          addMedia({
            id: nanoid(8),
            name: res.lastFramePath.split(/[\\/]/).pop() || 'seedance-last-frame.jpg',
            path: res.lastFramePath,
            type: frameMeta.type,
            duration: frameMeta.duration || 5,
            width: frameMeta.width,
            height: frameMeta.height,
            hasAudio: frameMeta.hasAudio,
            hasVideo: frameMeta.hasVideo,
            fps: frameMeta.fps
          })
        }
        setPrompt('')
      } else {
        setError(res.error || 'Falha na geração.')
        setStatus('')
      }
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-panel">
      <div className="provider-switch">
        <button className={provider === 'seedance' ? 'seg active' : 'seg'} onClick={() => setProvider('seedance')}>
          Seedance 2.0 {keys.seedance ? '🔑' : ''}
        </button>
        <button className={provider === 'veo' ? 'seg active' : 'seg'} onClick={() => setProvider('veo')}>
          Veo {keys.veo ? '🔑' : ''}
        </button>
        <button className={provider === 'luma' ? 'seg active' : 'seg'} onClick={() => setProvider('luma')}>
          Luma (editar) {keys.luma ? '🔑' : ''}
        </button>
      </div>

      {provider === 'seedance' && (
        <>
          <div className="provider-switch" style={{ flexWrap: 'wrap' }}>
            {(Object.keys(MODE_LABELS) as SeedanceMode[]).map((value) => (
              <button
                key={value}
                className={mode === value ? 'seg active' : 'seg'}
                onClick={() => selectMode(value)}
              >
                {MODE_LABELS[value]}
              </button>
            ))}
          </div>
          <label className="field">
            Modelo Seedance
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {SEEDANCE_MODELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {provider === 'seedance' && MODE_NEEDS_CLIP.has(mode) && (
        <>
          <div className={`edit-target ${canEdit ? '' : 'warn'}`}>
            {canEdit
              ? `${MODE_LABELS[mode]} usando: ${selMedia!.name}`
              : 'Selecione um clipe de vídeo na timeline.'}
          </div>
          {mode === 'edit' && (
            <div className="preset-grid" style={{ flexWrap: 'wrap' }}>
              {EDIT_PRESETS.map((p) => (
                <button key={p.label} className="preset" onClick={() => setPrompt(p.prompt)}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {mode === 'motion' && (
            <p className="hint">O clipe selecionado será usado como referência de movimento e câmera.</p>
          )}
          {mode === 'extend' && <p className="hint">O Seedance continuará a cena a partir do clipe selecionado.</p>}
          {mode === 'connect' && (
            <p className="hint">Adicione outro vídeo abaixo para criar uma passagem entre as cenas.</p>
          )}
        </>
      )}

      {provider === 'luma' && (
        <>
          <div className={`edit-target ${canEdit ? '' : 'warn'}`}>
            {canEdit ? `Editando com Luma: ${selMedia!.name}` : 'Selecione um clipe de vídeo na timeline.'}
          </div>
          <div className="preset-grid" style={{ flexWrap: 'wrap' }}>
            {LUMA_PRESETS.map((p) => (
              <button key={p.label} className="preset" onClick={() => setPrompt(p.prompt)}>
                {p.label}
              </button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 2 }}>
            🎬 Ray 3.2 edita o vídeo inteiro mantendo o movimento (estilo Aleph): troque iluminação, fundo ou
            estilo. Usa o trecho do clipe (até 10s). Diga o que <b>mudar</b> e o que <b>manter</b>.
          </p>
        </>
      )}

      <div className="prompt-head">
        <span>Prompt</span>
        <button className="btn-mini" onClick={enhance} disabled={enhancing} title="Reescreve seu prompt com o DeepSeek">
          {enhancing ? 'Melhorando…' : '✨ Melhorar prompt'}
        </button>
      </div>
      <label className="field">
        <textarea
          rows={4}
          value={prompt}
          placeholder={
            mode === 'motion'
              ? 'Ex: use o movimento e a câmera do Vídeo 1, mas aplique à personagem da Imagem 1.'
              : mode === 'edit'
                ? 'Ex: troque o fundo por uma praia, mantendo a pessoa e o movimento.'
                : mode === 'extend'
                  ? 'Ex: continue a cena com a câmera avançando lentamente.'
                  : mode === 'connect'
                    ? 'Ex: conecte o Vídeo 1 ao Vídeo 2 com uma transição natural.'
                    : 'Ex: um drone sobrevoando montanhas nevadas ao amanhecer, cinematográfico…'
          }
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      {provider === 'seedance' && mode !== 'generate' && (
        <p className="hint" style={{ marginTop: -6 }}>
          💬 Escreva em linguagem natural. Dica: diga o que <b>mudar</b> e o que <b>manter</b> (ex: "troque o céu por
          um pôr do sol, mantendo a pessoa e o movimento"). Quanto mais específico, melhor.
        </p>
      )}

      {provider === 'seedance' && (
        <>
          <div className="ref-row">
            <span className="ref-label">Imagens ({imageRefs.length}/9)</span>
            <button className="btn-mini" onClick={() => addImageRefs('reference_image')}>
              + Referência
            </button>
            {mode === 'generate' && (
              <>
                <button className="btn-mini" onClick={() => addImageRefs('first_frame')}>
                  + Quadro inicial
                </button>
                <button className="btn-mini" onClick={() => addImageRefs('last_frame')}>
                  + Quadro final
                </button>
              </>
            )}
          </div>
          {imageRefs.length > 0 && (
            <div className="ref-chips">
              {imageRefs.map((ref, index) => (
                <span key={`${ref.path}-${ref.role}`} className="ref-chip" title={ref.path}>
                  {ref.role === 'first_frame' ? 'Início: ' : ref.role === 'last_frame' ? 'Final: ' : ''}
                  {ref.path.split(/[\\/]/).pop()}
                  <button onClick={() => setImageRefs((prev) => prev.filter((_, item) => item !== index))}>✕</button>
                </span>
              ))}
            </div>
          )}

          <div className="ref-row">
            <span className="ref-label">
              Vídeos ({videoRefs.length + (MODE_NEEDS_CLIP.has(mode) && canEdit ? 1 : 0)}/3)
            </span>
            <button className="btn-mini" onClick={addVideoRefs}>
              + Adicionar vídeo
            </button>
          </div>
          {videoRefs.length > 0 && (
            <div className="ref-chips">
              {videoRefs.map((path, index) => (
                <span key={path} className="ref-chip" title={path}>
                  {path.split(/[\\/]/).pop()}
                  <button onClick={() => setVideoRefs((prev) => prev.filter((_, item) => item !== index))}>✕</button>
                </span>
              ))}
            </div>
          )}
          <p className="hint">
            O upload resolve o arquivo local. A moderação da Seedance ainda pode recusar vídeos com rosto de pessoa
            real.
          </p>

          <div className="ref-row">
            <span className="ref-label">Áudios ({audioRefs.length}/3)</span>
            <button className="btn-mini" onClick={addAudioRefs}>
              + Adicionar áudio
            </button>
          </div>
          {audioRefs.length > 0 && (
            <div className="ref-chips">
              {audioRefs.map((path, index) => (
                <span key={path} className="ref-chip" title={path}>
                  {path.split(/[\\/]/).pop()}
                  <button onClick={() => setAudioRefs((prev) => prev.filter((_, item) => item !== index))}>✕</button>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <div className="ai-row">
        <label className="field small">
          Proporção
          <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
            <option value="21:9">21:9</option>
            <option value="adaptive">Adaptável</option>
          </select>
        </label>
        {provider === 'seedance' && (
          <label className="field small">
            Resolução
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              {!model.includes('fast') && !model.includes('mini') && (
                <>
                  <option value="1080p">1080p</option>
                  <option value="4k">4K</option>
                </>
              )}
            </select>
          </label>
        )}
        {provider === 'luma' && (
          <label className="field small">
            Resolução
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="540p">540p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
        )}
        {provider !== 'luma' && (
          <label className="field small">
            Duração (s)
            <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
              <option value={-1}>Automática</option>
              {Array.from({ length: 12 }, (_, index) => index + 4).map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}s
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {provider === 'seedance' && (
        <>
          <label className="chk-single">
            <input type="checkbox" checked={genAudio} onChange={(e) => setGenAudio(e.target.checked)} /> Gerar áudio nativo
          </label>
          <label className="chk-single">
            <input type="checkbox" checked={returnLastFrame} onChange={(e) => setReturnLastFrame(e.target.checked)} /> Salvar
            também o último quadro
          </label>
          <label className="chk-single">
            <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} /> Marca d’água da
            Seedance
          </label>
        </>
      )}
      {provider === 'seedance' && (mode === 'edit' || mode === 'extend') && (
        <label className="chk-single">
          <input type="checkbox" checked={replaceClip} onChange={(e) => setReplaceClip(e.target.checked)} /> Substituir o clipe
          selecionado pelo resultado
        </label>
      )}

      {provider === 'luma' && (
        <label className="chk-single">
          <input type="checkbox" checked={replaceClip} onChange={(e) => setReplaceClip(e.target.checked)} /> Substituir o clipe
          selecionado pelo resultado
        </label>
      )}

      <button className="btn btn-primary full" onClick={run} disabled={busy}>
        {busy
          ? 'Processando…'
          : provider === 'luma'
            ? '✨ Editar com Luma (Ray 3.2)'
            : provider === 'veo'
              ? '✨ Gerar vídeo com Veo'
              : `✨ ${MODE_LABELS[mode]} com Seedance`}
      </button>
      {busy && provider === 'seedance' && (
        <button className="btn full" onClick={() => void window.api.cancelAi()}>
          Cancelar geração
        </button>
      )}

      {status && <div className="ai-status">{status}</div>}
      {error && <div className="ai-error">{error}</div>}
      {!keys.seedance && !keys.veo && (
        <div className="hint">Dica: adicione suas chaves de API em ⚙ Configurações para habilitar a IA.</div>
      )}
    </div>
  )
}
