import { describe, expect, it } from 'vitest'
import { getProgress, saveProgress } from '../src/domain/progress'

describe('progresso de leitura', () => {
  it('salva e retoma a página mais recente por usuário e livro', () => {
    let state = saveProgress({}, 'user-1', 'habit-book', 48, 354)
    state = saveProgress(state, 'user-1', 'habit-book', 72, 354)
    const progress = getProgress(state, 'user-1', 'habit-book')
    expect(progress).not.toBeNull()
    expect(progress?.page).toBe(72)
    expect(progress?.totalPages).toBe(354)
    expect(progress?.percent).toBe(20)
    expect(progress?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('limita páginas inválidas ao intervalo do livro', () => {
    const state = saveProgress({}, 'user-1', 'habit-book', 999, 354)
    expect(getProgress(state, 'user-1', 'habit-book')?.page).toBe(354)
  })
})
