import React, { useState, useEffect, useMemo } from 'react'
import {
  GraduationCap,
  Users,
  Award,
  Percent,
  Download,
  RefreshCw,
  BookOpen,
  Search,
  ArrowLeft,
  Radio,
  ExternalLink,
  ChevronDown,
  Calendar,
  Filter,
  FileSpreadsheet,
  X,
  Printer,
  Sparkles,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useTenant } from '../lib/tenant'
import { useAuth } from '../lib/AuthContext'
import { BASE_URL } from '../lib/baseUrl'
import { showToast } from '../lib/toast'
import { isAdminEmail, isAdminUser } from '../lib/admin'
import { getFormativeGrade } from '../lib/academic'
import { AcademicReportPrintModal } from '../components/AcademicReportPrintModal'
import type { Route } from '../App'

interface ActiveRoomPeer {
  name: string
  user_id?: string
  is_host?: boolean
  page?: number
  score?: number
}

interface ActiveRoom {
  room_id: string
  alive: boolean
  peer_count: number
  host_online: boolean
  host_user_id?: string
  host_name?: string
  book_id?: string
  book_title?: string
  current_page?: number
  total_score?: number
  tenant_id?: string
  peers: ActiveRoomPeer[]
  created_at?: number
  last_active?: number
}

interface SubmissionRow {
  id: string
  user_id: string | null
  score: number
  total_questions: number
  correct_answers: number
  passed: boolean
  completed_at: string
  ebook_id: string
  assessment_id?: string
  room_id?: string
  ebook_title?: string
  student_name?: string
  student_email?: string
  chapter_title?: string
  page_range?: string
  student_identifier?: string
  answers?: Record<number, number>
}

interface AssessmentBlock {
  key: string
  ebookId: string
  ebookTitle: string
  chapterTitle: string
  pageRange?: string
  date: string
  dateFormatted: string
  roomId?: string
  assessmentId?: string
  submissions: SubmissionRow[]
  totalEvaluated: number
  passedCount: number
  failedCount: number
  averageScore: number
  passRate: number
  formativeDistribution: {
    pleno: number
    bom: number
    evolucao: number
    atencao: number
  }
}

interface Props {
  onNavigate: (route: Route, bookId?: string) => void
}

