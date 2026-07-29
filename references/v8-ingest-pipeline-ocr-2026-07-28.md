# v8 — Pipeline de ingestão de novo livro (28/07/2026)

Caso motivador: Bíblia Dake — Gálatas (12 páginas, scan de 1963), cedido por Isaías pra protótipo. Caso também motivador pra feature futura "usuário sobe o próprio livro" (cobrável).

## Por que OCR é requisito desde o início

Scans de livros físicos são comuns em:
- Livros antigos (pré-1990 ou copyright expirado: Bíblia Dake 1963, clássicos greco-romanos, etc.)
- Livros acadêmicos/self-published onde o autor só tinha o scan
- Distribuições "pirateadas" que começaram como scan
- Material didático escaneado por professor

**Sem OCR**, esses livros aparecem como PDFs vazios no pipeline → embedding zerado → Professor IA muda de assunto ("não encontrei no conteúdo"). Pré-requisito pra feature "usuário sobe livro" é OCR no upload.

## Detecção automática de PDF escaneado

```bash
# Média de chars nas 3 primeiras páginas:
AVG=$(pdftotext -f 1 -l 3 "$INPUT" - | wc -c | awk '{print int($1/3)}')
# AVG < 200 = escaneado (4-5 chars por página × 12 páginas = ~60 chars total)
# AVG > 200 = tem texto (4000+ chars por página)
```

Threshold validado em 28/07/2026 com Bíblia Dake: tinha 1 char/página (= 0 real). Ajuste o threshold conforme o corpus, mas `200` é seguro.

## Pipeline completo (orquestrado por `scripts/ingest_book.sh`)

```bash
ingest_book.sh <input.pdf> <slug> <title> <author> [price_cents]
```

Stages:
1. **Detecção** — `pdftotext -f 1 -l 3 "$INPUT" - | wc -c` pra decidir se é escaneado
2. **OCR (se escaneado)** — `ocrmypdf -l por --skip-text --deskew --clean --output-type pdf`
3. **Extração** — `pdftotext -layout` + Python split por `\f` → `data/<slug>-pages.json`
4. **Upload Storage** — `POST /storage/v1/object/ebooks/<slug>/livro.pdf` com `x-upsert: true`
5. **INSERT ebook** — `POST /rest/v1/ebooks` com `Prefer: resolution=merge-duplicates`
6. **Embeddings** — `scripts/fastembed_pages.py --book <slug>` (~30s pra 12 páginas, ~4min pra 354)
7. **PATCH embeddings** — `scripts/patch_embeddings.py --book <slug>` (~140s pra 352 PATCHes)
8. **(opcional) Compra pro user de teste** — manual via service_role

## Pré-requisitos apt/pip (UMA VEZ na VPS)

```bash
apt-get install -y tesseract-ocr tesseract-ocr-por poppler-utils unpaper ghostscript
pip install ocrmypdf fastembed
```

**Pitfall validado**: `ocrmypdf --clean` requer `unpaper`. Sem ele:
```
The program 'unpaper' could not be executed or was not found on your system PATH
```

Bash wrapper `scripts/ocr_pdf.sh` tem pré-checagem via `command -v` que falha limpo com mensagem clara em vez do traceback genérico.

## Tempo médio (validado em CPU VPS 8-core)

| Livro | Páginas | Tipo | OCR | Embeddings | Total |
|---|---|---|---|---|---|
| O Poder do Hábito | 354 | Texto embutido | N/A | ~240s | 4min |
| Bíblia Dake Gálatas | 12 | Escaneado | ~28s | ~30s | 1min |
| Média por página escaneada | 1 | — | ~2.3s | ~2.5s | ~5s |

Pra livro de **300 páginas escaneadas**: ~25min OCR + ~12min embeddings = ~37min total. Rodar em background se for pra produção.

## Output esperado por stage

