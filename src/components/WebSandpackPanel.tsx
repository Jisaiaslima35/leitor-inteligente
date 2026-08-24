// WebSandpackPanel.tsx — Modo "Projeto Web" da Sala Dev.
// ISAÍAS 24/08/2026 (P7) — Sandpack React pra mini-projetos HTML/CSS/JS
// 100% client-side (iframe próprio), sem Piston, sem onerar backend.
//
// Carregamento SOB DEMANDA via React.lazy() + Suspense no DevPage. O bundle
// principal fica intacto; o chunk do Sandpack só baixa quando o aluno troca
// o dropdown pra "Projeto Web (HTML/CSS/JS)".
//
// Persistência via Supabase (web_projects table) — sync cross-device.
// Save automático com debounce 1.5s a cada edição pra não martelar o banco.
//
// IMPORTANTE: este componente é EXPORTADO DIRETO (não lazy) porque quem
// decide quando baixar é o DevPage via dynamic import(). Aqui dentro só
// usamos a API pública do Sandpack.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SandpackProvider,
  SandpackCodeEditor,
  SandpackPreview,
  useSandpack,
} from '@codesandbox/sandpack-react'
import { Sparkles, RefreshCw, Save, Check } from 'lucide-react'
import {
  DEFAULT_WEB_PROJECT,
  loadWebProject,
  saveWebProject,
  truncateForFeedback,
  type WebProjectFiles,
} from '../lib/webProjectStorage'

// ─── Tipos ─────────────────────────────────────────────────────────────
interface Props {
  userId: string
  bookId: string
  /** Callback pro DevPage abrir o feedback do Mentor sobre o projeto atual. */
  onAskMentor: (payload: string, meta: { truncated: boolean; reason?: string }) => void
  /** Callback pra DevPage mostrar feedback do Mentor inline (read-only). */
  mentorFeedback?: { text: string; loading: boolean; error?: string }
}

// Sandpack customiza tema dark pra casar com a Sala Dev
const SANDPACK_THEME = {
  colors: {
    surface1: '#0f1115',
    surface2: '#161a20',
    surface3: '#1f242b',
    clickable: '#9ca3af',
    base: '#d1d5db',
    disabled: '#4b5563',
    hover: '#f3f4f6',
    accent: '#22c55e',
    error: '#ef4444',
    errorSurface: '#1f1010',
  },
  syntax: {
    plain: '#d1d5db',
    comment: { color: '#6b7280', fontStyle: 'italic' },
    keyword: '#a78bfa',
    tag: '#22c55e',
    punctuation: '#9ca3af',
    definition: '#60a5fa',
    property: '#fbbf24',
    static: '#67e8f9',
    string: '#fca5a5',
  },
  font: {
    body: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    mono: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    size: '13px',
    lineHeight: '1.5',
  },
}

