---
name: pwa-leitor-inteligente
description: PWA de ebooks — store + library + PDF reader + Professor IA com RAG vetorial. Suporta multi-livro. Use quando Isaías pedir "leitor inteligente", "biblioteca digital", "app de e-books com professor IA", ou "comprar livro + ler + perguntar ao livro". Companion a `ebook-tools-pandoc-mdbook` (gera PDFs) e `flipbook-publisher` (flipbook simples sem loja/IA). Cobre Supabase Auth + Cloud-backed library + RAG vetorial (v3), Magic Link + signup passwordless com RLS (v4), pgvector + fallback lexical "página N" (v6), PDFs via signed URL Supabase Storage TTL 60min (v7), OCR pipeline (v8), Multi-book saga (v10), Reproduction discipline workflow (v11). Detalhes em references/v3-v11.
tags: [pwa, ebook, reader, professor-ia, rag, pdfjs, vite, react, vercel, preview, streak, gamification, supabase, ocr, ingest]
related_skills: [ebook-tools-pandoc-mdbook, flipbook-publisher, brazilian-digital-products, mini-site-whatsapp-pedido, cf-tunnel-add-hostname, vercel-deploy-cli, nginx-edge-mime-types-and-modular-deployment]
license: MIT
version: 1.9.0
last_updated: "2026-07-28 rev 11 — BUG MULTI-LIVRO COMPLETAMENTE RESOLVIDO. Isaías confirmou em 2 navegadores + aba anônima que Gálatas (12 páginas) e Hábito (354 páginas) respondem certo. Rodada final cobriu: (1) verificação ebook_pages 12/12 com embedding, (2) cabeçalho Professor IA com 354 hardcoded substituído por {book.totalPages} dinâmico, (3) lexical_page_lookup aceita book_slug via LEXICAL_PATHS. REGRA consolidada: TODA função que busca conteúdo de livro recebe book_slug como parâmetro — vale pros 2 code paths (vetorial E lexical). Padrão de teste: E2E em browser real com 2 livros diferentes + perguntas COM e SEM página N. Ver references/v10-multi-book-validation e v11-reproduction-discipline."
metadata:
  hermes:
    tags: [pwa, ebook, reader, professor-ia, rag, pdfjs, vite, react, vercel, preview, streak, gamification, supabase, ocr, ingest]
    related_skills: [ebook-tools-pandoc-mdbook, flipbook-publisher, brazilian-digital-products, mini-site-whatsapp-pedido, cf-tunnel-add-hostname, vercel-deploy-cli, nginx-edge-mime-types-and-modular-deployment]
---

# PWA Leitor Inteligente (Store + Library + PDF Reader + Professor IA)