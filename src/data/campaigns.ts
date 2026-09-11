// Manifesto das campanhas temáticas.
// Cada entrada vira uma landpage em /tema/<slug>, alimentada pelos livros
// da tabela `ebooks` com categoria correspondente. Cadastrar nova campanha:
//  1. adicionar entrada neste array
//  2. (se for categoria NOVA) somar valor ao enum Categoria + migration CHECK
//  3. subir livros com categoria = entry.categoria
//
// Texto do HERO (badge / título / descrição) é FIXO aqui — edite à vontade
// sem mexer no banco. Não duplicar com `description` da tabela ebooks
// (esse é o texto curto por livro, mostrado no card).

import type { Categoria } from '../domain/types'

export interface Campanha {
  /** slug da URL: /tema/<slug> */
  slug: string
  /** categoria usada pra filtrar ebooks na vitrine */
  categoria: Categoria
  /** rótulo curto que aparece na tag do hero */
  badge: string
  /** título principal do hero */
  titulo: string
  /** parágrafo de venda do hero */
  descricao: string
  /** CTA primário (botão branco no hero verde) */
  ctaPrimario: string
  /** CTA secundário (botão ghost, leva pro livro destaque) */
  ctaSecundario: string
  /** opcional: slug do ebook destaque (carregado do Supabase). Se vazio,
   *  o componente pega automaticamente o livro mais recente da categoria. */
  featuredBookId?: string
}

export const CAMPANHAS: Campanha[] = [
  {
    slug: 'batalha-espiritual',
    categoria: 'batalha-espiritual',
    badge: 'COLEÇÃO ESPECIAL: GUERRA ESPIRITUAL',
    titulo: 'Descubra a Força: Livros & Estudos de Guerra Espiritual',
    descricao:
      'Uma seleção especial para blindar sua fé e sua família. Leia com nosso leitor interativo e teste sua retenção com quizzes inteligentes.',
    ctaPrimario: 'Ver Coleção',
    ctaSecundario: 'Iniciar Leitura Destaque',
  },
  {
    slug: 'casamento-familia',
    categoria: 'casamento-familia',
    badge: 'COLEÇÃO ESPECIAL: CASAMENTO & FAMÍLIA',
    titulo: 'Blindando o Lar: Princípios Bíblicos para Casais e Família',
    descricao:
      'Leituras práticas para restaurar, fortalecer e proteger o seu relacionamento com acompanhamento inteligente de leitura.',
    ctaPrimario: 'Ver Coleção',
    ctaSecundario: 'Iniciar Leitura Destaque',
  },
  {
    slug: 'infantil',
    categoria: 'infantil',
    badge: 'COLEÇÃO ESPECIAL: LEITURA INFANTIL',
    titulo: 'Histórias e Ensinamentos que Edificam as Crianças',
    descricao:
      'Livros ilustrados e conteúdos educativos para formar princípios sólidos desde a infância.',
    ctaPrimario: 'Ver Coleção',
    ctaSecundario: 'Iniciar Leitura Destaque',
  },
]

/** Helper de resolução: recebe slug da URL e devolve a campanha (ou null). */
export function getCampanhaBySlug(slug: string | undefined): Campanha | null {
  if (!slug) return null
  return CAMPANHAS.find((c) => c.slug === slug) ?? null
}