// ─── Componente interno: bridge entre Sandpack e storage ───────────────
// Captura files via onChange do Sandpack + debounce save no Supabase.
function BridgeAndSave({
  bookId,
  userId,
  onFilesChange,
}: {
  bookId: string
  userId: string
  onFilesChange?: (files: WebProjectFiles) => void
}) {
  const { sandpack } = useSandpack()
  const saveTimer = useRef<number | null>(null)
  const lastSavedRef = useRef<string>('')
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle')

  // Captura files do Sandpack + agenda save debounced
  useEffect(() => {
    const files = sandpack.files as unknown as Record<string, string>
    const normalized: WebProjectFiles = {
      '/index.html': files['/index.html'] ?? DEFAULT_WEB_PROJECT['/index.html'],
      '/styles.css': files['/styles.css'] ?? DEFAULT_WEB_PROJECT['/styles.css'],
      '/script.js': files['/script.js'] ?? DEFAULT_WEB_PROJECT['/script.js'],
    }
    const sig = JSON.stringify(normalized)
    if (sig === lastSavedRef.current) return
    onFilesChange?.(normalized)

    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    setSavingState('saving')
    saveTimer.current = window.setTimeout(async () => {
      const ok = await saveWebProject(userId, bookId, normalized)
      if (ok) {
        lastSavedRef.current = sig
        setSavingState('saved')
        // Volta pra 'idle' depois de 1.5s
        window.setTimeout(() => setSavingState('idle'), 1500)
      } else {
        setSavingState('idle')
      }
    }, 1500)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [sandpack.files, userId, bookId, onFilesChange])

  return (
    <div className="web-save-status" aria-live="polite">
      {savingState === 'saving' && (
        <><RefreshCw size={12} className="spin" /> salvando…</>
      )}
      {savingState === 'saved' && (
        <><Check size={12} /> salvo</>
      )}
    </div>
  )
}

// ─── Componente principal ───────────────────────────────────────────────
export default function WebSandpackPanel({ userId, bookId, onAskMentor, mentorFeedback }: Props) {
  const [files, setFiles] = useState<WebProjectFiles>(DEFAULT_WEB_PROJECT)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Tabs mobile: 'code' | 'preview'
  const [mobileTab, setMobileTab] = useState<'code' | 'preview'>('code')
  const [askingMentor, setAskingMentor] = useState(false)

  // Carrega projeto salvo na inicialização
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    loadWebProject(userId, bookId).then((saved) => {
      if (cancelled) return
      if (saved) setFiles(saved)
      setLoading(false)
    }).catch((e) => {
      if (cancelled) return
      setLoadError(String(e?.message || e))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [userId, bookId])

  const handleAskMentor = useCallback(() => {
    if (askingMentor) return
    setAskingMentor(true)
    const { payload, truncated, reason } = truncateForFeedback(files, 4500)
    onAskMentor(payload, { truncated, reason })
    // Libera o botão em 1s (feedback visual); o estado real é controlado
    // pelo mentorFeedback.loading vindo do DevPage
    window.setTimeout(() => setAskingMentor(false), 1000)
  }, [files, askingMentor, onAskMentor])

  const sandpackFiles = useMemo(() => ({
    '/index.html': files['/index.html'],
    '/styles.css': files['/styles.css'],
    '/script.js': files['/script.js'],
  }), [files])

  if (!userId || !bookId) {
    return (
      <div className="web-mode-empty">
        Modo Projeto Web requer login e livro aberto. Clica em "Área Dev" a partir
        de um livro de programação pra começar.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="web-mode-loading">
        <div className="spinner" />
        <p>Carregando seu projeto…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="web-mode-error">
        <p>Não consegui carregar o projeto: {loadError}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Tentar de novo
        </button>
      </div>
    )
  }

  return (
    <div className="web-mode">
      {/* Tabs mobile (esconde no desktop via CSS) */}
      <div className="web-mobile-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === 'code'}
          className={`web-tab ${mobileTab === 'code' ? 'is-active' : ''}`}
          onClick={() => setMobileTab('code')}
        >
          📝 Código
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === 'preview'}
          className={`web-tab ${mobileTab === 'preview' ? 'is-active' : ''}`}
          onClick={() => setMobileTab('preview')}
        >
          👁 Resultado
        </button>
      </div>

      <SandpackProvider
        template="static"
        files={sandpackFiles}
        theme={SANDPACK_THEME as any}
      >
        <div className={`web-sandpack ${mobileTab === 'code' ? 'show-code' : 'show-preview'}`}>
          <div className="web-pane web-pane-editor">
            <header className="web-pane-header">
              <span>📝 Código</span>
              <BridgeAndSave
                bookId={bookId}
                userId={userId}
                onFilesChange={setFiles}
              />
            </header>
            <SandpackCodeEditor
              showTabs
              showLineNumbers
              showInlineErrors
              wrapContent
              closableTabs={false}
              extensions={[]}
            />
          </div>

          <div className="web-pane web-pane-preview">
            <header className="web-pane-header">
              <span>👁 Preview</span>
              <Save size={12} style={{ opacity: 0.5 }} aria-label="Auto-save ativo" />
            </header>
            <SandpackPreview
              showOpenInCodeSandbox={false}
              showRefreshButton
              showRestartButton={false}
              showNavigator={false}
            />
          </div>
        </div>
      </SandpackProvider>

      {/* Botão Mentor + bubble de feedback (mesmo padrão do modo clássico) */}
      <section className="web-mentor-cta">
        {mentorFeedback?.text ? (
          <div className="web-mentor-bubble">
            <h4><Sparkles size={14} /> Mentor Dev (Projeto Web)</h4>
            <p>{mentorFeedback.text}</p>
          </div>
        ) : mentorFeedback?.loading ? (
          <div className="web-mentor-bubble web-mentor-loading">
            <h4><Sparkles size={14} /> Mentor Dev</h4>
            <p><RefreshCw size={14} className="spin" /> Analisando HTML/CSS/JS (pode levar até 30s)…</p>
          </div>
        ) : mentorFeedback?.error ? (
          <div className="web-mentor-bubble web-mentor-err">
            <h4><Sparkles size={14} /> Mentor Dev</h4>
            <p>{mentorFeedback.error}</p>
            <button className="btn btn-primary" onClick={handleAskMentor}>
              <Sparkles size={16} /> Tentar de novo
            </button>
          </div>
        ) : (
          <button
            className="btn btn-primary web-mentor-btn"
            onClick={handleAskMentor}
            disabled={askingMentor}
          >
            <Sparkles size={16} /> Pergunte ao Mentor Dev sobre este projeto
          </button>
        )}
      </section>
    </div>
  )
}
