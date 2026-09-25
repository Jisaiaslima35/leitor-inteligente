import { PdfViewer } from './PdfViewer'
import { EpubViewer } from './EpubViewer'
import type { Highlight } from './AnnotationModal'
import type { SelectionInfo } from './SelectionToolbar'

interface Props {
  format?: 'pdf' | 'epub' | 'mobi'
  fileUrl: string | null
  page: number
  totalPages?: number
  onPageChange: (page: number) => void
  onInternalNav?: (page: number) => void
  scale?: number
  onTextExtracted?: (text: string) => void
  highlights?: Highlight[]
  onSelectionChange?: (info: SelectionInfo | null) => void
  onHighlightClick?: (h: Highlight) => void
}

export function UniversalReader({
  format,
  fileUrl,
  page,
  totalPages = 100,
  onPageChange,
  onInternalNav,
  scale = 1.2,
  onTextExtracted,
  highlights = [],
  onSelectionChange,
  onHighlightClick,
}: Props) {
  if (!fileUrl) {
    return (
      <div style={{ color: 'white', textAlign: 'center', padding: 32 }}>
        Carregando obra…
      </div>
    )
  }

  // Detecta se é EPUB explicitamente pelo formato ou pela extensão da URL
  const isEpub = format === 'epub' || fileUrl.toLowerCase().includes('.epub')

  if (isEpub) {
    return (
      <EpubViewer
        url={fileUrl}
        page={page}
        totalPages={totalPages}
        onPageChange={onPageChange}
        onInternalNav={onInternalNav}
        scale={scale}
        onTextExtracted={onTextExtracted}
        highlights={highlights}
        onSelectionChange={onSelectionChange}
        onHighlightClick={onHighlightClick}
      />
    )
  }

  return (
    <PdfViewer
      pdfPath={fileUrl}
      page={page}
      onPageChange={onPageChange}
      onInternalNav={onInternalNav}
      scale={scale}
      onTextExtracted={onTextExtracted}
      highlights={highlights}
      onSelectionChange={onSelectionChange}
      onHighlightClick={onHighlightClick}
    />
  )
}
