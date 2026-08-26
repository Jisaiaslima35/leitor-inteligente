// MentorSkillsPanel.tsx — P10 Isaías 24/08/2026
//
// Ferramenta EXCLUSIVA do admin pra gerar "eBook Mentor" a partir de qualquer
// ebook do catálogo Supabase. Roda o pipeline book-to-skill e salva em
// ~/.hermes/profiles/leitor-inteligente/skills/<slug>/.
//
// SEM cobrança, SEM user comum. Só o Isaías usa isso pra produzir ebooks
// Mentor pra campanhas de aquisição.

import { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, CheckCircle2, AlertCircle, BookOpen, Copy, ExternalLink, Zap } from 'lucide-react'
import { supabase, SUPABASE_READY } from '../lib/supabase'

interface EbookRow {
  id: string
  slug: string
  title: string
  author: string | null
  cover_url: string | null
  skill_generated: boolean | null
  skill_generated_at: string | null
}

interface SkillGenResponse {
  ok?: boolean
  error?: string
  slug?: string
  title?: string
  author?: string
  total_pages?: number
  total_chars?: number
  skill_dir?: string
  files?: string[]
}

interface SkillListItem {
  slug: string
  skill_md_size: number
}

const ADMIN_SKILL_API = `${import.meta.env.BASE_URL}admin-skill-api`

