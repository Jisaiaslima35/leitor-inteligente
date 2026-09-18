import React, { useState, useMemo, useEffect, useRef } from 'react'
import { X, Search, ChevronRight, ChevronDown, BookOpen, Bookmark, ArrowRight } from 'lucide-react'

export interface TocItem {
  id: string
  level: number
  title: string
  page: number
  children?: TocItem[]
}

interface TocDrawerProps {
  isOpen: boolean
  onClose: () => void
  toc: [number, string, number][]
  currentPage: number
  totalPages: number
  bookTitle: string
  onSelectPage: (page: number) => void
}

/**
 * Converte a lista linear [[level, title, page], ...] em uma árvore hierárquica.
 */
function buildTocTree(raw: [number, string, number][]): TocItem[] {
  if (!raw || raw.length === 0) return []
  const root: TocItem[] = []
  const stack: { item: TocItem; level: number }[] = []

  raw.forEach((entry, idx) => {
    const [level, title, page] = entry
    const node: TocItem = {
      id: `toc-${idx}-${level}-${page}`,
      level,
      title: title || `Seção (pág. ${page})`,
      page,
      children: [],
    }

    // Procura o pai correto na pilha
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop()
    }

    if (stack.length === 0) {
      root.push(node)
    } else {
      const parent = stack[stack.length - 1].item
      if (!parent.children) parent.children = []
      parent.children.push(node)
    }

    stack.push({ item: node, level })
  })

  return root
}

/**
 * Encontra os IDs dos nós pais que contêm a página atual.
 */
function findActiveNodePath(items: TocItem[], currentPage: number): { activeId: string | null; ancestorIds: Set<string> } {
  let closestItem: TocItem | null = null
  const ancestors = new Set<string>()

  // Achatamento ordenado por página
  function traverse(nodes: TocItem[], currentAncestors: string[]) {
    for (const node of nodes) {
      if (node.page <= currentPage) {
        if (!closestItem || node.page >= closestItem.page) {
          closestItem = node
        }
      }
      if (node.children && node.children.length > 0) {
        traverse(node.children, [...currentAncestors, node.id])
      }
    }
  }

  traverse(items, [])

  // Se encontrou o item mais próximo, rastreia os ancestrais
  function collectAncestors(nodes: TocItem[], targetId: string, currentChain: string[]): boolean {
    for (const node of nodes) {
      if (node.id === targetId) {
        currentChain.forEach((id) => ancestors.add(id))
        return true
      }
      if (node.children && node.children.length > 0) {
        if (collectAncestors(node.children, targetId, [...currentChain, node.id])) {
          return true
        }
      }
    }
    return false
  }

  if (closestItem) {
    collectAncestors(items, (closestItem as TocItem).id, [])
    return { activeId: (closestItem as TocItem).id, ancestorIds: ancestors }
  }

  return { activeId: null, ancestorIds: ancestors }
}