export function AcademicManagerPage({ onNavigate }: Props) {
  const { tenant, isLoading: tenantLoading } = useTenant()
  const { user, isAuthenticated, isReady } = useAuth()

  // 1. Blindagem de Acesso
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [authorized, setAuthorized] = useState(false)

  // 2. Dados
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([])
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingRooms, setLoadingRooms] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 3. Filtros da Barra de Ferramentas
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedDate, setSelectedDate] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'pleno' | 'bom' | 'evolucao' | 'atencao' | 'passed' | 'failed'>('all')

  // 4. Controle de Expansão dos Blocos
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>({})

  // 5. Emissão e Impressão de Comprovante / Boletim
  const [printSubmission, setPrintSubmission] = useState<{
    submission: SubmissionRow
    assessmentQuestions?: any[]
  } | null>(null)
  const [assessmentsQuestionsMap, setAssessmentsQuestionsMap] = useState<Map<string, any[]>>(new Map())

  // Verificação de permissões do gestor acadêmico
  useEffect(() => {
    if (!isReady || tenantLoading) return

    let cancelled = false

    async function checkPermission() {
      // 1.1 Não autenticado -> Bloqueio imediato
      if (!isAuthenticated || !user?.id) {
        if (!cancelled) {
          showToast('Acesso restrito à coordenação pedagógica', 'warning')
          onNavigate('library')
        }
        return
      }

      // 1.2 Super Admin Global (brisacamera34, geminijose356 ou admin configurado)
      const email = (user.email || '').toLowerCase().trim()
      const isGlobalAdmin =
        email === 'geminijose356@gmail.com' ||
        email.includes('brisacamera34') ||
        isAdminEmail(user.email) ||
        isAdminUser(user)

      if (isGlobalAdmin) {
        if (!cancelled) {
          setAuthorized(true)
          setCheckingAuth(false)
        }
        return
      }

      // 1.3 Dono direto do tenant
      if (tenant?.owner_user_id && tenant.owner_user_id === user.id) {
        if (!cancelled) {
          setAuthorized(true)
          setCheckingAuth(false)
        }
        return
      }

      // 1.4 Papel 'owner' ou 'admin' na tabela user_tenants
      if (tenant?.id) {
        try {
          const { data } = await supabase
            .from('user_tenants')
            .select('role')
            .eq('user_id', user.id)
            .eq('tenant_id', tenant.id)
            .maybeSingle()

          if (data && (data.role === 'owner' || data.role === 'admin')) {
            if (!cancelled) {
              setAuthorized(true)
              setCheckingAuth(false)
            }
            return
          }
        } catch (err) {
          console.warn('[AcademicManagerPage] Erro ao validar user_tenants:', err)
        }
      }

      // Sem autorização
      if (!cancelled) {
        showToast('Acesso restrito à coordenação pedagógica', 'warning')
        onNavigate('library')
      }
    }

    checkPermission()

    return () => {
      cancelled = true
    }
  }, [isReady, tenantLoading, isAuthenticated, user?.id, tenant?.id, tenant?.owner_user_id, onNavigate])

  useEffect(() => {
    if (!authorized || !tenant?.id) return
    loadSubmissions()
    fetchActiveRooms()
  }, [authorized, tenant?.id])

  // Listener Realtime para submissões acadêmicas e avaliações + polling das salas
  useEffect(() => {
    if (!authorized || !tenant?.id) return

    const channel = supabase
      .channel(`academic-channel-${tenant.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'academic_submissions',
          filter: `tenant_id=eq.${tenant.id}`,
        },
        () => {
          loadSubmissions()
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'academic_evaluations',
          filter: `tenant_id=eq.${tenant.id}`,
        },
        () => {
          fetchActiveRooms()
        }
      )
      .subscribe()

    // Polling regular a cada 5s para refletir entrada/saída de alunos em tempo real
    const roomInterval = setInterval(() => {
      fetchActiveRooms()
    }, 5000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(roomInterval)
    }
  }, [authorized, tenant?.id])

  const loadSubmissions = async () => {
    if (!tenant?.id) return
    setLoading(true)
    setError(null)

    try {
      // 1. Carregar submissões da instituição com colunas pedagógicas e escopo de capítulo
      const { data: subs, error: subErr } = await supabase
        .from('academic_submissions')
        .select(`
          id,
          user_id,
          assessment_id,
          room_id,
          score,
          total_questions,
          correct_answers,
          passed,
          completed_at,
          ebook_id,
          student_name,
          student_identifier,
          chapter_title,
          page_range,
          answers
        `)
        .eq('tenant_id', tenant.id)
        .order('completed_at', { ascending: false })

      if (subErr) throw subErr

      // 2. Carregar avaliações oficiais para disponibilizar questões no boletim impresso
      const { data: assessList } = await supabase
        .from('academic_assessments')
        .select('id, ebook_id, chapter_title, questions')
        .eq('tenant_id', tenant.id)

      const aMap = new Map<string, any[]>()
      assessList?.forEach((a: any) => {
        if (a.id) aMap.set(a.id, a.questions)
        if (a.ebook_id && a.chapter_title) {
          aMap.set(`${a.ebook_id}_${a.chapter_title}`, a.questions)
        }
      })
      setAssessmentsQuestionsMap(aMap)

      // 3. Carregar títulos dos livros para cruzar (por UUID ou slug)
      const { data: ebooks } = await supabase
        .from('ebooks')
        .select('id, slug, title')

      const ebookMap = new Map<string, string>()
      ebooks?.forEach((b: any) => {
        ebookMap.set(b.id, b.title)
        if (b.slug) ebookMap.set(b.slug, b.title)
      })

      // Monta as linhas enriquecidas
      const rows: SubmissionRow[] = (subs || []).map((s: any) => {
        let name = s.student_name
        let email = s.student_identifier

        if (!name) {
          if (s.user_id && s.user_id === user?.id) {
            name = user.name || user.email?.split('@')[0] || 'Estudante'
            email = user.email || s.user_id
          } else if (s.user_id) {
            name = `Estudante (${s.user_id.slice(0, 6)})`
            email = `Aluno #${s.user_id.slice(0, 8)}`
          } else {
            name = 'Estudante'
            email = s.student_identifier || 'Sessão Individual'
          }
        }

        return {
          ...s,
          score: Number(s.score),
          ebook_title: ebookMap.get(s.ebook_id) || 'Livro / Material Oficial',
          chapter_title: s.chapter_title || 'Capítulo Geral',
          page_range: s.page_range,
          student_email: email || '',
          student_name: name || 'Aluno',
          answers: s.answers || {},
        }
      })

      setSubmissions(rows)
    } catch (e: any) {
      setError(e.message || 'Falha ao carregar dados acadêmicos.')
    } finally {
      setLoading(false)
    }
  }

  const fetchActiveRooms = async () => {
    setLoadingRooms(true)
    try {
      const isDev = typeof window !== 'undefined' && window.location.port === '5173'
      const collabUrl = isDev
        ? 'http://127.0.0.1:2006/collab/rooms'
        : `${BASE_URL}ws/collab/rooms`

      const tenantParam = tenant?.id ? `?tenant_id=${encodeURIComponent(tenant.id)}` : ''
      const res = await fetch(`${collabUrl}${tenantParam}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })

      let rooms: ActiveRoom[] = []
      if (res.ok) {
        const json = await res.json()
        rooms = json.rooms || []
      }

      if (rooms.length > 0) {
        const roomIds = rooms.map((r) => r.room_id)
        const { data: evals } = await supabase
          .from('academic_evaluations')
          .select('room_id, total_score, book_id')
          .in('room_id', roomIds)

        const scoreByRoom = new Map<string, number>()
        evals?.forEach((ev: any) => {
          scoreByRoom.set(ev.room_id, (scoreByRoom.get(ev.room_id) || 0) + (ev.total_score || 0))
        })

        const bookIdsToFetch = rooms
          .filter((r) => (!r.book_title || r.book_title === 'Material / E-book') && r.book_id)
          .map((r) => r.book_id as string)

        const bookNameMap = new Map<string, string>()
        if (bookIdsToFetch.length > 0) {
          const { data: booksData } = await supabase
            .from('ebooks')
            .select('id, slug, title')

          booksData?.forEach((b: any) => {
            bookNameMap.set(b.id, b.title)
            if (b.slug) bookNameMap.set(b.slug, b.title)
          })
        }

        rooms = rooms.map((r) => ({
          ...r,
          book_title:
            r.book_title && r.book_title !== 'Material / E-book'
              ? r.book_title
              : r.book_id
              ? bookNameMap.get(r.book_id) || r.book_id
              : 'Material / Livro de Estudo',
          total_score: (r.total_score || 0) + (scoreByRoom.get(r.room_id) || 0),
        }))
      }

      setActiveRooms(rooms)
    } catch (err) {
      console.warn('[AcademicManagerPage] Erro ao buscar salas ativas:', err)
      setActiveRooms([])
    } finally {
      setLoadingRooms(false)
    }
  }

  const handleRefreshAll = async () => {
    await Promise.all([loadSubmissions(), fetchActiveRooms()])
  }

  // Filtragem com Barra de Ferramentas (Texto, Data, Status / Conceito)
  const filteredSubmissions = useMemo(() => {
    return submissions.filter((s) => {
      // 1. Busca por texto (aluno, e-mail/identificador, livro, capítulo)
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase().trim()
        const matchName = (s.student_name || '').toLowerCase().includes(term)
        const matchEmail = (s.student_email || '').toLowerCase().includes(term)
        const matchBook = (s.ebook_title || '').toLowerCase().includes(term)
        const matchChapter = (s.chapter_title || '').toLowerCase().includes(term)
        if (!matchName && !matchEmail && !matchBook && !matchChapter) return false
      }

      // 2. Filtro por Data
      if (selectedDate) {
        const subDate = new Date(s.completed_at)
        const yyyy = subDate.getFullYear()
        const mm = String(subDate.getMonth() + 1).padStart(2, '0')
        const dd = String(subDate.getDate()).padStart(2, '0')
        const localDateStr = `${yyyy}-${mm}-${dd}`
        if (localDateStr !== selectedDate) return false
      }

      // 3. Filtro por Conceito Formativo ou Status
      if (statusFilter !== 'all') {
        const concept = getFormativeGrade(s.score).key
        if (statusFilter === 'passed' && !s.passed) return false
        if (statusFilter === 'failed' && s.passed) return false
        if (['pleno', 'bom', 'evolucao', 'atencao'].includes(statusFilter) && concept !== statusFilter) {
          return false
        }
      }

      return true
    })
  }, [submissions, searchTerm, selectedDate, statusFilter])

  // Estruturação em Blocos de Avaliação / Sessões por Livro + Capítulo + Sala + Data
  const assessmentBlocks = useMemo<AssessmentBlock[]>(() => {
    const blocksMap = new Map<string, AssessmentBlock>()

    for (const s of filteredSubmissions) {
      const d = new Date(s.completed_at)
      const dateFormatted = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
      const dateIso = d.toISOString().slice(0, 10)
      const scope =
        s.page_range?.trim() ||
        (s.chapter_title?.trim().startsWith('Página')
          ? s.chapter_title?.trim()
          : (s.chapter_title?.trim() ? `Páginas ${s.chapter_title.trim()}` : 'Páginas 1 a 10'))
      const roomKey = s.room_id ? `room_${s.room_id}` : (s.assessment_id ? `assess_${s.assessment_id}` : 'default')
      const blockKey = `${s.ebook_id}_${dateIso}_${scope}_${roomKey}`

      if (!blocksMap.has(blockKey)) {
        blocksMap.set(blockKey, {
          key: blockKey,
          ebookId: s.ebook_id,
          ebookTitle: s.ebook_title || 'Livro / Material Oficial',
          chapterTitle: scope,
          pageRange: scope,
          date: dateIso,
          dateFormatted,
          roomId: s.room_id,
          assessmentId: s.assessment_id,
          submissions: [],
          totalEvaluated: 0,
          passedCount: 0,
          failedCount: 0,
          averageScore: 0,
          passRate: 0,
          formativeDistribution: { pleno: 0, bom: 0, evolucao: 0, atencao: 0 },
        })
      }

      const blk = blocksMap.get(blockKey)!
      blk.submissions.push(s)
    }

    const result: AssessmentBlock[] = []
    blocksMap.forEach((blk) => {
      blk.submissions.sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
      blk.totalEvaluated = blk.submissions.length
      blk.passedCount = blk.submissions.filter((s) => s.passed).length
      blk.failedCount = blk.totalEvaluated - blk.passedCount
      const totalScore = blk.submissions.reduce((acc, curr) => acc + curr.score, 0)
      blk.averageScore = Number((totalScore / blk.totalEvaluated).toFixed(1))
      blk.passRate = Number(((blk.passedCount / blk.totalEvaluated) * 100).toFixed(1))

      let pleno = 0
      let bom = 0
      let evolucao = 0
      let atencao = 0
      for (const s of blk.submissions) {
        const k = getFormativeGrade(s.score).key
        if (k === 'pleno') pleno++
        else if (k === 'bom') bom++
        else if (k === 'evolucao') evolucao++
        else atencao++
      }
      blk.formativeDistribution = { pleno, bom, evolucao, atencao }

      result.push(blk)
    })

    // Ordena blocos do mais recente para o mais antigo
    result.sort((a, b) => {
      const timeA = a.submissions[0] ? new Date(a.submissions[0].completed_at).getTime() : 0
      const timeB = b.submissions[0] ? new Date(b.submissions[0].completed_at).getTime() : 0
      return timeB - timeA
    })

    return result
  }, [filteredSubmissions])

  // Alternar expandir/recolher bloco
  const toggleBlock = (blockKey: string) => {
    setCollapsedBlocks((prev) => ({
      ...prev,
      [blockKey]: !prev[blockKey],
    }))
  }

  // Alternar todos os blocos
  const allCollapsed = assessmentBlocks.length > 0 && assessmentBlocks.every((b) => !!collapsedBlocks[b.key])
  const toggleAllBlocks = () => {
    if (allCollapsed) {
      setCollapsedBlocks({})
    } else {
      const nextCollapsed: Record<string, boolean> = {}
      assessmentBlocks.forEach((b) => {
        nextCollapsed[b.key] = true
      })
      setCollapsedBlocks(nextCollapsed)
    }
  }

  // Métricas gerais calculadas a partir dos dados formativos ativos
  const metrics = useMemo(() => {
    const total = filteredSubmissions.length
    if (total === 0) {
      return {
        totalStudents: 0,
        totalEvaluations: 0,
        averageScore: 0,
        dominioRate: 0,
        dominioCount: 0,
        distribution: { pleno: 0, bom: 0, evolucao: 0, atencao: 0 },
      }
    }

    const uniqueStudents = new Set(
      filteredSubmissions.map((s) => s.user_id || s.student_name || s.id)
    ).size
    const sumScores = filteredSubmissions.reduce((acc, curr) => acc + curr.score, 0)

    let pleno = 0
    let bom = 0
    let evolucao = 0
    let atencao = 0

    for (const s of filteredSubmissions) {
      const k = getFormativeGrade(s.score).key
      if (k === 'pleno') pleno++
      else if (k === 'bom') bom++
      else if (k === 'evolucao') evolucao++
      else atencao++
    }

    const dominioCount = pleno + bom
    const averageScore = Number((sumScores / total).toFixed(1))
    const dominioRate = Number(((dominioCount / total) * 100).toFixed(1))

    return {
      totalStudents: uniqueStudents,
      totalEvaluations: total,
      averageScore,
      dominioRate,
      dominioCount,
      distribution: { pleno, bom, evolucao, atencao },
    }
  }, [filteredSubmissions])

  // Ação de Impressão do Comprovante / Boletim Oficial
  const handlePrintStudentBulletin = (sub: SubmissionRow) => {
    let qs: any[] | undefined = undefined
    if (sub.assessment_id && assessmentsQuestionsMap.has(sub.assessment_id)) {
      qs = assessmentsQuestionsMap.get(sub.assessment_id)
    } else if (sub.ebook_id && sub.chapter_title && assessmentsQuestionsMap.has(`${sub.ebook_id}_${sub.chapter_title}`)) {
      qs = assessmentsQuestionsMap.get(`${sub.ebook_id}_${sub.chapter_title}`)
    }
    setPrintSubmission({
      submission: sub,
      assessmentQuestions: qs,
    })
  }

  // Exportar relatório em CSV com UTF-8 BOM para Excel
  const handleExportCSV = (specificSubmissions?: SubmissionRow[], filenameSuffix?: string) => {
    const dataToExport = specificSubmissions || filteredSubmissions
    if (dataToExport.length === 0) {
      alert('Nenhum dado avaliativo para exportar.')
      return
    }

    const headers = [
      'Data e Hora',
      'Aluno',
      'Matrícula / CPF',
      'Livro / Disciplina',
      'Capítulo / Escopo',
      'Sala / Sessão',
      'Nota',
      'Conceito Pedagógico',
      'Acertos',
      'Erros',
      'Total',
    ]

    const rows = dataToExport.map((s) => {
      const erros = s.total_questions - s.correct_answers
      const sala = s.room_id ? `Sala ${s.room_id}` : (s.assessment_id ? `Sessão ${s.assessment_id.slice(0, 8)}` : 'Individual')
      const formativo = getFormativeGrade(s.score)
      return [
        new Date(s.completed_at).toLocaleString('pt-BR'),
        `"${(s.student_name || '').replace(/"/g, '""')}"`,
        `"${(s.student_email || s.student_identifier || '').replace(/"/g, '""')}"`,
        `"${(s.ebook_title || '').replace(/"/g, '""')}"`,
        `"${(s.chapter_title || 'Capítulo Geral').replace(/"/g, '""')}"`,
        `"${sala.replace(/"/g, '""')}"`,
        s.score.toFixed(1).replace('.', ','),
        `"${formativo.label}"`,
        s.correct_answers,
        erros,
        s.total_questions,
      ]
    })

    const csvContent = '\uFEFF' + [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeSuffix = filenameSuffix ? `-${filenameSuffix}` : `-${new Date().toISOString().slice(0, 10)}`
    a.download = `relatorio-academico-${tenant?.slug || 'turma'}${safeSuffix}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Estado de carregamento ou verificação de acesso
  if (checkingAuth) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 20px', color: 'var(--muted)' }}>
        <RefreshCw size={28} className="animate-spin" style={{ margin: '0 auto 12px', color: '#c084fc' }} />
        <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Verificando credenciais pedagógicas...</p>
      </div>
    )
  }

  if (!authorized) {
    return null
  }

  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 0' }}>
      {/* Topo do Painel */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onNavigate('library')}
            style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}
            title="Voltar para a Biblioteca"
          >
            <ArrowLeft size={16} />
            Voltar
          </button>
          <div>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <GraduationCap style={{ color: '#c084fc' }} />
              Painel do Gestor Acadêmico
            </h2>
            <small style={{ color: 'var(--muted)' }}>
              {tenant?.name || 'Instituição'} • Monitoramento de Salas de Aula, Avaliações e Boletim
            </small>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleRefreshAll}
            disabled={loading || loadingRooms}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={14} className={loading || loadingRooms ? 'animate-spin' : ''} />
            Atualizar
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => handleExportCSV()}
            disabled={filteredSubmissions.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              backgroundColor: '#9333ea',
              color: '#ffffff',
              fontWeight: 600,
              border: 'none',
              padding: '8px 16px',
              borderRadius: 8,
              cursor: filteredSubmissions.length === 0 ? 'not-allowed' : 'pointer',
              opacity: filteredSubmissions.length === 0 ? 0.6 : 1,
            }}
            title="Exportar dados filtrados no formato CSV"
          >
            <Download size={16} />
            Exportar Relatório (.CSV)
          </button>
        </div>
      </div>

      {/* SEÇÃO: SALAS DE AULA EM ANDAMENTO (AO VIVO) */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Radio
              size={20}
              style={{ color: activeRooms.length > 0 ? '#22c55e' : 'var(--muted)' }}
              className={activeRooms.length > 0 ? 'animate-pulse' : ''}
            />
            <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 8 }}>
              📡 Salas de Aula em Andamento (Ao Vivo)
              {activeRooms.length > 0 && (
                <span
                  style={{
                    backgroundColor: 'rgba(34, 197, 94, 0.2)',
                    color: '#22c55e',
                    border: '1px solid #22c55e',
                    fontSize: '0.75rem',
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontWeight: 700,
                  }}
                >
                  {activeRooms.length} {activeRooms.length === 1 ? 'sala ativa' : 'salas ativas'}
                </span>
              )}
            </h3>
          </div>
        </div>

        {/* Se NÃO houver sala ativa */}
        {activeRooms.length === 0 && (
          <div
            style={{
              padding: '24px 28px',
              borderRadius: 16,
              backgroundColor: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  backgroundColor: 'rgba(148, 163, 184, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--muted)',
                }}
              >
                <Users size={22} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      backgroundColor: 'rgba(148, 163, 184, 0.15)',
                      color: 'var(--muted)',
                      border: '1px solid rgba(148, 163, 184, 0.3)',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#94a3b8' }} />
                    Nenhuma sala ativa no momento
                  </span>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: 'var(--muted)' }}>
                  As salas colaborativas de estudo abertas por professores ou grupos de alunos aparecerão aqui automaticamente com monitoramento em tempo real.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Se HOUVER sala ativa */}
        {activeRooms.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {activeRooms.map((room) => (
              <div
                key={room.room_id}
                style={{
                  padding: 24,
                  borderRadius: 18,
                  backgroundColor: 'var(--bg-elev)',
                  border: '1px solid rgba(34, 197, 94, 0.4)',
                  boxShadow: '0 8px 32px -4px rgba(34, 197, 94, 0.12)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 3,
                    background: 'linear-gradient(90deg, #22c55e 0%, #10b981 50%, #38bdf8 100%)',
                  }}
                />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 12px',
                        borderRadius: 999,
                        fontSize: '0.82rem',
                        fontWeight: 700,
                        backgroundColor: 'rgba(34, 197, 94, 0.18)',
                        color: '#22c55e',
                        border: '1px solid #22c55e',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: '#22c55e',
                          boxShadow: '0 0 8px #22c55e',
                        }}
                      />
                      Ao Vivo
                    </div>
                    <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--fg)' }}>
                      ID da Sala: <strong style={{ color: '#38bdf8', fontFamily: 'monospace' }}>{room.room_id}</strong>
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const bookTarget = room.book_id || 'livro'
                      window.location.hash = `#/reader/${bookTarget}?room=${room.room_id}`
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 20px',
                      borderRadius: 10,
                      background: 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)',
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: '0.88rem',
                      border: 'none',
                      cursor: 'pointer',
                      boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)',
                      transition: 'transform 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px) scale(1.02)')}
                    onMouseLeave={(e) => (e.currentTarget.style.transform = 'translateY(0) scale(1)')}
                  >
                    <ExternalLink size={16} />
                    Entrar na Sala como Tutor/Observador
                  </button>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: 16,
                    padding: '14px 18px',
                    borderRadius: 12,
                    backgroundColor: 'rgba(15, 23, 42, 0.4)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>
                      Livro em Estudo
                    </div>
                    <div style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <BookOpen size={16} style={{ color: '#38bdf8', flexShrink: 0 }} />
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {room.book_title || 'Material Didático'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>
                      Página corrente: <strong style={{ color: '#ffffff' }}>{room.current_page || 1}</strong>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>
                      Gestor / Anfitrião
                    </div>
                    <div style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <GraduationCap size={18} style={{ color: '#c084fc', flexShrink: 0 }} />
                      <span>{room.host_name || 'Tutor Responsável'}</span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: room.host_online ? '#22c55e' : '#f59e0b', marginTop: 2 }}>
                      {room.host_online ? '● Tutor Online' : '○ Tutor ausente (sala em estudo)'}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>
                      Pontuação Gamificada Acumulada
                    </div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Award size={20} style={{ color: '#f59e0b' }} />
                      <span>{room.total_score || 0}</span>
                      <span style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 600 }}>pts da turma</span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>
                      {room.peer_count} {room.peer_count === 1 ? 'estudante ativo' : 'estudantes ativos'}
                    </div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Users size={15} />
                    Participantes Online ({room.peers?.length || 0}):
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {room.peers?.map((peer, pIdx) => {
                      const isHost = peer.is_host || (room.host_user_id && peer.user_id === room.host_user_id)
                      const displayName = isHost ? `${peer.name} (Anfitrião)` : peer.name

                      return (
                        <div
                          key={pIdx}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 12px',
                            borderRadius: 999,
                            fontSize: '0.82rem',
                            fontWeight: 600,
                            backgroundColor: isHost ? 'rgba(168, 85, 247, 0.15)' : 'rgba(56, 189, 248, 0.12)',
                            color: isHost ? '#c084fc' : '#38bdf8',
                            border: `1px solid ${isHost ? 'rgba(168, 85, 247, 0.4)' : 'rgba(56, 189, 248, 0.3)'}`,
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              backgroundColor: isHost ? '#a855f7' : '#38bdf8',
                            }}
                          />
                          <span>{displayName}</span>
                          {typeof peer.score === 'number' && peer.score > 0 && (
                            <span style={{ fontSize: '0.72rem', opacity: 0.8, backgroundColor: 'rgba(0,0,0,0.2)', padding: '1px 5px', borderRadius: 4 }}>
                              +{peer.score}pts
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KPI Cards / Métricas */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <div className="kpi-card" style={{ padding: 20, borderRadius: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#38bdf8', marginBottom: 8 }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' }}>Total de Alunos Avaliados</span>
            <Users size={20} />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--fg)' }}>
            {metrics.totalStudents}
          </div>
          <small style={{ color: 'var(--muted)' }}>{metrics.totalEvaluations} avaliações entregues</small>
        </div>

        <div className="kpi-card" style={{ padding: 20, borderRadius: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#c084fc', marginBottom: 8 }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' }}>Média Geral da Turma</span>
            <Award size={20} />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--fg)' }}>
            {metrics.averageScore.toFixed(1)} <span style={{ fontSize: '1rem', color: 'var(--muted)' }}>/ 10.0</span>
          </div>
          <small style={{ color: 'var(--muted)' }}>Média ponderada das provas</small>
        </div>

        <div className="kpi-card" style={{ padding: 20, borderRadius: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#22c55e', marginBottom: 8 }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' }}>Índice de Domínio</span>
            <Percent size={20} />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--fg)' }}>
            {metrics.dominioRate}%
          </div>
          <small style={{ color: 'var(--muted)' }}>{metrics.dominioCount} alunos com Domínio Pleno ou Bom Desempenho (≥ 7.0)</small>
        </div>
      </div>

      {/* DISTRIBUIÇÃO FORMATIVA DE NOTAS */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
          marginBottom: 36,
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 12,
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            border: '1px solid rgba(34, 197, 94, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#4ade80' }}>🟢 Domínio Pleno (8.5 - 10)</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ffffff', marginTop: 2 }}>
              {metrics.distribution.pleno}{' '}
              <span style={{ fontSize: '0.8rem', color: '#86efac', fontWeight: 500 }}>
                ({((metrics.distribution.pleno / (filteredSubmissions.length || 1)) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 12,
            backgroundColor: 'rgba(56, 189, 248, 0.1)',
            border: '1px solid rgba(56, 189, 248, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#38bdf8' }}>🔵 Bom Desempenho (7.0 - 8.4)</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ffffff', marginTop: 2 }}>
              {metrics.distribution.bom}{' '}
              <span style={{ fontSize: '0.8rem', color: '#7dd3fc', fontWeight: 500 }}>
                ({((metrics.distribution.bom / (filteredSubmissions.length || 1)) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 12,
            backgroundColor: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#facc15' }}>🟡 Em Evolução (5.0 - 6.9)</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ffffff', marginTop: 2 }}>
              {metrics.distribution.evolucao}{' '}
              <span style={{ fontSize: '0.8rem', color: '#fde047', fontWeight: 500 }}>
                ({((metrics.distribution.evolucao / (filteredSubmissions.length || 1)) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 12,
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f87171' }}>🔴 Atenção Pedagógica (0 - 4.9)</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ffffff', marginTop: 2 }}>
              {metrics.distribution.atencao}{' '}
              <span style={{ fontSize: '0.8rem', color: '#fca5a5', fontWeight: 500 }}>
                ({((metrics.distribution.atencao / (filteredSubmissions.length || 1)) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* BARRA DE FERRAMENTAS COM FILTROS */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 24,
          flexWrap: 'wrap',
          alignItems: 'center',
          backgroundColor: 'var(--bg-elev)',
          padding: '14px 18px',
          borderRadius: 16,
          border: '1px solid var(--border)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        }}
      >
        {/* 1. Busca por Texto */}
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--muted)' }} />
          <input
            type="text"
            placeholder="Buscar por aluno, e-mail ou livro..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '9px 32px 9px 36px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              backgroundColor: 'rgba(15, 23, 42, 0.6)',
              color: 'var(--fg)',
              fontSize: '0.88rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              style={{
                position: 'absolute',
                right: 10,
                top: 9,
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                display: 'flex',
                padding: 2,
              }}
              title="Limpar busca"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* 2. Filtro por Data */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Calendar size={15} style={{ position: 'absolute', left: 10, color: 'var(--muted)', pointerEvents: 'none' }} />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              title="Filtrar por dia da prova"
              style={{
                padding: '9px 12px 9px 32px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                backgroundColor: 'rgba(15, 23, 42, 0.6)',
                color: 'var(--fg)',
                fontSize: '0.85rem',
                outline: 'none',
                cursor: 'pointer',
              }}
            />
          </div>
          {selectedDate && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSelectedDate('')}
              style={{ fontSize: '0.8rem', padding: '6px 10px', height: 36 }}
              title="Mostrar todas as datas"
            >
              Todas as datas
            </button>
          )}
        </div>

        {/* 3. Filtro por Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Filter size={15} style={{ color: 'var(--muted)' }} />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            style={{
              padding: '9px 12px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              backgroundColor: 'rgba(15, 23, 42, 0.6)',
              color: 'var(--fg)',
              fontSize: '0.85rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="all">Conceitos: Todos</option>
            <option value="pleno">🟢 Domínio Pleno (8.5 a 10.0)</option>
            <option value="bom">🔵 Bom Desempenho (7.0 a 8.4)</option>
            <option value="evolucao">🟡 Em Evolução (5.0 a 6.9)</option>
            <option value="atencao">🔴 Atenção Pedagógica (0.0 a 4.9)</option>
          </select>
        </div>

        {/* Botão de Expandir/Recolher Todos */}
        {assessmentBlocks.length > 0 && (
          <div style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={toggleAllBlocks}
              style={{
                fontSize: '0.8rem',
                padding: '6px 12px',
                color: 'var(--muted)',
                fontWeight: 600,
              }}
            >
              {allCollapsed ? 'Expandir Todos os Blocos' : 'Recolher Todos os Blocos'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: 14, borderRadius: 10, backgroundColor: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#fca5a5', marginBottom: 20 }}>
          {error}
        </div>
      )}

      {/* VISUALIZAÇÃO POR BLOCOS DE AVALIAÇÃO / SESSÕES */}
      {!loading && assessmentBlocks.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--bg-elev)', borderRadius: 16, border: '1px dashed var(--line)' }}>
          <BookOpen size={48} style={{ color: 'var(--muted)', margin: '0 auto 16px' }} />
          <h3 style={{ margin: '0 0 8px' }}>
            {submissions.length === 0
              ? 'Nenhuma avaliação realizada ainda'
              : 'Nenhuma avaliação encontrada com os filtros selecionados'}
          </h3>
          <p style={{ color: 'var(--muted)', maxWidth: 460, margin: '0 auto' }}>
            {submissions.length === 0
              ? 'Assim que os alunos concluírem as provas oficiais dos livros no Leitor, os blocos de avaliação aparecerão estruturados aqui.'
              : 'Tente ajustar os termos da busca, a data da prova ou o status de aprovação na barra de filtros acima.'}
          </p>
          {(searchTerm || selectedDate || statusFilter !== 'all') && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSearchTerm('')
                setSelectedDate('')
                setStatusFilter('all')
              }}
              style={{ marginTop: 16 }}
            >
              Limpar Todos os Filtros
            </button>
          )}
        </div>
      )}

      {!loading && assessmentBlocks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {assessmentBlocks.map((block) => {
            const isCollapsed = !!collapsedBlocks[block.key]

            return (
              <div
                key={block.key}
                style={{
                  borderRadius: 16,
                  backgroundColor: 'var(--bg-elev)',
                  border: '1px solid rgba(139, 92, 246, 0.25)',
                  overflow: 'hidden',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
                  transition: 'border-color 0.2s ease',
                }}
              >
                {/* CABEÇALHO DO BLOCO */}
                <div
                  style={{
                    padding: '18px 22px',
                    backgroundColor: 'rgba(30, 27, 75, 0.92)',
                    borderBottom: isCollapsed ? 'none' : '1px solid rgba(139, 92, 246, 0.35)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 14,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  onClick={() => toggleBlock(block.key)}
                >
                  {/* Informações Principais do Bloco */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 12,
                        backgroundColor: '#2e1065',
                        border: '1px solid #7c3aed',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#c084fc',
                        flexShrink: 0,
                      }}
                    >
                      <BookOpen size={20} />
                    </div>

                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '1.08rem', fontWeight: 700, color: '#ffffff' }}>
                          Bloco: &ldquo;{block.ebookTitle}&rdquo;
                        </span>
                        {/* BADGE DE INTERVALO DE PÁGINAS COM CONTRASTE NÍTIDO */}
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '4px 12px',
                            borderRadius: 8,
                            backgroundColor: '#0f172a',
                            color: '#e9d5ff',
                            border: '1px solid #7c3aed',
                            fontSize: '0.84rem',
                            fontWeight: 700,
                            letterSpacing: '0.02em',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                          }}
                        >
                          📖 {block.pageRange || (block.chapterTitle.startsWith('Página') ? block.chapterTitle : `Páginas ${block.chapterTitle}`)}
                        </span>
                      </div>

                      {/* METADADOS COM ALTO CONTRASTE */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8, fontSize: '0.85rem', color: '#e2e8f0' }}>
                        <span>• Data: <strong style={{ color: '#ffffff', fontWeight: 600 }}>{block.dateFormatted}</strong></span>
                        {block.roomId && (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 8px',
                              borderRadius: 6,
                              backgroundColor: 'rgba(56, 189, 248, 0.15)',
                              border: '1px solid rgba(56, 189, 248, 0.4)',
                              color: '#38bdf8',
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              fontSize: '0.82rem',
                            }}
                          >
                            SALA {block.roomId}
                          </span>
                        )}
                        <span>
                          • <strong style={{ color: '#ffffff', fontWeight: 600 }}>{block.totalEvaluated}</strong> {block.totalEvaluated === 1 ? 'aluno avaliado' : 'alunos avaliados'}
                        </span>
                        <span>
                          • Média: <strong style={{ color: '#fbbf24', fontSize: '0.92rem', fontWeight: 800 }}>{block.averageScore.toFixed(1)}</strong>
                        </span>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 4 }}>
                          {block.formativeDistribution.pleno > 0 && (
                            <span style={{ color: '#4ade80', backgroundColor: 'rgba(34, 197, 94, 0.15)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(34, 197, 94, 0.3)', fontWeight: 600 }}>
                              🟢 {block.formativeDistribution.pleno} Pleno
                            </span>
                          )}
                          {block.formativeDistribution.bom > 0 && (
                            <span style={{ color: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.15)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(56, 189, 248, 0.3)', fontWeight: 600 }}>
                              🔵 {block.formativeDistribution.bom} Bom
                            </span>
                          )}
                          {block.formativeDistribution.evolucao > 0 && (
                            <span style={{ color: '#fde047', backgroundColor: 'rgba(234, 179, 8, 0.15)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(234, 179, 8, 0.3)', fontWeight: 600 }}>
                              🟡 {block.formativeDistribution.evolucao} Evolução
                            </span>
                          )}
                          {block.formativeDistribution.atencao > 0 && (
                            <span style={{ color: '#f87171', backgroundColor: 'rgba(239, 68, 68, 0.15)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(239, 68, 68, 0.3)', fontWeight: 600 }}>
                              🔴 {block.formativeDistribution.atencao} Atenção
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Ações do Bloco (Exportar + Chevron) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleExportCSV(block.submissions, `${block.ebookId}-${block.date}`)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 12px',
                        borderRadius: 8,
                        backgroundColor: 'rgba(147, 51, 234, 0.15)',
                        border: '1px solid rgba(147, 51, 234, 0.35)',
                        color: '#c084fc',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      title="Exportar apenas as submissões deste bloco em CSV"
                    >
                      <FileSpreadsheet size={14} />
                      Exportar Bloco (.CSV)
                    </button>

                    <div
                      style={{
                        padding: 6,
                        borderRadius: 8,
                        color: 'var(--muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'transform 0.2s ease',
                        transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                      }}
                    >
                      <ChevronDown size={18} />
                    </div>
                  </div>
                </div>

                {/* CORPO DO BLOCO: NOTAS INDIVIDUAIS DOS ALUNOS COM CONTRASTE PERFEITO SOBRE FUNDO BRANCO */}
                {!isCollapsed && (
                  <div
                    className="admin-table"
                    style={{
                      margin: 0,
                      backgroundColor: '#ffffff',
                      borderRadius: '0 0 16px 16px',
                      overflow: 'hidden',
                      borderTop: '1px solid #e2e8f0',
                    }}
                  >
                    <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: '#ffffff' }}>
                      <thead style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                        <tr>
                          <th style={{ color: '#475569', fontWeight: 700, padding: '14px 18px', fontSize: '0.85rem' }}>Aluno</th>
                          <th style={{ color: '#475569', fontWeight: 700, padding: '14px 16px', fontSize: '0.85rem' }}>Acertos & Erros</th>
                          <th style={{ color: '#475569', fontWeight: 700, textAlign: 'center', padding: '14px 16px', fontSize: '0.85rem' }}>Nota (0 - 10)</th>
                          <th style={{ color: '#475569', fontWeight: 700, textAlign: 'center', padding: '14px 16px', fontSize: '0.85rem' }}>Conceito Formativo</th>
                          <th style={{ color: '#475569', fontWeight: 700, padding: '14px 16px', fontSize: '0.85rem' }}>Horário</th>
                          <th style={{ color: '#475569', fontWeight: 700, textAlign: 'center', padding: '14px 16px', fontSize: '0.85rem' }}>Comprovante</th>
                        </tr>
                      </thead>
                      <tbody style={{ backgroundColor: '#ffffff' }}>
                        {block.submissions.map((s) => {
                          const erros = s.total_questions - s.correct_answers
                          const formativo = getFormativeGrade(s.score)

                          return (
                            <tr
                              key={s.id}
                              style={{
                                borderBottom: '1px solid #f1f5f9',
                                backgroundColor: '#ffffff',
                                transition: 'background-color 0.15s ease',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
                              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#ffffff')}
                            >
                              <td style={{ padding: '14px 18px' }}>
                                <div style={{ fontWeight: 700, color: '#1E293B', fontSize: '0.95rem', marginBottom: 4 }}>
                                  {s.student_name}
                                </div>
                                <div
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 5,
                                    padding: '2px 8px',
                                    borderRadius: 4,
                                    backgroundColor: '#f1f5f9',
                                    border: '1px solid #e2e8f0',
                                    fontSize: '0.78rem',
                                    color: '#64748B',
                                    fontFamily: 'monospace',
                                    fontWeight: 600,
                                  }}
                                >
                                  <span style={{ color: '#94a3b8' }}>ID:</span> {s.student_email || s.student_identifier}
                                </div>
                              </td>

                              <td style={{ padding: '14px 16px' }}>
                                <div style={{ fontSize: '0.86rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ color: '#16a34a', fontWeight: 700 }}>
                                    {s.correct_answers} {s.correct_answers === 1 ? 'acerto' : 'acertos'}
                                  </span>
                                  <span style={{ color: '#94a3b8' }}>•</span>
                                  <span style={{ color: erros > 0 ? '#dc2626' : '#64748b', fontWeight: 700 }}>
                                    {erros} {erros === 1 ? 'erro' : 'erros'}
                                  </span>
                                  <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                                    ({s.total_questions} questões)
                                  </span>
                                </div>
                              </td>

                              <td style={{ textAlign: 'center', padding: '14px 16px' }}>
                                <span
                                  style={{
                                    fontSize: '1.15rem',
                                    fontWeight: 800,
                                    color: formativo.color === '#4ade80' ? '#16a34a' : (formativo.color === '#f87171' ? '#dc2626' : (formativo.color === '#fde047' ? '#b45309' : '#0284c7')),
                                  }}
                                >
                                  {s.score.toFixed(1)}
                                </span>
                              </td>

                              <td style={{ textAlign: 'center', padding: '14px 16px' }}>
                                <span
                                  className="badge"
                                  style={{
                                    padding: '5px 12px',
                                    borderRadius: 8,
                                    fontWeight: 700,
                                    fontSize: '0.78rem',
                                    backgroundColor: formativo.bgColor,
                                    color: formativo.color === '#4ade80' ? '#15803d' : (formativo.color === '#f87171' ? '#b91c1c' : (formativo.color === '#fde047' ? '#a16207' : '#0369a1')),
                                    border: `1px solid ${formativo.borderColor}`,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    letterSpacing: '0.01em',
                                  }}
                                >
                                  <span>{formativo.icon}</span>
                                  <span>{formativo.label}</span>
                                </span>
                              </td>

                              <td style={{ fontSize: '0.82rem', color: '#64748b', padding: '14px 16px', fontWeight: 500 }}>
                                {new Date(s.completed_at).toLocaleTimeString('pt-BR', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </td>

                              <td style={{ textAlign: 'center', padding: '14px 16px' }}>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handlePrintStudentBulletin(s)
                                  }}
                                  title="Imprimir Boletim / Comprovante Oficial do Aluno"
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '6px 14px',
                                    borderRadius: 8,
                                    backgroundColor: '#7c3aed',
                                    color: '#ffffff',
                                    border: 'none',
                                    fontSize: '0.78rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    boxShadow: '0 2px 6px rgba(124, 58, 237, 0.3)',
                                  }}
                                >
                                  <Printer size={14} />
                                  <span>Comprovante</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {printSubmission && (
        <AcademicReportPrintModal
          isOpen={true}
          onClose={() => setPrintSubmission(null)}
          submission={printSubmission.submission}
          questions={printSubmission.assessmentQuestions}
          tenantName={tenant?.name || 'Instituição de Ensino'}
        />
      )}
    </section>
  )
}
