// Helpers de Avaliação Formativa e Conceitos Pedagógicos
// 24/09/2026 — Evolução Pedagógica do Leitor Inteligente

export interface FormativeGrade {
  key: 'pleno' | 'bom' | 'evolucao' | 'atencao'
  label: string
  shortLabel: string
  color: string
  bgColor: string
  borderColor: string
  icon: string
  description: string
}

export function getFormativeGrade(score: number): FormativeGrade {
  const s = Number(score) || 0
  if (s >= 8.5) {
    return {
      key: 'pleno',
      label: 'Domínio Pleno',
      shortLabel: 'Pleno',
      color: '#4ade80',
      bgColor: 'rgba(34, 197, 94, 0.15)',
      borderColor: 'rgba(74, 222, 128, 0.35)',
      icon: '🟢',
      description: 'Demonstrou compreensão aprofundada dos conceitos e aplicação consistente dos princípios estudados.',
    }
  }
  if (s >= 7.0) {
    return {
      key: 'bom',
      label: 'Bom Desempenho',
      shortLabel: 'Bom',
      color: '#38bdf8',
      bgColor: 'rgba(56, 189, 248, 0.15)',
      borderColor: 'rgba(56, 189, 248, 0.35)',
      icon: '🔵',
      description: 'Atingiu os objetivos essenciais de aprendizagem com bom nível de discernimento.',
    }
  }
  if (s >= 5.0) {
    return {
      key: 'evolucao',
      label: 'Em Evolução',
      shortLabel: 'Evolução',
      color: '#fde047',
      bgColor: 'rgba(234, 179, 8, 0.15)',
      borderColor: 'rgba(250, 204, 21, 0.35)',
      icon: '🟡',
      description: 'Compreendeu os tópicos fundamentais, porém necessita aprofundar pontos específicos.',
    }
  }
  return {
    key: 'atencao',
    label: 'Atenção Pedagógica',
    shortLabel: 'Atenção',
    color: '#f87171',
    bgColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(248, 113, 113, 0.35)',
    icon: '🔴',
    description: 'Revisão recomendada junto ao tutor para consolidação das competências básicas do capítulo.',
  }
}