export function TocDrawer({
  isOpen,
  onClose,
  toc,
  currentPage,
  totalPages,
  bookTitle,
  onSelectPage,
}: TocDrawerProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const drawerRef = useRef<HTMLDivElement>(null)

  // Constrói árvore hierárquica memorizada
  const tree = useMemo(() => buildTocTree(toc), [toc])

  // Identifica o nó ativo da página atual e seus ancestrais
  const { activeId, ancestorIds } = useMemo(
    () => findActiveNodePath(tree, currentPage),
    [tree, currentPage]
  )

  // Ao abrir o drawer ou mudar de página, auto-expande os ancestrais do capítulo ativo
  useEffect(() => {
    if (isOpen && ancestorIds.size > 0) {
      setExpandedNodes((prev) => {
        const next = new Set(prev)
        ancestorIds.forEach((id) => next.add(id))
        return next
      })
    }
  }, [isOpen, ancestorIds])

  // Fecha ao pressionar ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const toggleNode = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleItemClick = (page: number) => {
    onSelectPage(page)
    // Em telas mobile fecha o drawer ao saltar
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      onClose()
    }
  }

  // Filtro de busca plano quando há termo digitado
  const filteredFlatList = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return null
    return (toc || []).filter(([_, title, page]) =>
      title.toLowerCase().includes(term) || String(page).includes(term)
    )
  }, [toc, searchTerm])

  if (!isOpen) return null

  return (
    <div className="toc-drawer-overlay" onClick={onClose} aria-modal="true" role="dialog">
      <div
        className="toc-drawer-panel"
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Cabeçalho */}
        <div className="toc-drawer-header">
          <div className="toc-drawer-title-row">
            <div className="toc-drawer-title-group">
              <BookOpen size={18} className="toc-icon-gold" />
              <h3 className="toc-drawer-title">Sumário do Livro</h3>
            </div>
            <button
              className="icon-btn toc-close-btn"
              onClick={onClose}
              title="Fechar sumário (Esc)"
              aria-label="Fechar sumário"
            >
              <X size={18} />
            </button>
          </div>
          <div className="toc-book-meta">
            <span className="toc-book-name">{bookTitle}</span>
            <span className="toc-badge-total">
              {toc.length > 0 ? `${toc.length} seções` : 'Sem marcadores nativos'}
            </span>
          </div>

          {/* Campo de Busca Rápida */}
          {toc.length > 0 && (
            <div className="toc-search-box">
              <Search size={15} className="toc-search-icon" />
              <input
                type="text"
                placeholder="Filtrar capítulos ou página..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="toc-search-input"
              />
              {searchTerm && (
                <button
                  className="toc-search-clear"
                  onClick={() => setSearchTerm('')}
                  title="Limpar busca"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Conteúdo da Árvore */}
        <div className="toc-drawer-content">
          {toc.length === 0 ? (
            <div className="toc-empty-state">
              <Bookmark size={32} className="toc-empty-icon" />
              <p>Este arquivo PDF não possui sumário estruturado nativo.</p>
              <small>Utilize os controles de página para navegar pelas {totalPages} páginas.</small>
            </div>
          ) : filteredFlatList !== null ? (
            // Exibição quando usuário está buscando
            <div className="toc-search-results">
              <div className="toc-results-count">
                {filteredFlatList.length} resultado(s) encontrado(s):
              </div>
              {filteredFlatList.length === 0 ? (
                <div className="toc-no-results">Nenhum capítulo correspondente.</div>
              ) : (
                filteredFlatList.map(([level, title, page], idx) => {
                  const isActive = currentPage === page
                  return (
                    <button
                      key={`search-${idx}-${page}`}
                      className={`toc-item-btn level-${level} ${isActive ? 'active' : ''}`}
                      onClick={() => handleItemClick(page)}
                    >
                      <span className="toc-item-title">{title}</span>
                      <span className="toc-item-page">pág. {page}</span>
                    </button>
                  )
                })
              )}
            </div>
          ) : (
            // Exibição hierárquica com acordeão
            <div className="toc-tree">
              {tree.map((node) => (
                <TocTreeNode
                  key={node.id}
                  node={node}
                  activeId={activeId}
                  expandedNodes={expandedNodes}
                  onToggle={toggleNode}
                  onSelectPage={handleItemClick}
                  currentPage={currentPage}
                />
              ))}
            </div>
          )}
        </div>

        {/* Rodapé informativo */}
        <div className="toc-drawer-footer">
          <span>Página atual: <strong>{currentPage}</strong> de {totalPages}</span>
          <button
            className="toc-jump-current-btn"
            onClick={() => handleItemClick(currentPage)}
            title="Centralizar na página atual"
          >
            Ver pág. {currentPage}
          </button>
        </div>
      </div>

      <style>{`
        .toc-drawer-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.55);
          backdrop-filter: blur(4px);
          z-index: 9999;
          display: flex;
          justify-content: flex-start;
          animation: tocFadeIn 0.2s ease-out;
        }

        .toc-drawer-panel {
          width: 100%;
          max-width: 420px;
          height: 100%;
          background: var(--surface, #1e1e24);
          color: var(--ink, #f3f4f6);
          border-right: 1px solid var(--border, rgba(255, 255, 255, 0.1));
          box-shadow: 8px 0 32px rgba(0, 0, 0, 0.45);
          display: flex;
          flex-direction: column;
          animation: tocSlideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          outline: none;
        }

        @keyframes tocFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes tocSlideIn {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }

        .toc-drawer-header {
          padding: 16px;
          border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
          background: var(--surface-2, rgba(255, 255, 255, 0.03));
        }

        .toc-drawer-title-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }

        .toc-drawer-title-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .toc-icon-gold {
          color: #d4af37;
        }

        .toc-drawer-title {
          margin: 0;
          font-size: 1.05rem;
          font-weight: 700;
        }

        .toc-close-btn {
          background: transparent;
          border: none;
          color: var(--muted, #9ca3af);
          cursor: pointer;
          padding: 6px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .toc-close-btn:hover {
          color: var(--ink, #fff);
          background: rgba(255, 255, 255, 0.08);
        }

        .toc-book-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 0.85rem;
          color: var(--muted, #9ca3af);
          margin-bottom: 12px;
          gap: 8px;
        }

        .toc-book-name {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 250px;
        }

        .toc-badge-total {
          background: rgba(212, 175, 55, 0.15);
          color: #d4af37;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 0.75rem;
          font-weight: 600;
          white-space: nowrap;
        }

        .toc-search-box {
          position: relative;
          display: flex;
          align-items: center;
        }

        .toc-search-icon {
          position: absolute;
          left: 10px;
          color: var(--muted, #9ca3af);
          pointer-events: none;
        }

        .toc-search-input {
          width: 100%;
          padding: 8px 32px 8px 32px;
          border-radius: 8px;
          border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
          background: var(--surface, #151518);
          color: var(--ink, #fff);
          font-size: 0.85rem;
          transition: border-color 0.2s;
        }
        .toc-search-input:focus {
          outline: none;
          border-color: #d4af37;
        }

        .toc-search-clear {
          position: absolute;
          right: 8px;
          background: transparent;
          border: none;
          color: var(--muted, #9ca3af);
          cursor: pointer;
          padding: 4px;
        }

        .toc-drawer-content {
          flex: 1;
          overflow-y: auto;
          padding: 8px 0;
          scrollbar-width: thin;
        }

        .toc-empty-state {
          padding: 40px 24px;
          text-align: center;
          color: var(--muted, #9ca3af);
        }
        .toc-empty-icon {
          margin-bottom: 12px;
          opacity: 0.4;
        }

        .toc-search-results {
          padding: 0 8px;
        }
        .toc-results-count {
          font-size: 0.75rem;
          color: var(--muted, #9ca3af);
          padding: 4px 8px 8px;
        }
        .toc-no-results {
          padding: 24px 8px;
          text-align: center;
          color: var(--muted, #9ca3af);
          font-size: 0.85rem;
        }

        .toc-item-btn {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: var(--ink, #e5e7eb);
          text-align: left;
          cursor: pointer;
          font-size: 0.88rem;
          transition: background 0.15s, color 0.15s;
          margin-bottom: 2px;
        }
        .toc-item-btn:hover {
          background: rgba(255, 255, 255, 0.06);
          color: #fff;
        }
        .toc-item-btn.active {
          background: rgba(212, 175, 55, 0.18);
          color: #d4af37;
          font-weight: 600;
          border-left: 3px solid #d4af37;
        }

        .toc-item-title {
          flex: 1;
          margin-right: 8px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: normal;
          line-height: 1.35;
        }

        .toc-item-page {
          font-size: 0.78rem;
          color: var(--muted, #9ca3af);
          white-space: nowrap;
          background: rgba(255, 255, 255, 0.05);
          padding: 2px 6px;
          border-radius: 4px;
        }
        .toc-item-btn.active .toc-item-page {
          background: rgba(212, 175, 55, 0.25);
          color: #d4af37;
          font-weight: 700;
        }

        .toc-node {
          margin-bottom: 1px;
        }

        .toc-node-row {
          display: flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 6px;
          margin: 0 4px;
          transition: background 0.15s;
        }
        .toc-node-row:hover {
          background: rgba(255, 255, 255, 0.05);
        }
        .toc-node-row.active {
          background: rgba(212, 175, 55, 0.15);
          border-left: 3px solid #d4af37;
        }

        .toc-toggle-btn {
          background: transparent;
          border: none;
          color: var(--muted, #9ca3af);
          cursor: pointer;
          padding: 4px;
          margin-right: 2px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .toc-toggle-btn:hover {
          color: var(--ink, #fff);
          background: rgba(255, 255, 255, 0.1);
        }

        .toc-toggle-spacer {
          width: 24px;
          height: 24px;
        }

        .toc-node-click {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: transparent;
          border: none;
          color: inherit;
          text-align: left;
          cursor: pointer;
          padding: 4px 6px;
          border-radius: 4px;
        }

        .toc-node-title {
          font-size: 0.88rem;
          line-height: 1.35;
          word-break: break-word;
        }
        .toc-node.level-1 > .toc-node-row .toc-node-title {
          font-weight: 600;
        }
        .toc-node.level-2 > .toc-node-row .toc-node-title {
          font-size: 0.83rem;
        }
        .toc-node.level-3 > .toc-node-row .toc-node-title {
          font-size: 0.8rem;
          opacity: 0.9;
        }

        .toc-node-children {
          padding-left: 18px;
          border-left: 1px dashed var(--border, rgba(255, 255, 255, 0.1));
          margin-left: 18px;
        }

        .toc-drawer-footer {
          padding: 12px 16px;
          border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1));
          background: var(--surface-2, rgba(255, 255, 255, 0.02));
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 0.85rem;
          color: var(--muted, #9ca3af);
        }

        .toc-jump-current-btn {
          background: rgba(212, 175, 55, 0.15);
          color: #d4af37;
          border: 1px solid rgba(212, 175, 55, 0.3);
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }
        .toc-jump-current-btn:hover {
          background: rgba(212, 175, 55, 0.25);
        }

        @media (max-width: 600px) {
          .toc-drawer-panel {
            max-width: 88vw;
          }
        }
      `}</style>
    </div>
  )
}

interface TocTreeNodeProps {
  node: TocItem
  activeId: string | null
  expandedNodes: Set<string>
  onToggle: (id: string, e: React.MouseEvent) => void
  onSelectPage: (page: number) => void
  currentPage: number
}

function TocTreeNode({
  node,
  activeId,
  expandedNodes,
  onToggle,
  onSelectPage,
  currentPage,
}: TocTreeNodeProps) {
  const hasChildren = node.children && node.children.length > 0
  const isExpanded = expandedNodes.has(node.id)
  const isActive = activeId === node.id || currentPage === node.page

  return (
    <div className={`toc-node level-${node.level}`}>
      <div className={`toc-node-row ${isActive ? 'active' : ''}`}>
        {hasChildren ? (
          <button
            type="button"
            className="toc-toggle-btn"
            onClick={(e) => onToggle(node.id, e)}
            aria-label={isExpanded ? 'Recolher seção' : 'Expandir seção'}
          >
            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span className="toc-toggle-spacer" />
        )}

        <button
          type="button"
          className="toc-node-click"
          onClick={() => onSelectPage(node.page)}
        >
          <span className="toc-node-title">{node.title}</span>
          <span className="toc-item-page">pág. {node.page}</span>
        </button>
      </div>

      {/* Renderização condicional leve: só renderiza filhos quando expandido (poupa DOM em livros de 2400+ páginas) */}
      {hasChildren && isExpanded && (
        <div className="toc-node-children">
          {node.children!.map((child) => (
            <TocTreeNode
              key={child.id}
              node={child}
              activeId={activeId}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              onSelectPage={onSelectPage}
              currentPage={currentPage}
            />
          ))}
        </div>
      )}
    </div>
  )
}
