import { describe, expect, it } from 'vitest'
import { answerQuestion, retrieveContext } from '../src/domain/rag'

const chunks = [
  { id: 'loop', title: 'O loop do hábito', page: 45, text: 'Todo hábito possui uma deixa que dispara uma rotina e produz uma recompensa. O cérebro aprende a antecipar essa recompensa.' },
  { id: 'keystone', title: 'Hábitos angulares', page: 121, text: 'Hábitos angulares desencadeiam pequenas vitórias e ajudam outras rotinas positivas a se espalharem.' },
  { id: 'willpower', title: 'Força de vontade', page: 167, text: 'A força de vontade pode se tornar automática quando existe um plano preparado para momentos de pressão.' },
]

describe('recuperação local de contexto do professor IA', () => {
  it('recupera o trecho semanticamente relacionado à pergunta', () => {
    const matches = retrieveContext('Como funciona deixa, rotina e recompensa?', chunks, 1)
    expect(matches[0].id).toBe('loop')
  })

  it('responde pedagogicamente com fonte e página do livro', () => {
    const response = answerQuestion('O que é um hábito angular?', chunks)
    expect(response.answer).toContain('hábitos angulares')
    expect(response.sources[0]).toMatchObject({ title: 'Hábitos angulares', page: 121 })
  })
})
