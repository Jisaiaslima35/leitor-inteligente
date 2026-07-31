import { describe, expect, it } from 'vitest'
import { checkoutBook, ownsBook } from '../src/domain/library'

describe('liberação de compra', () => {
  it('libera o livro para o usuário após checkout aprovado', () => {
    const state = checkoutBook({ purchases: [] }, 'user-1', 'habit-book')
    expect(ownsBook(state, 'user-1', 'habit-book')).toBe(true)
  })

  it('não duplica uma compra já existente', () => {
    const initial = checkoutBook({ purchases: [] }, 'user-1', 'habit-book')
    const repeated = checkoutBook(initial, 'user-1', 'habit-book')
    expect(repeated.purchases).toHaveLength(1)
  })
})
