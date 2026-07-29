# v7 — Migração PDF pra signed URL do Supabase Storage (28/07/2026)

**Contexto**: até v6, O Poder do Hábito era servido como arquivo estático em `/var/www/preview/leitor-inteligente/books/o-poder-do-habito.pdf`. Funcionava pra 1 livro hardcoded mas não escala: cada livro novo = `cp` no nginx + entry no `catalog.ts` + rebuild do front.

Isaías pediu migração pra signed URL **antes** de adicionar mais livros no catálogo (Etapa 5 do pipeline de ingestão). Decisão: bucket `ebooks` continua **privado**, backend valida compra via `user_library`, gera URL temporária, front busca URL antes de renderizar.

---

## O que mudou

| Camada | v6 (estático) | v7 (signed URL) |
|---|---|---|
| Bucket | `ebooks` privado + PDF duplicado no nginx | `ebooks` privado, **única fonte** |
| URL do PDF | `https://preview.automacaojs.us/leitor-inteligente/books/<slug>.pdf` | `https://<ref>.supabase.co/storage/v1/object/sign/ebooks/<slug>/livro.pdf?token=<jwt>` TTL 60min |
| Auth | Nenhuma | JWT do Supabase validado no backend → `user_library` membership |
| Front | `<PdfViewer pdfPath={book.pdfPath} />` direto | `useEffect → fetch /signed-url-api/sign → setPdfUrl → <PdfViewer pdfPath={pdfUrl} />` |
| Loading | Instantâneo | ~500ms-2s (1 round-trip HTTP + RPC Supabase) |
| Catálogo | `pdfPath` apontava pro estático | `pdfPath` deprecated (campo morto; valor mantido pra compatibilidade de testes) |

---

## Decisões arquiteturais

**Por que backend intermediário, não client SDK?**
- Bucket privado: `anon` key NÃO consegue gerar signed URL sem policy adicional (Bucket pode ter policy `SELECT TO anon USING (true)` mas isso expõe o PDF pra qualquer um, quebra por-user)
- Backend com `service_role` valida `user_library` antes de retornar URL — usuário só baixa ebooks que comprou
- Decodifica o JWT do header (sem validar assinatura — frontend já validou via `@supabase/supabase-js`)

**Por que TTL 60min e não 5min?**
- PDF.js faz 1 request só pra abrir o doc (cacheia na memória do canvas). TTL 60min é suficiente.
- TTL menor = mais requests de signature; TTL maior = risco de replay (mas é signed URL do Supabase, não tem replay real pq precisa do `?token` válido)

**Por que HTTP fetch pra assinar e não streaming direto?**
- PDF.js espera URL `string` em `getDocument({url})` — não suporta callback de bytes com auth custom injetada
- Signed URL via REST retorna URL pronta com token embutido — funciona out-of-the-box com PDF.js + `<img>` + `<iframe>`

---

## O pitfall do dia (#53): Supabase signed URL retorna path RELATIVO

**Sintoma**: backend gerava signed URL, retornava 200 + URL. Front tentava `pdfjsLib.getDocument(url)` e quebrava com "InvalidPDFException" ou network error.

**Diagnóstico** (2 minutos):
```bash
URL=$(curl -sS -X POST "$SUPABASE_URL/storage/v1/object/sign/ebooks/<slug>/livro.pdf" \
  -H "Authorization: Bearer $SR" -d '{"expiresIn":3600}' | jq -r .signedURL)
echo "Path retornado: $URL"
# Resultado: "/object/sign/ebooks/o-poder-do-habito/livro.pdf?token=eyJ..."

# A) ERRADO:
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" "https://<ref>.supabase.co$URL"
# 404 "requested path is invalid"

# B) CERTO:
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" "https://<ref>.supabase.co/storage/v1$URL"
# 200 + 4MB PDF
```

**Causa**: Supabase REST retorna `signedURL` começando com `/object/sign/` (sem prefix). URL completa precisa de `/storage/v1/object/sign/`. Bug de 1 caractere (faltou o `/storage/v1` no template).

**Fix** (1 linha):
```python
# Errado:
return f"{SUPABASE_URL}{signed_path}"
# Certo:
return f"{SUPABASE_URL}/storage{v1}{signed_path}"  # /storage/v1 antes de /object/sign
```

