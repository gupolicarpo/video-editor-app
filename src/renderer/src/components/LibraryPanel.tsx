import { useState } from 'react'
import { MediaLibrary } from './MediaLibrary'
import { EffectsPanel } from './EffectsPanel'
import { ElementsPanel } from './ElementsPanel'
import { AIPanel } from './AIPanel'
import { ProducerPanel } from './ProducerPanel'

type LibTab = 'arquivos' | 'efeitos' | 'elementos' | 'ia' | 'produtor'

const TABS: Array<{ id: LibTab; label: string }> = [
  { id: 'arquivos', label: 'Arquivos' },
  { id: 'efeitos', label: 'Efeitos' },
  { id: 'elementos', label: 'Elementos' },
  { id: 'ia', label: 'IA' },
  { id: 'produtor', label: 'Produtor' }
]

/**
 * The single left panel: media, effects, elements, AI generation and the
 * budget-aware producer used to each get their own icon-rail destination.
 * That meant five mutually-exclusive full-height panels for what is really
 * one activity — "work with something to put on the timeline" — so they're
 * pill tabs inside one panel now, the way FlexClip's reference screens do it.
 *
 * The search box only filters Arquivos/Elementos: those are the two tabs
 * that are genuinely browsable lists of named things. Efeitos/IA/Produtor
 * are tools and workflows, not lists — a search box above them wouldn't
 * filter anything real, so it's left inert there rather than faked.
 */
export function LibraryPanel({
  tab,
  onTabChange,
  onNeedKeys
}: {
  tab: LibTab
  onTabChange: (t: LibTab) => void
  onNeedKeys: () => void
}): JSX.Element {
  const [search, setSearch] = useState('')

  return (
    <div className="library-panel">
      <div className="library-head">
        <div className="lib-search">
          <span className="lib-search-icon">🔍</span>
          <input
            placeholder="Buscar na biblioteca"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="lib-pills">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'lib-pill on' : 'lib-pill'}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="library-content">
        {tab === 'arquivos' ? (
          <MediaLibrary search={search} />
        ) : tab === 'efeitos' ? (
          <EffectsPanel />
        ) : tab === 'elementos' ? (
          <ElementsPanel search={search} />
        ) : tab === 'ia' ? (
          <AIPanel onNeedKeys={onNeedKeys} />
        ) : (
          <ProducerPanel onOpenSettings={onNeedKeys} />
        )}
      </div>
    </div>
  )
}

export type { LibTab }
