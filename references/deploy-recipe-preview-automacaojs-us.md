# Deploy a `preview.automacaojs.us` — receita rápida

Esta VPS já tem o stack completo pra servir PWA estática:

- **nginx vhost** em `/var/www/preview/` (porta 9121, server_name `preview.automacaojs.us`)
- **Cloudflare Tunnel** `0e98caf0-6c37-4dad-965f-4f324a244619` roteando `*.automacaojs.us` pra origem local
- **Certificado TLS** via Cloudflare (proxied=true) — HTTPS válido automaticamente

Custo de deploy de 1 PWA: **1 comando `rsync` + 4 `curl` pra validar**.

## Quando usar (vs Vercel)

✅ **Use preview.automacaojs.us:**
- Protótipo, demo interna, validação de produto
- URL pública funcionando sem fricção de token/conta
- Cliente não precisa de domínio próprio

❌ **Use Vercel (skill `vercel-deploy-cli`):**
- Cliente quer domínio próprio (`meu-cliente.com.br`)
- Isaías pedir explicitamente "publica na Vercel"
- Demo pra fora do ecossistema `automacaojs.us`

## Receita (validada 28/07/2026, sessão "O Poder do Hábito")

```bash
# Pré-requisito: nginx + cloudflared rodando (já estão nesta VPS)
systemctl is-active nginx        # active
systemctl is-active cloudflared  # active

# 1. Build local
cd ~/projetos/<slug>
npm test      # 6+ testes verdes
npm run build # exit 0, gera dist/

# 2. rsync pro nginx (NÃO precisa sudo se /var/www/preview é do root)
mkdir -p /var/www/preview/<slug>
rsync -a --delete dist/ /var/www/preview/<slug>/
# --delete garante remoção de arquivos velhos do build anterior

# 3. Smoke test 4 URLs em paralelo (curl com -w só pra status)
APP_URL="https://preview.automacaojs.us/<slug>"
curl -sS -o /dev/null -w "app=%{http_code}\n" "$APP_URL/"
curl -sS -o /dev/null -w "pdf=%{http_code} bytes=%{size_download}\n" "$APP_URL/books/<slug>.pdf"
curl -sS -o /dev/null -w "manifest=%{http_code}\n" "$APP_URL/manifest.webmanifest"
curl -sS -o /dev/null -w "sw=%{http_code}\n" "$APP_URL/sw.js"

# Esperado: app=200, pdf=200 (≈ tamanho do PDF original), manifest=200, sw=200

# 4. Validação de conteúdo (HTML e PDF realmente servem o app certo)
curl -sS "$APP_URL/" | grep -oE '<title>[^<]+</title>'
# Esperado: <title>Leitor Inteligente</title> (ou nome do seu app)

curl -sS -o /dev/null -w "pdf_ct=%{content_type} size=%{size_download}\n" "$APP_URL/books/<slug>.pdf"
# Esperado: pdf_ct=application/pdf size=4011553 (≈ 4MB pro O Poder do Hábito)
```

## Path routing

URL pública = path do diretório. Sem precisar de config:

```
/var/www/preview/leitor-inteligente/  →  https://preview.automacaojs.us/leitor-inteligente/
/var/www/preview/outro-app/          →  https://preview.automacaojs.us/outro-app/
```

`index.html` na raiz do diretório = nginx serve automaticamente (default index).

## Quando precisar de sub-routes (ex: `/leitor/<bookId>/`)

nginx padrão já roteia — basta criar a estrutura de pastas:
```bash
mkdir -p /var/www/preview/leitor-inteligente/leitor/habit-book
# Conteúdo entra aqui, URL = https://preview.automacaojs.us/leitor-inteligente/leitor/habit-book/
```

**Em SPAs (React/Vite),** a navegação cliente-side é controlada pelo React Router, não pelo nginx. Não precisa de `try_files` pra SPA fallback se você **NÃO** usa URLs diretas em sub-routes (`/habit-book` sem `#`). Se usar `BrowserRouter` com URLs reais (`/book/habit-book`), aí sim precisa:

```nginx
# /etc/nginx/sites-available/preview.conf (snippet)
location /leitor-inteligente/ {
    try_files $uri $uri/ /leitor-inteligente/index.html;
}
```

`sudo nginx -t && sudo systemctl reload nginx` pra aplicar.

## Pitfalls específicos do `preview.automacaojs.us`

1. **`VERCEL_TOKEN` pode estar faltando no `.env`** — verificado 28/07/2026:
   ```bash
   grep -c '^VERCEL_TOKEN=' /root/.hermes/.env  # = 0
   ```
   Se Isaías pedir deploy Vercel, pedir o token antes de tentar (`vercel whoami` falha com "No existing credentials found").

2. **Cloudflare Tunnel em modo `service: http_status:404`** — se a URL retornar 404 e o tunnel tá UP, falta regra de ingress pro hostname OU o path não bate com `service: http://localhost:9121`. Ver `cf-tunnel-add-hostname` skill.

3. **PWA service worker exige HTTPS válido** — `preview.automacaojs.us` já tem (Cloudflare proxied=true). NUNCA testar PWA em `http://127.0.0.1` local — SW não registra, install prompt não aparece, manifest dá warning.

4. **Cache do service worker pode segurar versão antiga** — após deploy novo, forçar reload com `Ctrl+Shift+R` ou `chrome://serviceworker-internals` → unregister. Em produção, `vite-plugin-pwa` com `registerType: 'autoUpdate'` cuida disso na próxima visita.

5. **`/var/www/preview/` é do root** — `rsync` direto pode funcionar se seu user tem permissão de leitura em `dist/`. Se der `Permission denied`, `sudo rsync` ou `chown -R root:root /var/www/preview/<slug>/` depois.

## Verificação rápida do tunnel + nginx

```bash
# Tunnel
systemctl is-active cloudflared    # active
curl -sSI https://preview.automacaojs.us/ | head -1  # HTTP/2 200

# Nginx
systemctl is-active nginx         # active
curl -sSI http://127.0.0.1:9121/ | head -1           # HTTP/1.1 200

# DNS
dig +short preview.automacaojs.us  # 188.114.97.3 (Cloudflare Anycast)
```

Se algum desses falhar, ver skill `cf-tunnel-add-hostname` (Pitfall #8 — 521 vs 404) ou `cloudflared-recovery` (tunnel crash loop).