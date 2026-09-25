import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ExternalLink, Radio, GraduationCap, Building2, AlertCircle, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import type { TenantEdition } from '../lib/tenant'

interface Props {
  isOpen: boolean
  onClose: () => void
  onGoLogin?: () => void
  initialEdition?: TenantEdition
  initialCategoryName?: string
}

export function CreateTenantModal({ isOpen, onClose, onGoLogin, initialEdition = 'radio_embed', initialCategoryName }: Props) {
  const { isAuthenticated } = useAuth()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [edition, setEdition] = useState<TenantEdition>(initialEdition)
  const [domain, setDomain] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slugWarning, setSlugWarning] = useState<string | null>(null)
  const [createdTenant, setCreatedTenant] = useState<{ slug: string; name: string; edition: string } | null>(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedIframe, setCopiedIframe] = useState(false)

  // Trava de scroll no body enquanto o modal estiver aberto
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }
    return () => {
      document.body.style.overflow = 'unset'
    }
  }, [isOpen])

  useEffect(() => {
    if (initialEdition) {
      setEdition(initialEdition)
    }
  }, [initialEdition])

  // Resetar estados ao abrir/fechar
  useEffect(() => {
    if (isOpen) {
      setError(null)
      setSlugWarning(null)
    }
  }, [isOpen])

  // Gerador automático de slug a partir do nome
  const handleNameChange = (val: string) => {
    setName(val)
    if (!slugTouched) {
      const autoSlug = val
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 40)
      setSlug(autoSlug)
      validateSlug(autoSlug)
    }
  }

  // Validação rápida de slug local
  const validateSlug = (val: string) => {
    if (['raiz', 'devocional', 'admin', 'api', 'app'].includes(val.toLowerCase())) {
      setSlugWarning(`O slug "${val}" é reservado ou já está em uso no sistema.`)
    } else {
      setSlugWarning(null)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!isAuthenticated) {
      setError('Por favor, faça login antes de criar sua instituição para vinculá-la à sua conta de gestor.')
      return
    }

    const cleanName = name.trim()
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').trim()
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim()

    if (!cleanName) {
      setError('Informe o nome da instituição.')
      return
    }
    if (cleanSlug.length < 3) {
      setError('O identificador (slug) deve ter pelo menos 3 caracteres.')
      return
    }
    if (['raiz', 'admin', 'api', 'app'].includes(cleanSlug)) {
      setError(`O identificador "${cleanSlug}" é reservado pelo sistema. Por favor escolha outro.`)
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Verificar previamente se o slug já existe
      const { data: existing } = await supabase
        .from('tenants')
        .select('id')
        .eq('slug', cleanSlug)
        .maybeSingle()

      if (existing) {
        throw new Error(`O identificador "${cleanSlug}" já está em uso por outra instituição. Escolha outro slug.`)
      }

      // Chamada RPC atômica que cria o tenant e vincula o usuário como owner
      const { data, error: rpcError } = await supabase.rpc('create_tenant_with_owner', {
        p_name: cleanName,
        p_slug: cleanSlug,
        p_edition: edition,
        p_domain: cleanDomain || null,
      })

      if (rpcError) {
        if (rpcError.message?.includes('duplicate key') || rpcError.message?.includes('tenants_slug_key') || (rpcError as any).code === '23505') {
          throw new Error(`O identificador "${cleanSlug}" já está em uso. Escolha outro slug.`)
        }
        throw new Error(rpcError.message || 'Falha ao cadastrar instituição')
      }

      setCreatedTenant({
        slug: cleanSlug,
        name: cleanName,
        edition,
      })
    } catch (err: any) {
      setError(err?.message || 'Falha ao registrar instituição.')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null
  if (typeof document === 'undefined') return null

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://preview.automacaojs.us'
  const directLink = `${origin}/leitor-inteligente/t/${createdTenant?.slug || slug}`
  const iframeCode = `<iframe
  src="${origin}/leitor-inteligente/t/${createdTenant?.slug || slug}?mode=embed"
  width="100%"
  height="800px"
  frameborder="0"
  allow="microphone; clipboard-write"
  style="border: none; border-radius: 12px; width: 100%; min-height: 800px;"
></iframe>`

  const handleCopy = (text: string, type: 'link' | 'iframe') => {
    navigator.clipboard.writeText(text)
    if (type === 'link') {
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    } else {
      setCopiedIframe(true)
      setTimeout(() => setCopiedIframe(false), 2000)
    }
  }

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999999,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        boxSizing: 'border-box',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '520px',
          maxHeight: '90vh',
          backgroundColor: '#0f172a',
          color: '#f8fafc',
          borderRadius: '16px',
          border: '1px solid #334155',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          boxSizing: 'border-box',
        }}
      >
        {/* Cabeçalho */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid #1e293b',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#0f172a',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Building2 style={{ color: '#38bdf8', width: 22, height: 22 }} />
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: '#ffffff' }}>
              {createdTenant ? 'Instituição Pronta!' : 'Cadastrar Minha Instituição'}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: '1.6rem',
              lineHeight: 1,
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: '6px',
            }}
            aria-label="Fechar"
          >
            &times;
          </button>
        </div>

        {!isAuthenticated ? (
          <div
            style={{
              padding: '36px 24px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: '16px',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: '50%',
                backgroundColor: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38bdf8',
              }}
            >
              <Building2 style={{ width: 28, height: 28 }} />
            </div>
            <div>
              <h4 style={{ margin: '0 0 8px', fontSize: '1.15rem', color: '#f8fafc', fontWeight: 600 }}>
                Faça login para cadastrar sua Instituição
              </h4>
              <p style={{ margin: 0, fontSize: '0.88rem', color: '#94a3b8', lineHeight: 1.5, maxWidth: 420 }}>
                Para gerar o leitor white-label e o código Iframe oficial, é necessário estar conectado. Sua conta será vinculada automaticamente como o <strong>Gestor Oficial (Owner)</strong> da nova instituição.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: 12, width: '100%', maxWidth: 360 }}>
              <button
                type="button"
                onClick={async () => {
                  setLoading(true)
                  try {
                    await supabase.auth.signInWithOAuth({
                      provider: 'google',
                      options: {
                        redirectTo: window.location.href,
                      },
                    })
                  } catch (e: any) {
                    if (onGoLogin) onGoLogin()
                    else window.location.hash = '#/login'
                  } finally {
                    setLoading(false)
                  }
                }}
                style={{
                  width: '100%',
                  padding: '12px 20px',
                  backgroundColor: '#ffffff',
                  color: '#0f172a',
                  border: 'none',
                  borderRadius: '10px',
                  fontWeight: 600,
                  fontSize: '0.92rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  boxShadow: '0 4px 12px rgba(255, 255, 255, 0.15)',
                  transition: 'opacity 0.2s',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"/>
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"/>
                  <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.98 0 12s.45 3.82 1.25 5.42l4.03-3.15z"/>
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/>
                </svg>
                {loading ? 'Conectando ao Google…' : 'Entrar com Google'}
              </button>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    if (onGoLogin) onGoLogin()
                    else window.location.hash = '#/login'
                  }}
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    backgroundColor: '#1e293b',
                    color: '#cbd5e1',
                    border: '1px solid #334155',
                    borderRadius: '10px',
                    fontSize: '0.85rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Entrar com E-mail
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: 'transparent',
                    color: '#94a3b8',
                    border: '1px solid #334155',
                    borderRadius: '10px',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                  }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        ) : !createdTenant ? (
          <form
            onSubmit={handleSubmit}
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              margin: 0,
            }}
          >
            {/* Corpo com scroll */}
            <div
              style={{
                padding: '20px 24px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                flex: 1,
              }}
            >
              <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: 0, lineHeight: 1.5 }}>
                Crie um leitor white-label dedicado para sua rádio, colégio ou igreja com geração de link e código Iframe para incorporar no seu site.
              </p>

              {/* Alerta de erro visível na UI */}
              {error && (
                <div
                  style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.16)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    borderRadius: '10px',
                    padding: '12px 14px',
                    display: 'flex',
                    gap: '10px',
                    alignItems: 'flex-start',
                    color: '#fca5a5',
                    fontSize: '0.82rem',
                    lineHeight: 1.4,
                  }}
                >
                  <AlertCircle style={{ width: 18, height: 18, flexShrink: 0, color: '#f87171', marginTop: 2 }} />
                  <span>{error}</span>
                </div>
              )}

              {/* Nome */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Nome da Instituição <span style={{ color: '#38bdf8' }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Rádio Esperança FM ou Colégio Alpha"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: '10px',
                    border: '1px solid #334155',
                    backgroundColor: '#020617',
                    color: '#ffffff',
                    fontSize: '0.9rem',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
              </div>

              {/* Slug */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Identificador / Slug da URL <span style={{ color: '#38bdf8' }}>*</span>
                </label>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: '#020617',
                    border: '1px solid #334155',
                    borderRadius: '10px',
                    padding: '0 12px',
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{ color: '#64748b', fontSize: '0.82rem', userSelect: 'none' }}>/t/</span>
                  <input
                    type="text"
                    required
                    placeholder="radio-esperanca"
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true)
                      const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                      setSlug(val)
                      validateSlug(val)
                    }}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      backgroundColor: 'transparent',
                      color: '#ffffff',
                      fontSize: '0.9rem',
                      fontFamily: 'monospace',
                      border: 'none',
                      outline: 'none',
                    }}
                  />
                </div>
                {slugWarning && (
                  <p style={{ color: '#fbbf24', fontSize: '0.74rem', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <AlertCircle style={{ width: 14, height: 14 }} /> {slugWarning}
                  </p>
                )}
                <p style={{ color: '#64748b', fontSize: '0.74rem', margin: '4px 0 0 0' }}>
                  Apenas letras minúsculas, números e hífens.
                </p>
              </div>

              {/* Edição / Tipo */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '8px' }}>
                  Tipo de Solução / Edição
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <button
                    type="button"
                    onClick={() => setEdition('radio_embed')}
                    style={{
                      textAlign: 'left',
                      padding: '12px',
                      borderRadius: '10px',
                      border: edition === 'radio_embed' ? '2px solid #0284c7' : '1px solid #334155',
                      backgroundColor: edition === 'radio_embed' ? 'rgba(2, 132, 199, 0.15)' : '#020617',
                      color: '#f8fafc',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <Radio style={{ width: 16, height: 16, color: edition === 'radio_embed' ? '#38bdf8' : '#94a3b8' }} />
                      <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>Web Rádios & Igrejas</span>
                    </div>
                    <p style={{ fontSize: '0.74rem', color: '#94a3b8', margin: 0, lineHeight: 1.3 }}>
                      Player de áudio ambiente, modo embed e acervo temático.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEdition('academic_premium')}
                    style={{
                      textAlign: 'left',
                      padding: '12px',
                      borderRadius: '10px',
                      border: edition === 'academic_premium' ? '2px solid #a855f7' : '1px solid #334155',
                      backgroundColor: edition === 'academic_premium' ? 'rgba(168, 85, 247, 0.15)' : '#020617',
                      color: '#f8fafc',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <GraduationCap style={{ width: 16, height: 16, color: edition === 'academic_premium' ? '#c084fc' : '#94a3b8' }} />
                      <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>Escolas & Faculdades</span>
                    </div>
                    <p style={{ fontSize: '0.74rem', color: '#94a3b8', margin: 0, lineHeight: 1.3 }}>
                      Turmas, notas, IA e estudo em dupla integrado.
                    </p>
                  </button>
                </div>
              </div>

              {/* Domínio / Allowlist */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Domínio do seu Site (Allowlist de Iframe)
                </label>
                <input
                  type="text"
                  placeholder="ex: radioluz.com.br ou portal.escola.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: '10px',
                    border: '1px solid #334155',
                    backgroundColor: '#020617',
                    color: '#ffffff',
                    fontSize: '0.9rem',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
                <p style={{ color: '#64748b', fontSize: '0.74rem', margin: '4px 0 0 0' }}>
                  Usado na segurança do Nginx (CSP frame-ancestors) para autorizar incorporação.
                </p>
              </div>
            </div>

            {/* Rodapé com botões */}
            <div
              style={{
                padding: '16px 24px',
                borderTop: '1px solid #1e293b',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '12px',
                backgroundColor: '#0b1120',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                style={{
                  padding: '9px 18px',
                  borderRadius: '8px',
                  border: '1px solid #475569',
                  backgroundColor: 'transparent',
                  color: '#cbd5e1',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={loading}
                style={{
                  padding: '9px 22px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: loading ? '#0369a1' : '#0284c7',
                  color: '#ffffff',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: '0 4px 12px rgba(2, 132, 199, 0.4)',
                }}
              >
                {loading ? (
                  <>
                    <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
                    <span>Criando...</span>
                  </>
                ) : (
                  <span>Criar Instituição 🚀</span>
                )}
              </button>
            </div>
          </form>
        ) : (
          /* Tela de Sucesso */
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div
              style={{
                padding: '24px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                flex: 1,
              }}
            >
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: '50%',
                    backgroundColor: 'rgba(34, 197, 94, 0.2)',
                    color: '#4ade80',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '8px',
                  }}
                >
                  <Check style={{ width: 28, height: 28 }} />
                </div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0 0 4px 0', color: '#ffffff' }}>
                  Instituição Criada com Sucesso!
                </h3>
                <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: 0 }}>
                  O Leitor Inteligente de <strong style={{ color: '#ffffff' }}>{createdTenant.name}</strong> já está ativo.
                </p>
              </div>

              {/* 1. Link Direto */}
              <div
                style={{
                  backgroundColor: '#020617',
                  border: '1px solid #1e293b',
                  borderRadius: '10px',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8' }}>
                  1. Link de Acesso Canônico:
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="text"
                    readOnly
                    value={directLink}
                    style={{
                      flex: 1,
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '8px',
                      padding: '8px 10px',
                      color: '#38bdf8',
                      fontFamily: 'monospace',
                      fontSize: '0.78rem',
                      outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy(directLink, 'link')}
                    style={{
                      backgroundColor: copiedLink ? '#16a34a' : '#1e293b',
                      color: '#ffffff',
                      border: '1px solid #334155',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedLink ? <Check style={{ width: 14, height: 14, color: '#86efac' }} /> : <Copy style={{ width: 14, height: 14 }} />}
                    {copiedLink ? 'Copiado!' : 'Copiar'}
                  </button>
                  <a
                    href={directLink}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      backgroundColor: '#0284c7',
                      color: '#ffffff',
                      borderRadius: '8px',
                      padding: '8px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      textDecoration: 'none',
                    }}
                    title="Abrir em nova aba"
                  >
                    <ExternalLink style={{ width: 14, height: 14 }} />
                  </a>
                </div>
              </div>

              {/* 2. Código Iframe Embed */}
              <div
                style={{
                  backgroundColor: '#020617',
                  border: '1px solid #1e293b',
                  borderRadius: '10px',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8' }}>
                    2. Código Iframe para o seu Site:
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(iframeCode, 'iframe')}
                    style={{
                      backgroundColor: copiedIframe ? '#16a34a' : '#0284c7',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '8px',
                      padding: '6px 12px',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedIframe ? <Check style={{ width: 14, height: 14, color: '#86efac' }} /> : <Copy style={{ width: 14, height: 14 }} />}
                    {copiedIframe ? 'Copiado!' : 'Copiar Iframe'}
                  </button>
                </div>
                <textarea
                  readOnly
                  value={iframeCode}
                  rows={4}
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    color: '#a5f3fc',
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    resize: 'none',
                    outline: 'none',
                    boxSizing: 'border-box',
                    lineHeight: 1.4,
                  }}
                />
                <p style={{ color: '#64748b', fontSize: '0.72rem', margin: 0 }}>
                  Inclui permissões de microfone para interação completa com o Professor IA.
                </p>
              </div>
            </div>

            {/* Rodapé Tela Sucesso */}
            <div
              style={{
                padding: '16px 24px',
                borderTop: '1px solid #1e293b',
                display: 'flex',
                justifyContent: 'flex-end',
                backgroundColor: '#0b1120',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '9px 24px',
                  borderRadius: '8px',
                  backgroundColor: '#334155',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Concluir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
