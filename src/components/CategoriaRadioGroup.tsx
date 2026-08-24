// CategoriaRadioGroup.tsx — seletor de categoria com radio buttons únicos.
//
// ISAÍAS 24/08/2026 (P8) — substitui o `<select>` antigo nos painéis admin
// e no upload do cliente (UploadPage).
//
// Princípios:
//   • Inicia SEM nenhuma opção marcada (state inicial = '')
//   • Validação obrigatória no submit: se vazio, alerta "Escolha a categoria"
//   • Lista as 6 categorias oficiais vindas de `CATEGORIAS` + `CATEGORIA_LABEL`
//   • Layout vertical com bolinha nativa (radio) — simples, acessível, mobile-friendly
//   • Visual integra com a identidade do Leitor (dourado brand quando marcado)

import { CATEGORIAS, CATEGORIA_LABEL, type Categoria } from '../domain/types'

export type CategoriaValue = Categoria | ''

interface Props {
  /** Valor atual ('' = nada marcado) */
  value: CategoriaValue
  /** Callback quando o user seleciona uma opção */
  onChange: (next: CategoriaValue) => void
  /** Desabilita interação (ex.: durante uploadBusy) */
  disabled?: boolean
  /** Rótulo/descrição curta exibida acima do grupo */
  label?: string
  /** Layout horizontal (default false = vertical empilhado) */
  horizontal?: boolean
  /** Compacto (esconde descrição "Por que isso importa?") */
  compact?: boolean
}

/** Componente presentational — sem estado interno, totalmente controlado. */
export function CategoriaRadioGroup({
  value,
  onChange,
  disabled,
  label,
  horizontal = false,
  compact = false,
}: Props) {
  return (
    <div className={`categoria-radio-group ${horizontal ? 'is-horizontal' : ''} ${compact ? 'is-compact' : ''}`}>
      {label && <div className="categoria-radio-label">{label}</div>}
      <div className="categoria-radio-options" role="radiogroup" aria-label={label || 'Categoria do livro'}>
        {CATEGORIAS.map((c) => {
          const checked = value === c
          return (
            <label
              key={c}
              className={`categoria-radio-option ${checked ? 'is-checked' : ''}`}
              htmlFor={`cat-${c}`}
            >
              <input
                id={`cat-${c}`}
                type="radio"
                name="categoria-radio"
                value={c}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(c)}
                className="categoria-radio-input"
              />
              <span className="categoria-radio-dot" aria-hidden="true" />
              <span className="categoria-radio-text">{CATEGORIA_LABEL[c]}</span>
            </label>
          )
        })}
      </div>
      {!compact && (
        <div className="categoria-radio-hint">
          <strong>Por que isso importa?</strong> A categoria define quais features o livro habilita
          (ex.: Sala Dev só abre pra livros de <em>Programação</em>).
        </div>
      )}
    </div>
  )
}

/** Helper pra validar valor de categoria — usado nos submits. */
export function isCategoriaValida(value: CategoriaValue): value is Categoria {
  return value !== '' && (CATEGORIAS as readonly string[]).includes(value)
}
