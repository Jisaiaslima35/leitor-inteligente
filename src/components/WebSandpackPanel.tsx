// WebSandpackPanel.tsx — Modo "Projeto Web" da Sala Dev.
// ISAÍAS 24/08/2026 (P7) — Sandpack React pra mini-projetos HTML/CSS/JS.
// 100% client-side (iframe próprio), sem Piston, sem onerar backend.
//
// Carregamento SOB DEMANDA via React.lazy() + Suspense no DevPage. O bundle
// principal fica intacto; o chunk do Sandpack só baixa quando o aluno troca
// o dropdown pra "Projeto Web (HTML/CSS/JS)".
//
// Persistência via Supabase (web_projects table) — sync cross-device.
// Save automático com debounce 1.8s a cada edição pra não martelar o banco.
//
// ─── P7.8 — 24/08/2026: refatoração após teste do Isaías no celular ─────
// 4 bugs identificados:
//   1. Loop de render: pai tinha files em useState → a cada tecla, code field
//      mudava, useMemo recomputava sandpackFiles, Provider re-renderizava,
//      CodeMirror desmontava/remontava → foco no teclado sumia, "salvando..."
//      entrava em loop porque o BridgeAndSave escutava sandpack.files e
//      chamava onFilesChange (state do pai) a cada keystroke.
//   2. Abas travadas: SandpackCodeEditor com `showTabs` interno não
//      respondia — sandpack.activeFile não era controlado por fora.
//   3. Refresh inoperante: `showRefreshButton` interno do SandpackPreview
//      não disparava o reload.
//   4. Mentor [object Object]: `sandpack.files['/index.html']` pode ser
//      string OU objeto `{ code: string }`. Sem extração, concatenar virava
//      "[object Object]" → quebrava o feedback do Mentor.
//
// Correções aplicadas:
//   a. Pai SEM `files` em useState. Mantém só `initialFiles` (snapshot único
//      vindo do loadWebProject). Sandpack vira fonte da verdade após mount.
//   b. `ProjectSandboxInner` é renderizado DENTRO do SandpackProvider. Ele
//      escuta mudanças via `useSandpack().files` e persiste via useRef +
//      debounce 1800ms — não chama nada no pai → zero re-renders do CodeMirror.
//   c. Tabs customizadas chamam `sandpack.setActiveFile(path)` no onClick.
//      SandpackCodeEditor recebe `showTabs={false}` pra usar só as nossas.
//   d. Botão "Atualizar" custom chama `sandpack.refreshBrowser()` (com
//      fallback pra `refresh()`) — também desabilita showRefreshButton do
//      SandpackPreview pra não confundir.
//   e. Helper `getCode(file)` em todos os pontos de leitura de sandpack.files.
//   f. Botão Mentor lê `filesRef.current` (atualizado em silêncio pelo
//      ProjectSandboxInner) — sem re-render do pai a cada tecla.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  SandpackProvider,
  SandpackCodeEditor,
  SandpackPreview,
  useSandpack,
} from '@codesandbox/sandpack-react'
import { Check, RefreshCw, Sparkles } from 'lucide-react'
import {
  DEFAULT_WEB_PROJECT,
  loadWebProject,
  saveWebProject,
  truncateForFeedback,
  type WebProjectFiles,
} from '../lib/webProjectStorage'

// ─── Tipos ────────────────────────────────────────────────────────────
interface Props {
  userId: string
  bookId: string
  /** Callback pro DevPage abrir o feedback do Mentor sobre o projeto atual. */
  onAskMentor: (
    payload: string,
    meta: { truncated: boolean; reason?: string },
  ) => void
  /** Callback pra DevPage mostrar feedback do Mentor inline (read-only). */
  mentorFeedback?: { text: string; loading: boolean; error?: string }
}