export function MentorSkillsPanel() {
  const [ebooks, setEbooks] = useState<EbookRow[]>([])
  const [skills, setSkills] = useState<SkillListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [result, setResult] = useState<SkillGenResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [publicUrl, setPublicUrl] = useState<string>('')

  async function load() {
    setLoading(true)
    try {
      // Lista ebooks do Supabase
      if (SUPABASE_READY) {
        const { data, error } = await supabase
          .from('ebooks')
          .select('id,slug,title,author,cover_url,skill_generated,skill_generated_at')
          .order('title', { ascending: true })
        if (error) throw error
        setEbooks((data as EbookRow[]) || [])
      }
      // Lista skills já geradas no disco
      const r = await fetch(`${ADMIN_SKILL_API}/list-skills`)
      if (r.ok) {
        const j = await r.json()
        setSkills(j.skills || [])
      }
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // URL pública do Leitor (preview.automacaojs.us/leitor-inteligente/...)
  useEffect(() => {
    const proto = window.location.protocol
    const host = window.location.host
    setPublicUrl(`${proto}//${host}/leitor-inteligente/`)
  }, [])

  const filtered = ebooks.filter(b =>
    !query || b.title.toLowerCase().includes(query.toLowerCase()) || b.slug.toLowerCase().includes(query.toLowerCase())
  )

  async function generateSkill(slug: string, title: string) {
    if (!confirm(`Gerar skill de Mentor pro livro "${title}"?\n\nIsso roda a pipeline book-to-skill (5-10min). Pode sobrescrever skill existente.`)) return
    setBusySlug(slug)
    setErr(null)
    setResult(null)
    try {
      const r = await fetch(`${ADMIN_SKILL_API}/generate-skill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_slug: slug, mode: 'analyze' }),
      })
      const j = await r.json()
      if (!r.ok || j.error) {
        setErr(j.error || `HTTP ${r.status}`)
        return
      }
      setResult(j)
      await load() // refresh pra pegar skill_generated=true
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusySlug(null)
    }
  }

  function slugHasSkill(slug: string): boolean {
    return skills.some(s => s.slug === slug)
  }

  function bookUrl(slug: string): string {
    return `${publicUrl}#/reader/${slug}`
  }

  function copyLink(slug: string) {
    const url = bookUrl(slug)
    navigator.clipboard?.writeText(url).catch(() => {})
  }

  return (
    <div className="mentor-skills-panel">
      <div className="kpi-card" style={{ marginBottom: 16, borderLeft: '4px solid #d4af37' }}>
        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={18} style={{ color: '#d4af37' }} />
          Criar eBook Mentor
        </h3>
        <p style={{ color: 'var(--muted)', marginBottom: 8 }}>
          Ferramenta <strong>exclusiva sua</strong> pra gerar um "eBook Mentor" a partir de qualquer livro do catálogo.
          Roda o pipeline <code>book-to-skill</code> (análise automática dos frameworks do livro) e salva em
          <code> ~/.hermes/profiles/leitor-inteligente/skills/&lt;slug&gt;/</code>.
        </p>
        <p style={{ color: 'var(--muted)', margin: 0, fontSize: 14 }}>
          📖 Funciona melhor pra livros de <strong>autoajuda / negócios / programação com método</strong>.
          Ficção/poesia não se beneficia. Após gerar, copie o link público do livro e use nas suas campanhas.
        </p>
      </div>

      {err && (
        <div className="kpi-card" style={{ marginBottom: 16, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          <AlertCircle size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {err}
        </div>
      )}

      {result && result.ok && (
        <div className="kpi-card" style={{ marginBottom: 16, borderColor: '#22c55e', background: 'rgba(34,197,94,0.05)' }}>
          <h4 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8, color: '#22c55e' }}>
            <CheckCircle2 size={18} /> Skill gerada com sucesso!
          </h4>
          <div style={{ fontSize: 14 }}>
            <div><strong>Livro:</strong> {result.title} ({result.author})</div>
            <div><strong>Slug:</strong> <code>{result.slug}</code></div>
            <div><strong>Exportado:</strong> {result.total_pages} páginas, {(result.total_chars || 0).toLocaleString('pt-BR')} chars</div>
            <div><strong>Diretório:</strong> <code>{result.skill_dir}</code></div>
            <div><strong>Arquivos:</strong> {result.files?.join(', ')}</div>
            <div style={{ marginTop: 12 }}>
              <strong>🔗 Link público pra divulgar:</strong>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                <input
                  type="text"
                  readOnly
                  value={bookUrl(result.slug || '')}
                  style={{ flex: 1, padding: '6px 8px', fontSize: 12, fontFamily: 'monospace' }}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button className="btn btn-primary btn-sm" onClick={() => copyLink(result.slug || '')}>
                  <Copy size={14} /> Copiar
                </button>
                <a className="btn btn-sm" href={bookUrl(result.slug || '')} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} /> Abrir
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Buscar por título ou slug..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}
        />
        <button className="btn" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Atualizar
        </button>
      </div>

      <div className="admin-table">
        <table>
          <thead>
            <tr>
              <th>Livro</th>
              <th>Slug</th>
              <th>Status skill</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(b => {
              const hasSkill = slugHasSkill(b.slug) || b.skill_generated
              const isBusy = busySlug === b.slug
              return (
                <tr key={b.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {b.cover_url && <img src={b.cover_url} alt="" style={{ width: 32, height: 48, objectFit: 'cover', borderRadius: 4 }} />}
                      <div>
                        <div style={{ fontWeight: 500 }}>{b.title}</div>
                        <small style={{ color: 'var(--muted)' }}>{b.author || '—'}</small>
                      </div>
                    </div>
                  </td>
                  <td><code style={{ fontSize: 12 }}>{b.slug}</code></td>
                  <td>
                    {hasSkill ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#22c55e', fontSize: 13 }}>
                        <CheckCircle2 size={14} /> Gerada
                        {b.skill_generated_at && (
                          <small style={{ color: 'var(--muted)', marginLeft: 6 }}>
                            {new Date(b.skill_generated_at).toLocaleDateString('pt-BR')}
                          </small>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--muted)', fontSize: 13 }}>—</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => generateSkill(b.slug, b.title)}
                        disabled={isBusy}
                        title={hasSkill ? 'Sobrescrever skill existente' : 'Gerar skill nova'}
                      >
                        {isBusy ? (
                          <><RefreshCw size={14} className="spin" /> Gerando...</>
                        ) : (
                          <><Zap size={14} /> {hasSkill ? 'Regerar' : 'Gerar Skill'}</>
                        )}
                      </button>
                      {hasSkill && (
                        <a
                          className="btn btn-sm"
                          href={bookUrl(b.slug)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Abrir livro no Leitor"
                        >
                          <BookOpen size={14} />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && !loading && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>Nenhum livro encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <style>{`
        .mentor-skills-panel .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
