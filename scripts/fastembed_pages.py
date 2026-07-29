#!/usr/bin/env python3
"""
fastembed_pages.py — Gera embeddings BGE-small-en pras páginas de um ebook.

Usado no pipeline de migração pra Supabase (etapa 1 — Integração Supabase).
Template validado em 28/07/2026, sessão "O Poder do Hábito".

O QUE FAZ:
- Carrega data/<slug>-pages.json ({page, text} por página, gerado por pdftotext)
- Pula páginas com texto < 10 chars (capas/folhas de rosto)
- Gera embedding 384d por página com BAAI/bge-small-en-v1.5
- Salva lista JSON em /tmp/embeddings_bge.json pra ser uploadado em batch via PATCH

DIMENSÕES DOS MODELOS SUPORTADOS (decida ANTES de criar a coluna `embedding`):
- BAAI/bge-small-en-v1.5     → 384 dim (~33M params,  CPU OK,  inglês only)
- BAAI/bge-small-en-v1.5-Q   → 384 dim (quantized, mais rápido, qualidade -1%)
- BAAI/bge-base-en-v1.5      → 768 dim (~109M, mais lento, melhor qualidade)
- sentence-transformers/all-MiniLM-L6-v2 → 384 dim (PyTorch, não fastembed)
- intfloat/e5-small-v2       → 384 dim (multilingua, melhor pra PT-BR)
- BAAI/bge-m3                → 1024 dim (multilingua, pesado)

Se a coluna no Supabase é vector(384), use small-en OU MiniLM. Se quer
qualidade em PT-BR com mesma dim, use e5-small-v2.

USO:
    python3 scripts/fastembed_pages.py [--slug NAME] [--model NAME] [--dim N]

PADRÃO:
    --slug o-poder-do-habito  (procura data/o-poder-do-habito-pages.json)
    --model BAAI/bge-small-en-v1.5
    --dim 384

REQUISITOS:
    pip install fastembed
    pdftotext -layout livro.pdf livro.txt  # gera pages.json antes (ver SKILL)

PITFALLS (todos pegos nesta sessão):
1. fastembed retorna ndarray, NÃO list. JSON dump quebra. Solução: .tolist() ANTES.
2. fastembed.TextEmbedding(parallel=2) em script Python (não freeze) → fork
   multiprocessing que mata o subprocess em silêncio. Solução: if __name__ == '__main__':
   E OMP_NUM_THREADS=2 E parallel=1.
3. CPU-only leva ~4min pra 352 páginas (1.5 pg/s). Não tente timeout <5min
   no terminal/background process — vai matar antes do tempo.
"""
import argparse, json, os, sys, time
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default="o-poder-do-habito",
                    help="slug do livro (procura data/<slug>-pages.json)")
    ap.add_argument("--model", default="BAAI/bge-small-en-v1.5",
                    help="modelo fastembed (ver docstring pra alternativas)")
    ap.add_argument("--dim", type=int, default=384,
                    help="dimensão esperada do modelo (deve bater com schema)")
    ap.add_argument("--out", default="/tmp/embeddings_bge.json",
                    help="arquivo de saída")
    ap.add_argument("--min-chars", type=int, default=10,
                    help="pular páginas com texto menor que N chars")
    args = ap.parse_args()

    from fastembed import TextEmbedding  # import tardio (depois do fork setup)

    t0 = time.time()
    src = f"/root/projetos/leitor-inteligente/data/{args.slug}-pages.json"
    if not os.path.exists(src):
        sys.exit(f"Fonte não encontrada: {src}. Rode pdftotext primeiro.")

    with open(src, encoding="utf-8") as f:
        pages = json.load(f)

    valid = [(p["page"], (p["text"] or "").strip())
             for p in pages if len((p["text"] or "").strip()) > args.min_chars]

    print(f"[{time.time()-t0:.1f}s] {len(valid)}/{len(pages)} páginas válidas (>{args.min_chars} chars)")
    print(f"[{time.time()-t0:.1f}s] Carregando modelo {args.model}...", flush=True)

    model = TextEmbedding(model_name=args.model)
    if model.embedding_size != args.dim:
        sys.exit(f"Dimensão errada! esperado={args.dim} modelo={model.embedding_size}. "
                 f"Use outro modelo ou ajuste o schema do Supabase.")

    print(f"[{time.time()-t0:.1f}s] Modelo OK (dim={args.dim}). Embedding {len(valid)} páginas...", flush=True)

    texts = [t for _, t in valid]
    t1 = time.time()
    embeddings = list(model.embed(texts, batch_size=16, parallel=1))
    elapsed = time.time() - t1

    print(f"[{time.time()-t0:.1f}s] Done em {elapsed:.1f}s ({len(valid)/elapsed:.1f} pg/s)", flush=True)

    # CRÍTICO: .tolist() ANTES de json.dump — fastembed retorna ndarray
    output = [{"page": pn, "embedding": emb.tolist()}
              for (pn, _), emb in zip(valid, embeddings)]

    with open(args.out, "w") as f:
        json.dump(output, f, ensure_ascii=False)

    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"[{time.time()-t0:.1f}s] Salvo {args.out} ({len(output)} entries, {size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