// ─── Helper: extrai string de file do Sandpack ────────────────────────
// sandpack.files['/index.html'] pode ser:
//   - string  (caminho feliz)
//   - { code: string, hidden?, active? } (forma tipada mais nova)
// Sem essa extração, concatenar vira "[object Object]" → bug do Mentor.
function getCode(file: unknown): string {
  if (typeof file === 'string') return file
  if (file && typeof file === 'object') {
    const code = (file as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
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

// Caminhos canônicos dos 3 arquivos do projeto web
const FILE_PATHS = ['/index.html', '/styles.css', '/script.js'] as const
type FilePath = (typeof FILE_PATHS)[number]

// ─── Componente interno: roda DENTRO do SandpackProvider ──────────────
// Tem acesso ao hook useSandpack() que dá o objeto sandpack imperativo
// (files, activeFile, setActiveFile, refreshBrowser, etc.).
function ProjectSandboxInner({
  bookId,
  userId,
  filesRef,
  onAskMentor,
}: {
  bookId: string
  userId: string
  filesRef: React.MutableRefObject<WebProjectFiles>
  onAskMentor: () => void
}) {
  const { sandpack } = useSandpack()

  // Ref do sandpack pra usar dentro do useEffect sem disparar loop
  // (sandpack é um objeto novo em cada render do Inner, mas queremos
  // usar o ref pra ler .files de forma estável).
  const sandpackRef = useRef(sandpack)
  sandpackRef.current = sandpack

  // Debounce save + status visual
  const saveTimer = useRef<number | null>(null)
  const lastSavedSigRef = useRef<string>('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  )

  // Escutar sandpack.files e:
  //   1. Atualizar filesRef.current SEM re-render do pai (ref, não state)
  //   2. Agendar save debounced
  useEffect(() => {
    const files = sandpackRef.current.files

    const html = getCode(files['/index.html']) || DEFAULT_WEB_PROJECT['/index.html']
    const css = getCode(files['/styles.css']) || DEFAULT_WEB_PROJECT['/styles.css']
    const js = getCode(files['/script.js']) || DEFAULT_WEB_PROJECT['/script.js']

    const normalized: WebProjectFiles = {
      '/index.html': html,
      '/styles.css': css,
      '/script.js': js,
    }

    filesRef.current = normalized

    const sig = JSON.stringify(normalized)
    if (sig === lastSavedSigRef.current) return

    setSaveStatus('saving')
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const ok = await saveWebProject(userId, bookId, normalized)
      if (ok) {
        lastSavedSigRef.current = sig
        setSaveStatus('saved')
        window.setTimeout(() => setSaveStatus('idle'), 1500)
      } else {
        setSaveStatus('idle')
      }
    }, 1800)

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [sandpack.files, userId, bookId, filesRef])

  // Tabs customizadas: clicou → setActiveFile → SandpackCodeEditor troca
  const handleTabClick = useCallback(
    (path: FilePath) => {
      try {
        sandpack.setActiveFile(path)
      } catch (e) {
        console.warn('[web-tab] setActiveFile falhou:', e)
      }
    },
    [sandpack],
  )

  // Refresh custom: usa refreshBrowser() (API atual) com fallback pra refresh()
  const handleRefresh = useCallback(() => {
    const sp: any = sandpack
    if (typeof sp.refreshBrowser === 'function') {
      sp.refreshBrowser()
    } else if (typeof sp.refresh === 'function') {
      sp.refresh()
    } else {
      console.warn('[web-refresh] sandpack sem refreshBrowser nem refresh')
    }
  }, [sandpack])

  const tabs: { path: FilePath; label: string }[] = useMemo(
    () => [
      { path: '/index.html', label: 'index.html' },
      { path: '/styles.css', label: 'styles.css' },
      { path: '/script.js', label: 'script.js' },
    ],
    [],
  )

  // Ler activeFile atual do Sandpack (state interno dele). Pra destacar
  // qual tab está ativa — useSandpack() subscreve mudanças.
  const activeFile: FilePath =
    ((sandpack as any).activeFile as FilePath) || '/index.html'

  return (
    <>
      {/* ─── Editor pane ───────────────────────────────────────────── */}
      <div className="web-pane web-pane-editor">
        <header className="web-pane-header">
          <span>📝 Código</span>
          <span className="web-save-status" aria-live="polite">
            {saveStatus === 'saving' && (
              <>
                <RefreshCw size={12} className="spin" /> salvando…
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <Check size={12} /> salvo
              </>
            )}
          </span>
        </header>
        <div
          className="web-tabs"
          role="tablist"
          aria-label="Arquivos do projeto"
        >
          {tabs.map((t) => (
            <button
              key={t.path}
              type="button"
              role="tab"
              aria-selected={activeFile === t.path}
              className={`web-tab-btn ${activeFile === t.path ? 'is-active' : ''}`}
              onClick={() => handleTabClick(t.path)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <SandpackCodeEditor
          showTabs={false}
          showLineNumbers
          showInlineErrors
          wrapContent
          closableTabs={false}
        />
      </div>

      {/* ─── Preview pane ──────────────────────────────────────────── */}
      <div className="web-pane web-pane-preview">
        <header className="web-pane-header">
          <span>👁 Preview</span>
          <button
            type="button"
            className="web-refresh-btn"
            onClick={handleRefresh}
            aria-label="Recarregar preview"
            title="Recarregar preview"
          >
            <RefreshCw size={13} /> Atualizar
          </button>
        </header>
        <SandpackPreview
          showOpenInCodeSandbox={false}
          showRefreshButton={false}
          showRestartButton={false}
          showNavigator={false}
        />
      </div>
    </>
  )
}

// ─── Componente principal ─────────────────────────────────────────────
export default function WebSandpackPanel({
  userId,
  bookId,
  onAskMentor,
  mentorFeedback,
}: Props) {
  const [initialFiles, setInitialFiles] = useState<WebProjectFiles | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mobileTab, setMobileTab] = useState<'code' | 'preview'>('code')
  const [askingMentor, setAskingMentor] = useState(false)

  // Ref que o ProjectSandboxInner atualiza em silêncio (sem re-renderizar
  // o pai). O botão Mentor lê daqui quando o aluno clicar.
  const filesRef = useRef<WebProjectFiles>(DEFAULT_WEB_PROJECT)

  // Carrega projeto salvo uma única vez na inicialização
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    loadWebProject(userId, bookId)
      .then((saved) => {
        if (cancelled) return
        const initial: WebProjectFiles = saved ?? DEFAULT_WEB_PROJECT
        filesRef.current = initial
        setInitialFiles(initial)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError(String(e?.message || e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId, bookId])

  // Botão Mentor: lê o ref (SEM re-renderizar) e dispara onAskMentor do pai.
  const handleAskMentor = useCallback(() => {
    if (askingMentor) return
    setAskingMentor(true)
    const files = filesRef.current
    const { payload, truncated, reason } = truncateForFeedback(files, 4500)
    onAskMentor(payload, { truncated, reason })
    // Libera o botão em 1s; estado real vem via mentorFeedback.loading
    window.setTimeout(() => setAskingMentor(false), 1000)
  }, [askingMentor, onAskMentor])

  // Memo das props do Provider. Não dependemos do estado vivo — Sandpack
  // fica autónomo depois do mount, e o ProjectSandboxInner escuta as
  // mudanças via useSandpack().files.
  const sandpackFiles = useMemo<WebProjectFiles>(() => {
    if (!initialFiles) return DEFAULT_WEB_PROJECT
    return initialFiles
  }, [initialFiles])

  if (!userId || !bookId) {
    return (
      <div className="web-mode-empty">
        Modo Projeto Web requer login e livro aberto. Clica em "Área Dev" a
        partir de um livro de programação pra começar.
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
        <button
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
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
        files={sandpackFiles as any}
        theme={SANDPACK_THEME as any}
      >
        <div
          className={`web-sandpack ${mobileTab === 'code' ? 'show-code' : 'show-preview'}`}
        >
          <ProjectSandboxInner
            bookId={bookId}
            userId={userId}
            filesRef={filesRef}
            onAskMentor={handleAskMentor}
          />
        </div>
      </SandpackProvider>

      {/* Botão Mentor + bubble de feedback (mesmo padrão do modo clássico) */}
      <section className="web-mentor-cta">
        {mentorFeedback?.text ? (
          <div className="web-mentor-bubble">
            <h4>
              <Sparkles size={14} /> Mentor Dev (Projeto Web)
            </h4>
            <p>{mentorFeedback.text}</p>
          </div>
        ) : mentorFeedback?.loading ? (
          <div className="web-mentor-bubble web-mentor-loading">
            <h4>
              <Sparkles size={14} /> Mentor Dev
            </h4>
            <p>
              <RefreshCw size={14} className="spin" /> Analisando HTML/CSS/JS
              (pode levar até 30s)…
            </p>
          </div>
        ) : mentorFeedback?.error ? (
          <div className="web-mentor-bubble web-mentor-err">
            <h4>
              <Sparkles size={14} /> Mentor Dev
            </h4>
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
