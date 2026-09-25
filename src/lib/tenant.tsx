import React, { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { supabase } from './supabase'

export type TenantEdition = 'common' | 'radio_embed' | 'academic_premium' | 'school'

export interface TenantTheme {
  primary_color?: string
  logo_url?: string
  brand_name?: string
  favicon_url?: string
  [key: string]: any
}

export interface Tenant {
  id: string
  slug: string
  name: string
  theme: TenantTheme
  edition: TenantEdition
  type?: 'radio' | 'school' | 'common' | string
  embed_allowlist: string[]
  radio_mount?: string | null
  radio_liquidsoap_host?: string | null
  radio_liquidsoap_port?: number | null
  radio_liquidsoap_password?: string | null
  owner_user_id?: string | null
  created_at?: string
  updated_at?: string
  archived_at?: string | null
}

export interface TenantContextType {
  tenant: Tenant | null
  slug: string
  isEmbed: boolean
  isLoading: boolean
  edition: TenantEdition
  error: string | null
}

const DEFAULT_RAIZ_TENANT: Tenant = {
  id: '2656ae53-fbb0-4478-ab1a-36f3561d51df',
  slug: 'raiz',
  name: 'Leitor Raiz',
  theme: {},
  edition: 'common',
  type: 'common',
  embed_allowlist: ['self', 'leitorinteligente.automacaojs.us'],
}

/**
 * 1. Resolução de Slug do Tenant:
 *    - Path: /leitor-inteligente/t/:slug ou /t/:slug
 *    - Query param: ?tenant=:slug (no search ou hash)
 *    - Fallback: 'raiz'
 */
export function resolveTenantSlug(): string {
  if (typeof window === 'undefined') return 'raiz'

  // 1. Pathname
  const pathname = window.location.pathname || ''
  const pathMatch = pathname.match(/(?:^\/leitor-inteligente)?\/t\/([^/?#]+)/)
  if (pathMatch && pathMatch[1]) {
    return decodeURIComponent(pathMatch[1]).trim()
  }

  // 2. Query param no search (?tenant=slug)
  const searchParams = new URLSearchParams(window.location.search || '')
  const queryTenant = searchParams.get('tenant')
  if (queryTenant && queryTenant.trim()) {
    return queryTenant.trim()
  }

  // 3. Query param no hash (#/store?tenant=slug)
  if (window.location.hash && window.location.hash.includes('?')) {
    const hashQuery = window.location.hash.split('?')[1]
    const hashParams = new URLSearchParams(hashQuery)
    const hashTenant = hashParams.get('tenant')
    if (hashTenant && hashTenant.trim()) {
      return hashTenant.trim()
    }
  }

  return 'raiz'
}

/**
 * 2. Detecção de Modo Embed:
 *    - mode=embed na query (search ou hash)
 *    - ou dentro de iframe (window.self !== window.top)
 */
export function detectIsEmbed(): boolean {
  if (typeof window === 'undefined') return false

  // Checa query params no search
  const searchParams = new URLSearchParams(window.location.search || '')
  if (searchParams.get('mode') === 'embed') {
    return true
  }

  // Checa query params no hash
  if (window.location.hash && window.location.hash.includes('?')) {
    const hashQuery = window.location.hash.split('?')[1]
    const hashParams = new URLSearchParams(hashQuery)
    if (hashParams.get('mode') === 'embed') {
      return true
    }
  }

  // Checa se está rodando dentro de iframe
  try {
    if (window.self !== window.top) {
      return true
    }
  } catch (_e) {
    // Cross-origin iframe dispara SecurityError ao acessar window.top -> é embed!
    return true
  }

  return false
}

const TenantContext = createContext<TenantContextType>({
  tenant: DEFAULT_RAIZ_TENANT,
  slug: 'raiz',
  isEmbed: false,
  isLoading: false,
  edition: 'common',
  error: null,
})

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [slug] = useState<string>(() => resolveTenantSlug())
  const [isEmbed] = useState<boolean>(() => detectIsEmbed())
  const [tenant, setTenant] = useState<Tenant | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function fetchTenant() {
      setIsLoading(true)
      setError(null)
      try {
        const { data, error: sbErr } = await supabase
          .from('tenants')
          .select('*')
          .eq('slug', slug)
          .maybeSingle()

        if (sbErr) throw sbErr

        if (data) {
          if (!cancelled) setTenant(data as Tenant)
        } else if (slug !== 'raiz') {
          // Fallback para raiz caso o slug não exista
          const { data: fallbackData } = await supabase
            .from('tenants')
            .select('*')
            .eq('slug', 'raiz')
            .maybeSingle()

          if (!cancelled) {
            setTenant((fallbackData as Tenant) || DEFAULT_RAIZ_TENANT)
          }
        } else {
          if (!cancelled) setTenant(DEFAULT_RAIZ_TENANT)
        }
      } catch (err: any) {
        console.error('[TenantProvider] Falha ao carregar tenant:', err)
        if (!cancelled) {
          setError(err?.message || 'Falha ao carregar tenant')
          setTenant(DEFAULT_RAIZ_TENANT)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchTenant()

    return () => {
      cancelled = true
    }
  }, [slug])

  // Aplicação dinâmica do tema (cores e título)
  useEffect(() => {
    if (!tenant) return

    if (tenant.theme?.primary_color) {
      document.documentElement.style.setProperty('--accent', tenant.theme.primary_color)
      document.documentElement.style.setProperty('--c-primary', tenant.theme.primary_color)
    }

    if (tenant.theme?.brand_name && tenant.slug !== 'raiz') {
      document.title = `${tenant.theme.brand_name} | Leitor Inteligente`
    } else if (tenant.name && tenant.slug !== 'raiz') {
      document.title = `${tenant.name} | Leitor Inteligente`
    }
  }, [tenant])

  const value = useMemo<TenantContextType>(() => {
    const current = tenant || DEFAULT_RAIZ_TENANT
    return {
      tenant: current,
      slug,
      isEmbed,
      isLoading,
      edition: current.edition || 'common',
      error,
    }
  }, [tenant, slug, isEmbed, isLoading, error])

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}

export function useTenant(): TenantContextType {
  return useContext(TenantContext)
}