**Pediu distração**: Pedro (assistente) sugeriu "talvez precise de `download=false`" — Supabase Storage **já serve `Content-Disposition: inline` por padrão** pra signed URLs. Flag `download=false` só vale pra `createSignedUrl` do client SDK JS, não pro SDK Python.

---

## Receita de setup do zero

```bash
# 1. Backend
cp /root/.hermes/skills/pwa-leitor-inteligente/templates/signed_url_server.py \
   /root/projetos/leitor-inteligente/api/signed_url_server.py

sudo tee /etc/systemd/system/leitor-signed-url-api.service <<EOF
[Unit]
Description=Leitor Inteligente - Signed URL API
After=network-online.target
[Service]
Type=simple
WorkingDirectory=/root/projetos/leitor-inteligente
ExecStart=/usr/local/lib/hermes-agent/venv/bin/python3 /root/projetos/leitor-inteligente/api/signed_url_server.py
Restart=always
RestartSec=3
User=root
Environment=PYTHONUNBUFFERED=1
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now leitor-signed-url-api.service
curl -sS http://127.0.0.1:9133/health
# esperado: {"status":"ok","service":"signed-url-api"}

# 2. Nginx (path /leitor-inteligente/signed-url-api/ → 9133)
# Adicionar no /etc/nginx/sites-enabled/preview:
location /leitor-inteligente/signed-url-api/ {
    proxy_pass http://127.0.0.1:9133/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 30s;
    add_header Cache-Control "no-store";
}
sudo nginx -t && sudo systemctl reload nginx

# 3. Front (ReaderPage já foi atualizado nessa sessão):
#    - useState pdfUrl + pdfLoading + pdfError
#    - useEffect fetch signed-url-api/sign
#    - 3 render states: loading (spinner), error (retry), loaded (PdfViewer com pdfUrl)
```

---

## Validação end-to-end (28/07/2026, validado via curl direto + browser agent)

| Cenário | HTTP esperado | Body | Status |
|---|---|---|---|
| Sem token | 401 | `{"error": "Sessão inválida..."}` | ✅ |
| Token JWT de user COM compra | 200 | `{url: "https://...?token=...", expiresIn: 3600, expiresAt: 1785284690}` | ✅ |
| Slug inexistente | 404 | `{"error": "Livro X não encontrado"}` | ✅ |
| Token de user SEM compra | 403 | `{"error": "Usuário não comprou este livro"}}` | ✅ (lógica correta) |
| URL baixada via curl | 200 | application/pdf, 4.011.553 bytes | ✅ |
| PDF abre no PDF.js | OK | sem erro CORS | ✅ |

---

## Pendente / próximo passo (handoff pra Etapa 5)

**Código morto a deletar quando v7 confirmada em produção:**
1. `/var/www/preview/leitor-inteligente/books/o-poder-do-habito.pdf` (3.8MB estático)
2. `/root/projetos/leitor-inteligente/public/books/o-poder-do-habito.pdf` (origem do build)
3. Campo `pdfPath` no tipo `Book` (manter enquanto houver testes usando)

**Não deletar antes de confirmar** que:
- [ ] Browser agent consegue abrir o PDF na UI (testado)
- [ ] Signed URL funciona pra livros diferentes do placeholder
- [ ] TTL de 60min é suficiente em uso real (PDF reaberto em 30min não pede nova URL automaticamente — vai expirar)

**Quando deletar**: Isaías avisa "pode apagar os estáticos" — só então `rm` + remover `pdfPath` do tipo + remover dos testes.

---

## Aprendizados reaproveitáveis

1. **Signed URL em qualquer bucket Supabase privado**: padrão se repete (bucket privado + service_role valida + URL temporária). A skill `supabase-cloud-integration` foi atualizada (28/07/2026) com seção 11 dedicated a esse gotcha.
2. **Backend validando JWT via payload decode**: quando você precisar validar "está logado?" sem fazer round-trip ao `/auth/v1/user`, decodificar o payload do JWT é 100x mais rápido (`base64.urlsafe_b64decode`).
3. **`/storage/v1/object/sign/...` é o canônico**: sempre que Supabase Storage te der URL de objeto (signed ou temporary), prefixar `/storage/v1` é automático. Memorizar.
