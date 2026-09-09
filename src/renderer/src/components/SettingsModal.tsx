import { useEffect, useRef, useState } from 'react'

interface SettingsShape {
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
  lumaApiKey: string
  lumaBaseUrl: string
  lumaModel: string
  heygenApiKey: string
  elevenApiKey: string
  openaiApiKey: string
  klingAccessKey: string
  klingSecretKey: string
  budgetTotalUsd: number
  budgetMode: 'observe' | 'warn' | 'cap'
  singleActionApprovalUsd: number
  mediaDir: string
}

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [s, setS] = useState<SettingsShape | null>(null)
  const [saved, setSaved] = useState(false)
  const loaded = useRef(false)
  const [saveErr, setSaveErr] = useState('')
  const [path, setPath] = useState('')

  useEffect(() => {
    window.api.getSettings().then((data) => {
      setS(data)
      loaded.current = true
    })
    void window.api.settingsPath().then(setPath)
  }, [])

  // Auto-save (debounced) whenever a field changes — no need to click a button.
  useEffect(() => {
    if (!s || !loaded.current) return
    const t = setTimeout(() => {
      window.api.setSettings(s).then((res: any) => {
        const rep = res?.__save
        if (rep && !rep.ok) {
          setSaveErr(`NÃO gravou: ${rep.error} — ${rep.path}`)
          setSaved(false)
          return
        }
        setSaveErr('')
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }).catch((e: Error) => {
        // Without this the promise died silently and the footer lied forever.
        setSaveErr(`falha ao salvar: ${e.message}`)
        setSaved(false)
      })
    }, 500)
    return () => clearTimeout(t)
  }, [s])

  function field(key: keyof SettingsShape, value: string): void {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function save(): Promise<void> {
    if (!s) return
    await window.api.setSettings(s)
    setSaved(true)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Configurações</h2>
        {!s ? (
          <p>Carregando…</p>
        ) : (
          <>
            <div className="settings-section">Seedance (BytePlus ModelArk)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.seedanceApiKey}
                placeholder="cole sua chave aqui"
                onChange={(e) => field('seedanceApiKey', e.target.value)}
              />
            </label>
            <label className="field">
              Base URL
              <input value={s.seedanceBaseUrl} onChange={(e) => field('seedanceBaseUrl', e.target.value)} />
            </label>
            <label className="field">
              Modelo
              <input value={s.seedanceModel} onChange={(e) => field('seedanceModel', e.target.value)} />
            </label>
            <div className="settings-section">Upload de vídeo local (TOS — opcional)</div>
            <p className="hint">
              Para usar vídeos locais como referência, o app precisa de um bucket TOS privado na mesma região do
              Seedance. O arquivo é enviado com URL temporária e apagado ao terminar. A BytePlus pode cobrar o
              pequeno tráfego e armazenamento conforme o seu plano.
            </p>
            <label className="field">
              Bucket TOS
              <input
                value={s.seedanceTosBucket}
                placeholder="nome-do-seu-bucket"
                onChange={(e) => field('seedanceTosBucket', e.target.value)}
              />
            </label>
            <div className="ai-row">
              <label className="field small">
                Região TOS
                <input
                  value={s.seedanceTosRegion}
                  placeholder="ap-southeast-1"
                  onChange={(e) => field('seedanceTosRegion', e.target.value)}
                />
              </label>
              <label className="field">
                Endpoint TOS
                <input
                  value={s.seedanceTosEndpoint}
                  placeholder="tos-ap-southeast-1.bytepluses.com"
                  onChange={(e) => field('seedanceTosEndpoint', e.target.value)}
                />
              </label>
            </div>
            <label className="field">
              TOS Access Key
              <input
                type="password"
                value={s.seedanceTosAccessKey}
                placeholder="Access Key da Volcengine"
                onChange={(e) => field('seedanceTosAccessKey', e.target.value)}
              />
            </label>
            <label className="field">
              TOS Secret Key
              <input
                type="password"
                value={s.seedanceTosSecretKey}
                placeholder="Secret Key da Volcengine"
                onChange={(e) => field('seedanceTosSecretKey', e.target.value)}
              />
            </label>

            <div className="settings-section">Veo (Google Gemini API)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.veoApiKey}
                placeholder="cole sua chave aqui"
                onChange={(e) => field('veoApiKey', e.target.value)}
              />
            </label>
            <label className="field">
              Base URL
              <input value={s.veoBaseUrl} onChange={(e) => field('veoBaseUrl', e.target.value)} />
            </label>

            <div className="settings-section">DeepSeek (melhorar prompt)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.deepseekApiKey}
                placeholder="cole sua chave aqui"
                onChange={(e) => field('deepseekApiKey', e.target.value)}
              />
            </label>
            <label className="field">
              Base URL
              <input value={s.deepseekBaseUrl} onChange={(e) => field('deepseekBaseUrl', e.target.value)} />
            </label>
            <label className="field">
              Modelo
              <input
                value={s.deepseekModel}
                placeholder="deepseek-chat ou deepseek-reasoner"
                onChange={(e) => field('deepseekModel', e.target.value)}
              />
            </label>

            <div className="settings-section">Luma (Ray 3.2 — editar/reluminar vídeo)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.lumaApiKey}
                placeholder="cole sua chave da Luma aqui"
                onChange={(e) => field('lumaApiKey', e.target.value)}
              />
            </label>
            <label className="field">
              Base URL
              <input value={s.lumaBaseUrl} onChange={(e) => field('lumaBaseUrl', e.target.value)} />
            </label>
            <label className="field">
              Modelo
              <input value={s.lumaModel} onChange={(e) => field('lumaModel', e.target.value)} />
            </label>

            <div className="settings-section">ElevenLabs (remoção de ruído de voz)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.elevenApiKey}
                placeholder="cole sua chave do ElevenLabs aqui"
                onChange={(e) => field('elevenApiKey', e.target.value)}
              />
            </label>

            <div className="settings-section">HeyGen (avatar / lip-sync — você falando)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.heygenApiKey}
                placeholder="cole sua chave da HeyGen aqui"
                onChange={(e) => field('heygenApiKey', e.target.value)}
              />
            </label>

            <div className="settings-section">OpenAI (gpt-image-2 — imagem de alta qualidade)</div>
            <label className="field">
              API Key
              <input
                type="password"
                value={s.openaiApiKey}
                placeholder="sk-... (chave da OpenAI)"
                onChange={(e) => field('openaiApiKey', e.target.value)}
              />
            </label>

            <div className="settings-section">Kling (API de desenvolvedor — JWT)</div>
            <label className="field">
              Access Key
              <input
                type="password"
                value={s.klingAccessKey}
                placeholder="Access Key do painel Kling"
                onChange={(e) => field('klingAccessKey', e.target.value)}
              />
            </label>
            <label className="field">
              Secret Key
              <input
                type="password"
                value={s.klingSecretKey}
                placeholder="Secret Key do painel Kling"
                onChange={(e) => field('klingSecretKey', e.target.value)}
              />
            </label>

            <div className="settings-section">🤖 Produtor IA — Orçamento</div>
            <label className="field">
              Teto de orçamento (US$)
              <input
                type="number"
                min={0}
                step={1}
                value={s.budgetTotalUsd}
                onChange={(e) => setS((prev) => (prev ? { ...prev, budgetTotalUsd: Number(e.target.value) } : prev))}
              />
            </label>
            <label className="field">
              Modo
              <select
                value={s.budgetMode}
                onChange={(e) =>
                  setS((prev) => (prev ? { ...prev, budgetMode: e.target.value as SettingsShape['budgetMode'] } : prev))
                }
              >
                <option value="observe">Observar (só registra)</option>
                <option value="warn">Avisar (confirma gastos altos)</option>
                <option value="cap">Travar (bloqueia se estourar)</option>
              </select>
            </label>
            <label className="field">
              Confirmar ações acima de (US$)
              <input
                type="number"
                min={0}
                step={0.1}
                value={s.singleActionApprovalUsd}
                onChange={(e) =>
                  setS((prev) => (prev ? { ...prev, singleActionApprovalUsd: Number(e.target.value) } : prev))
                }
              />
            </label>

            <div className="settings-section">Geral</div>
            <label className="field">
              Pasta de vídeos gerados (vazio = padrão do app)
              <input
                value={s.mediaDir}
                placeholder="C:\\Users\\...\\Videos\\IA"
                onChange={(e) => field('mediaDir', e.target.value)}
              />
            </label>

            {saveErr && <p className="ai-error">⚠ {saveErr}</p>}
            <p className="hint">
              💾 Salvo automaticamente. As chaves ficam no seu computador e nunca saem da máquina,
              exceto nas chamadas diretas às APIs que você configurou.
              {path && (
                <>
                  <br />
                  Arquivo: <code>{path}</code>
                </>
              )}
            </p>

            <div className="modal-actions">
              <span className="saved-tag">{saveErr ? '⚠ NÃO salvou' : saved ? 'Salvo ✓' : 'Salva automaticamente'}</span>
              <button className="btn btn-primary" onClick={() => save().then(onClose)}>
                Fechar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