| Stage | Validar |
|---|---|
| OCR OK | `pdfinfo $OUTPUT` mostra `Pages: N`, `pdftotext $OUTPUT - \| wc -c` > N×1000 |
| Pages extraído | `cat data/<slug>-pages.json \| python3 -m json.tool` mostra array de `{page, text}` |
| Upload Storage | `curl $URL/storage/v1/object/list/ebooks` mostra `<slug>/livro.pdf` |
| INSERT ebook | `curl $URL/rest/v1/ebooks?slug=eq.<slug>` retorna row |
| Embeddings | `curl $URL/rest/v1/ebook_pages?ebook_id=eq.<id>&select=count&embedding=not.is.null` retorna count = páginas com texto (>10 chars) |
| Signed URL funciona | `curl POST /signed-url-api/sign` com JWT válido retorna URL que baixa o PDF real |
| RAG funciona | Pergunta sobre o conteúdo do livro retorna answer > 100 chars com `sources[]` |

## Próximas evoluções

### v9 (provável): "Usuário sobe o próprio livro"

Roadmap do Isaías:
1. **Upload autenticado** — endpoint protegido, recebe PDF + valida limite do plano do user
2. **Fila assíncrona** — Redis/RQ ou systemd queue pra processar em background
3. **Cobrança** — Stripe ou Pix dinâmico. Cada livro = R$X (taxa flat ou por página). Modelo "cota mensal" também funciona.
4. **Notificação** — websocket ou polling pra avisar "seu livro está pronto"
5. **Biblioteca pessoal** — book pertence ao user que subiu, marcado como "pessoal" vs catálogo público
6. **Compartilhar** — opcional: user pode tornar público e ganhar % da venda

Tudo orquestrado pelo `ingest_book.sh` — o script vira o worker, e o endpoint HTTP só enfileira o job.

### v10: OCR via serviço pago (Textract/Document AI)

Quando qualidade do tesseract for insuficiente (scans antigos, fontes decorativas, idiomas com scripts complexos), upgrade pra:
- AWS Textract (`$1.50/1000 páginas`) — usa AnalyzeDocument API, retorna blocos com posição
- Google Document AI (`$1.50/1000 páginas`) — Form Parser
- Azure Document Intelligence (`$1.50/1000 páginas`) — Layout model

Trocar `ocr_pdf.py` pra chamar serviço pago quando instalado + flag `--use-cloud`.

Pra PDFs em hebraico/árabe/grego, Tesseract falha. Texto bíblico Dake já testou em PT-BR com qualidade suficiente (98%+ das palavras reconhecidas com `--deskew --clean`).

## Pitfalls desta fase (além dos já documentados)

- Sem `unpaper`/`ghostscript`: `ocrmypdf --clean` falha. Pré-checar com `command -v`.
- PDF protegido/criptografado: `ocrmypdf` falha com "file is encrypted" — descriptografar antes.
- PDF gigante (>500MB): `ocrmypdf` exige 8GB RAM pra processar em memória. Stream com `--jobs 4` reduz.
- Idioma errado: `-l eng` em vez de `-l por` produz lixo. Validar com `--list-langs` antes.
- Tesseract versão antiga (<4.0): qualidade ruim em PT-BR. Ubuntu 22.04+ traz 5.x.

## Decision tree pra novos livros

```
input.pdf
   │
   ├─ Texto extraível (>200 chars/pg)?
   │   ├─ Sim → pdftotext direto → embeddings → upload
   │   └─ Não → ocrmypdf → pdftotext → embeddings → upload
   │
   ├─ Idioma do OCR?
   │   ├─ PT-BR → -l por
   │   ├─ EN    → -l eng
   │   ├─ ES    → -l spa
   │   └─ Multi → -l por+eng+spa (unir modelos, mais lento)
   │
   ├─ ISBN/metadata presente no PDF?
   │   ├─ Sim → extrai via pdfinfo, autopreenche title/author
   │   └─ Não → pergunta pra Isaías
   │
   └─ User pagou taxa de ingestão (futuro)?
       ├─ Sim → flag --priority high → processa em <5min
       └─ Não (free tier) → background queue → processa quando slot disponível
```

Esta decision tree vai virar código em `scripts/ingest_book.sh` quando começar a feature v9.
