#!/usr/bin/env python3
"""
patch_embeddings.py — Envia embeddings JSON pro Supabase via PATCH loop.

Usado no pipeline de migração pra Supabase (etapa 1 — Integração Supabase).
Template validado em 28/07/2026, sessão "O Poder do Hábito".

O QUE FAZ:
- Carrega /tmp/embeddings_bge.json (gerado por fastembed_pages.py)
- PATCH em loop em ebook_pages WHERE ebook_id=X&page_number=eq.Y
- Reporta progresso + falhas

ENV REQUERIDAS (em /root/.hermes/secrets/leitor-supabase.env):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE

USO:
    python3 scripts/patch_embeddings.py [--input FILE] [--ebook-id UUID]
    [--slug NAME]

PADRÃO:
    Lê EBOOK_ID do env (auto-detect via slug se não passar)

PITFALL CRÍTICO:
    POST com 'Prefer: resolution=merge-duplicates' falha com NOT NULL violation
    no bigserial PRIMARY KEY id quando a tabela tem UNIQUE(ebook_id, page_number)
    separada da PK. O merge-duplicates exige ON CONFLICT declarado na URL.

    Workaround testado: PATCH WHERE direto. Mais lento (1 por vez),
    mas determinístico. ~2.5 pg/s na VPS testada.

    Alternativa futura quando Supabase aceitar: POST ?on_conflict=ebook_id,page_number
    -H 'Prefer: resolution=merge-duplicates' — apenas uma chamada por embedding.
"""
import argparse, json, os, subprocess, sys, time


def env(name):
    for line in open("/root/.hermes/secrets/leitor-supabase.env"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line and line.split("=", 1)[0] == name:
            return line.split("=", 1)[1].strip()
    sys.exit(f"env não definida: {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="/tmp/embeddings_bge.json")
    ap.add_argument("--slug", default=None,
                    help="slug pra auto-detectar ebook_id via REST")
    ap.add_argument("--ebook-id", default=None,
                    help="UUID direto (skip lookup)")
    args = ap.parse_args()

    URL = env("SUPABASE_URL")
    SR = env("SUPABASE_SERVICE_ROLE")

    # Descobre ebook_id
    ebook_id = args.ebook_id
    if ebook_id is None:
        if args.slug is None:
            sys.exit("--slug ou --ebook-id é obrigatório")
        print(f"Procurando ebook_id pra slug={args.slug}...")
        r = subprocess.run([
            "curl", "-sS",
            f"{URL}/rest/v1/ebooks?select=id&slug=eq.{args.slug}&limit=1",
            "-H", f"apikey: {SR}", "-H", f"Authorization: Bearer {SR}",
        ], capture_output=True, text=True, timeout=15)
        data = json.loads(r.stdout)
        if not data:
            sys.exit(f"Nenhum ebook com slug={args.slug}")
        ebook_id = data[0]["id"]
        print(f"  → ebook_id={ebook_id}")

    with open(args.input) as f:
        embeddings = json.load(f)

    print(f"Total embeddings no arquivo: {len(embeddings)}")

    SUCCESS = 0
    FAILED = []
    t0 = time.time()
    for i, e in enumerate(embeddings):
        pn = e["page"]
        payload = json.dumps({"embedding": e["embedding"]})
        url = f"{URL}/rest/v1/ebook_pages?ebook_id=eq.{ebook_id}&page_number=eq.{pn}"
        r = subprocess.run([
            "curl", "-sS", "-w", "\n%{http_code}",
            "-X", "PATCH", url,
            "-H", f"apikey: {SR}", "-H", f"Authorization: Bearer {SR}",
            "-H", "Content-Type: application/json",
            "-d", payload,
        ], capture_output=True, text=True, timeout=15)
        code = r.stdout.strip().split("\n")[-1]
        if code == "204":
            SUCCESS += 1
            if (i + 1) % 100 == 0:
                elapsed = time.time() - t0
                rate = (i + 1) / elapsed
                print(f"  {i+1}/{len(embeddings)} OK ({elapsed:.0f}s, {rate:.1f} pg/s)")
        else:
            FAILED.append((pn, code, r.stdout[:200]))
            if len(FAILED) <= 3:
                print(f"  FAIL p{pn} HTTP={code} body={r.stdout[:200]}")

    print(f"\n=== Resultado ===")
    print(f"Sucesso: {SUCCESS}/{len(embeddings)}")
    print(f"Failed: {len(FAILED)}")
    if FAILED:
        for pn, code, body in FAILED[:5]:
            print(f"  p{pn}: {code} {body[:100]}")
    print(f"Tempo total: {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
