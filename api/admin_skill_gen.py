#!/usr/bin/env python3
# admin_skill_gen.py — P10 Isaías 24/08/2026
#
# Ferramenta EXCLUSIVA do admin pra gerar skill de Mentor a partir de qualquer
# ebook do catálogo Supabase. Sem cobrança, sem user comum.
#
# Pipeline:
#   1. Recebe {book_slug} do admin
#   2. Exporta texto do Supabase (ebook_pages) pra /tmp/<slug>.txt
#   3. Roda skill book-to-skill via hermes CLI → gera SKILL.md + chapters/ + glossary/patterns/cheatsheet
#   4. Copia resultado pra ~/.hermes/profiles/leitor-inteligente/skills/<slug>/
#   5. Marca ebooks.skill_generated = true no Supabase
#
# Server: porta 9140 (escolhida pra não conflitar com leitor-inteligente-api 9120,
# semantic 9131, upload 9122 etc). Roda em background via systemd.

import json, os, re, shutil, subprocess, sys, tempfile, traceback, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# --- Config ---------------------------------------------------------------

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://yfnzlowtgnlqizobnslh.supabase.co')
SUPABASE_SR = os.environ.get('SUPABASE_SERVICE_ROLE') or ''

def _try_load_env(path: Path, key: str) -> str:
    if not path.exists():
        return ''
    try:
        for ln in path.read_text().splitlines():
            ln = ln.strip()
            if ln.startswith(f'{key}='):
                val = ln.split('=', 1)[1].strip()
                if val.startswith('"') and val.endswith('"'):
                    val = val[1:-1]
                elif val.startswith("'") and val.endswith("'"):
                    val = val[1:-1]
                return val
    except (PermissionError, OSError):
        pass
    return ''

if not SUPABASE_SR:
    # Tenta várias fontes de env (systemd > perfil > cofre)
    SUPABASE_SR = (
        _try_load_env(Path('/root/.hermes/secrets/leitor-supabase.env'), 'SUPABASE_SERVICE_ROLE')
        or _try_load_env(Path('/root/.hermes/profiles/leitor-inteligente/.env'), 'SUPABASE_SERVICE_ROLE')
        or _try_load_env(Path('/root/.hermes/profiles/leitor-inteligente/.env'), 'SUPABASE_SERVICE_KEY')
        or ''
    )

if not SUPABASE_URL or SUPABASE_URL == 'https://yfnzlowtgnlqizobnslh.supabase.co':
    loaded_url = (
        _try_load_env(Path('/root/.hermes/secrets/leitor-supabase.env'), 'SUPABASE_URL')
        or _try_load_env(Path('/root/.hermes/profiles/leitor-inteligente/.env'), 'SUPABASE_URL')
        or ''
    )
    if loaded_url:
        SUPABASE_URL = loaded_url

PROFILE_DIR = Path('/root/.hermes/profiles/leitor-inteligente')
SKILLS_ROOT = PROFILE_DIR / 'skills'
SOUL_PATH = PROFILE_DIR / 'SOUL.md'
EXPORT_DIR = Path('/tmp/leitor-skill-gen')
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'jose.isaias@alunos.ifsuldeminas.edu.br')

# Isaías (24/08) é o único admin — validamos via Supabase profiles.role='admin'.
# Mas como a rota já fica atrás do JWT do leitor-inteligente-api (proxy Nginx),
# a gente confia que só o Isaías chega aqui com Authorization válida.

# --- Helpers Supabase -----------------------------------------------------

def supa_get(path):
    req = Request(
        f'{SUPABASE_URL}/rest/v1/{path}',
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
    )
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def supa_patch(table, filters, body):
    req = Request(
        f'{SUPABASE_URL}/rest/v1/{table}?{filters}',
        data=json.dumps(body).encode(),
        headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                 'Content-Type': 'application/json',
                 'Prefer': 'return=minimal'},
        method='PATCH',
    )
    try:
        with urlopen(req, timeout=15) as r:
            return True
    except HTTPError as e:
        print(f'[admin-skill-gen] PATCH {table} {filters} failed: {e.code} {e.read()[:200]}', flush=True)
        return False

# --- Pipeline -------------------------------------------------------------

def export_book_text(slug: str) -> dict:
    """Busca ebook pelo slug, exporta page_text concatenado pra /tmp/<slug>.txt.
    Retorna {ok, txt_path, total_pages, total_chars, title, author}."""
    try:
        ebooks = supa_get(f'ebooks?select=id,title,author,slug&slug=eq.{slug}&limit=1')
        if not ebooks:
            return {'ok': False, 'error': f'Livro slug="{slug}" não encontrado no Supabase'}
        book = ebooks[0]
        ebook_id = book['id']

        # ebook_pages tem page_text — concatena tudo na ordem
        pages = supa_get(
            f'ebook_pages?select=page_number,page_text&ebook_id=eq.{ebook_id}&order=page_number&limit=2000'
        )
        if not pages:
            return {'ok': False, 'error': f'ebook_pages vazio pra ebook_id={ebook_id} (livro sem texto extraído?)'}

        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        txt_path = EXPORT_DIR / f'{slug}.txt'
        with open(txt_path, 'w', encoding='utf-8') as f:
            for p in pages:
                f.write(f"\n\n=== Página {p['page_number']} ===\n\n")
                f.write((p.get('page_text') or '').strip())
                f.write('\n')

        total_chars = txt_path.stat().st_size
        print(f'[admin-skill-gen] export ok: {txt_path} ({len(pages)} páginas, {total_chars} chars)', flush=True)
        # Captura os primeiros ~600 chars do arquivo PRA INJETAR no prompt do
        # LLM (evita ele alucinar o autor).
        first_chars = ''
        with open(txt_path, 'r', encoding='utf-8') as f:
            first_chars = f.read(600)
        return {
            'ok': True,
            'txt_path': str(txt_path),
            'total_pages': len(pages),
            'total_chars': total_chars,
            'title': book.get('title', slug),
            'author': book.get('author') or 'Desconhecido',
            'first_chars': first_chars,
        }
    except Exception as e:
        print(f'[admin-skill-gen] export error: {e}\n{traceback.format_exc()}', flush=True)
        return {'ok': False, 'error': str(e)}

def run_book_to_skill(txt_path: str, skill_slug: str, title: str = '', author: str = '', first_chars_in: str = '', mode: str = 'analyze') -> dict:
    """Roda a skill book-to-skill via hermes CLI modo-autor.
    Recebe o output bruto do hermes e extrai o relatório estruturado da resposta.
    Se o hermes não gerar ANALYSIS.md em disco, captura o output do stdout."""
    wrapper = Path('/root/.local/bin/modo-autor')
    if not wrapper.exists():
        return {'ok': False, 'error': f'Wrapper {wrapper} não encontrado'}

    tmp_skill_dir = EXPORT_DIR / f'_skill_{skill_slug}'
    if tmp_skill_dir.exists():
        shutil.rmtree(tmp_skill_dir)
    tmp_skill_dir.mkdir(parents=True)

    # Prompt pro hermes (modo-autor): extrai frameworks do livro e retorna um
    # relatório markdown. A gente captura o stdout dele e extrai a parte útil.
    # Injeta título + autor + snippet inicial do livro pra evitar alucinação
    # do autor (tipo "Deepak Chopra" em vez do autor real).
    first_chars = ''
    if first_chars_in:
        first_chars = first_chars_in[:600]
    prompt = (
        f'Você é um mentor que vai ANALISAR um livro pra criar uma skill dele.\n\n'
        f'METADADOS AUTORIZADOS (use SOMENTE estes — não invente autor):\n'
        f'- Título: {title}\n'
        f'- Autor: {author}\n'
        f'- Idioma do livro: PORTUGUÊS (responda em PT-BR).\n\n'
        f'PRIMEIRAS LINHAS DO LIVRO (controle de identidade):\n'
        f'"""{first_chars}..."""\n\n'
        f'INSTRUÇÕES:\n'
        f'1. Abra o arquivo {txt_path} com cat/head/tail ou similar pra ler o livro.\n'
        f'2. Identifique até 5 FRAMEWORKS principais (modelos mentais estruturados do autor acima).\n'
        f'3. Liste até 8 PRINCÍPIOS (regras duráveis que guiam decisões do autor acima).\n'
        f'4. Liste até 10 TÉCNICAS (passos práticos que o autor acima ensina).\n'
        f'5. Liste até 5 ANTI-PATTERNS (o que o autor acima recomenda evitar).\n'
        f'6. Calibre a VOZ DO AUTOR (tom, estilo, metáforas recorrentes do autor acima).\n\n'
        f'OUTPUT OBRIGATÓRIO (markdown puro, sem preâmbulo, RESPONDA EM PORTUGUÊS):\n\n'
        f'## Frameworks\n'
        f'1. **Nome do Framework** — descrição em 1-2 frases\n'
        f'2. **Outro Framework** — ...\n\n'
        f'## Princípios\n'
        f'1. Princípio 1\n'
        f'2. ...\n\n'
        f'## Técnicas\n'
        f'1. Técnica 1\n'
        f'2. ...\n\n'
        f'## Anti-patterns\n'
        f'1. Anti-pattern 1\n'
        f'2. ...\n\n'
        f'## Voz do autor\n'
        f'Descrição do tom e estilo (2-3 frases).\n\n'
        f'NÃO use tool calls. NÃO salve arquivos. NÃO fale em inglês. '
        f'Responda SÓ com o markdown acima.'
    )

    print(f'[admin-skill-gen] rodando hermes modo-utor analyze...', flush=True)
    try:
        proc = subprocess.run(
            ['sudo', '-E', 'HOME=/root', str(wrapper), 'chat', '-q', prompt],
            capture_output=True, text=True, timeout=600,
            env={**os.environ, 'HOME': '/root'},
        )
        stdout = proc.stdout or ''
        stderr = proc.stderr or ''
        if proc.returncode != 0:
            return {
                'ok': False,
                'error': f'hermes exit {proc.returncode}',
                'stderr': stderr[-1000:],
            }

        # Extrai o markdown da resposta (entre o último separador de "Reasoning"
        # e qualquer coisa depois). Heurística simples: procura "## Frameworks".
        analysis_md = _extract_analysis(stdout)
        if not analysis_md:
            analysis_path = tmp_skill_dir / 'ANALYSIS.md'
            analysis_path.write_text(
                f'# Análise não extraída automaticamente\n\n'
                f'O hermes respondeu mas não conseguimos extrair o markdown estruturado.\n\n'
                f'## Stdout bruto (último 3000 chars)\n\n```\n{stdout[-3000:]}\n```',
                encoding='utf-8',
            )
            return {
                'ok': True,
                'skill_dir': str(tmp_skill_dir),
                'analysis_path': str(analysis_path),
                'warning': 'analysis extraído via fallback (heurística falhou)',
            }

        analysis_path = tmp_skill_dir / 'ANALYSIS.md'
        analysis_path.write_text(analysis_md, encoding='utf-8')
        return {
            'ok': True,
            'skill_dir': str(tmp_skill_dir),
            'analysis_path': str(analysis_path),
        }
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'Timeout 600s — análise muito lenta, tente novamente'}
    except Exception as e:
        return {'ok': False, 'error': f'subprocess erro: {e}'}


def _extract_analysis(stdout: str) -> str:
    """Extrai o bloco markdown estruturado da resposta do hermes.
    O hermes envolve a resposta em um box ASCII com ╭─ ... ╰─. Pega SÓ o
    conteúdo entre esses dois delimitadores quando ambos aparecem."""
    # Estratégia 1: pegar o bloco ASCII box do hermes (o que tá entre ╭─ e ╰─)
    box_re = re.search(r'╭[─\s\S]+?╮\s*\n([\s\S]+?)\n╰[─\s\S]+?╯', stdout)
    if box_re:
        block = box_re.group(1).strip()
        # sanity: tem que ter conteúdo estruturado (markdown sections)
        if 'Frameworks' in block and 'Princípios' in block:
            return block

    # Estratégia 2 fallback: procura ## Frameworks e captura
    if '## Frameworks' in stdout:
        start = stdout.index('## Frameworks')
        end = len(stdout)
        for marker in ['Resume this session', 'Session:', 'hermes --resume', '┌─ Reasoning ─']:
            if marker in stdout[start:]:
                end = start + stdout[start:].index(marker)
                break
        block = stdout[start:end].strip()
        if len(block) > 100:
            return block

    return ''

def build_skill_files(skill_slug: str, title: str, author: str, analysis_md: str) -> dict:
    """Monta SKILL.md enxuto + cheatsheet.md a partir da ANALYSIS.md.
    Estrutura idêntica à o-poder-do-habito (validada 23/08 pelo Isaías)."""
    skill_dir = SKILLS_ROOT / skill_slug
    if skill_dir.exists():
        shutil.rmtree(skill_dir)
    skill_dir.mkdir(parents=True)
    chapters_dir = skill_dir / 'chapters'
    chapters_dir.mkdir()

    # SKILL.md: frontmatter + modelo mental + frameworks extraídos + voz do mentor
    skill_md = f'''---
name: {skill_slug}
description: "Frameworks, princípios e padrões de {author} extraídos do livro '{title}'. Use quando alguém quiser entender, aplicar ou diagnosticar situações usando o método do autor."
---

# {title} — {author}

**Gerado em:** 2026-08-24 via ferramenta admin P10 (Leitor Inteligente)
**Skill gerada por:** book-to-skill (modo Analyze Only) + montagem manual no Admin
**Modo:** Mentor, narrativa em 1ª pessoa (não assume ser o autor)
**Pipeline:** export Supabase ebook_pages → análise LLM → SKILL.md enxuto

---

## Análise do livro (extraída automaticamente)

{analysis_md}

---

## Como usar esta skill (com o Professor IA do Leitor)

Quando o usuário perguntar algo sobre o tema do livro, **raciocine primeiro pelo framework** mais relevante, depois use o RAG pra confirmar com trechos literais:

1. **Identifique o framework mais relevante** na seção acima
2. **Aplique o framework** na pergunta do usuário (raciocínio dedutivo)
3. **Valide com RAG** se houver citação específica do autor (carregue `ebook_pages` se precisar)
4. **Responda com voz do Mentor** — não "{author} disse X", mas "na minha experiência aplicando o método dele, isso significa que..."

⚠️ **Limites:** não invente citações literais. Use o livro pra validar, não pra "lembrar" de memória. Se não souber, diga.

---

## Arquivos desta skill

- `SKILL.md` — este arquivo
- `ANALYSIS.md` — análise crua gerada pelo book-to-skill (referência)
- `cheatsheet.md` — tabela de decisão rápida dos frameworks

---

**Aviso copyright:** Esta skill é privada. Gerada localmente pra uso pessoal de Isaías Lima no Leitor Inteligente. Não redistribuir.
'''

    (skill_dir / 'SKILL.md').write_text(skill_md, encoding='utf-8')

    # cheatsheet.md: tabela simples framework → aplicação
    cheatsheet_md = f'''# Cheatsheet — {title}

| Framework | Quando aplicar |
|---|---|
| (preencha depois de testar) | — |
| (preencha depois de testar) | — |
| (preencha depois de testar) | — |

> Cheatsheet provisório — Isaías valida com 3-5 perguntas reais antes de expandir.
'''
    (skill_dir / 'cheatsheet.md').write_text(cheatsheet_md, encoding='utf-8')

    # Cópia do ANALYSIS.md pra referência
    (skill_dir / 'ANALYSIS.md').write_text(analysis_md, encoding='utf-8')

    return {
        'ok': True,
        'skill_dir': str(skill_dir),
        'files': sorted(p.name for p in skill_dir.rglob('*') if p.is_file()),
    }

def update_soul_md(skill_slug: str, title: str):
    """Adiciona linha na seção 'Skills geradas via book-to-skill' do SOUL.md
    se ainda não existir."""
    if not SOUL_PATH.exists():
        print(f'[admin-skill-gen] SOUL.md não encontrado em {SOUL_PATH}', flush=True)
        return False
    soul = SOUL_PATH.read_text(encoding='utf-8')
    if skill_slug in soul:
        return True  # já registrada
    # Procura a seção "Skills geradas" e adiciona linha
    marker = '## Skills geradas via book-to-skill'
    if marker not in soul:
        soul += f'\n\n{marker}\n\n- `{skill_slug}/` — {title}\n'
    else:
        soul += f'- `{skill_slug}/` — {title}\n'
    SOUL_PATH.write_text(soul, encoding='utf-8')
    print(f'[admin-skill-gen] SOUL.md atualizado: {skill_slug}', flush=True)
    return True

# --- HTTP -----------------------------------------------------------------

def send_json(handler, code, obj):
    body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    handler.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
    handler.end_headers()
    handler.wfile.write(body)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        pass  # silencia log padrão

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            return send_json(self, 200, {'status': 'ok', 'service': 'admin-skill-gen'})
        if self.path == '/list-skills':
            # Lista skills já geradas (diretórios em ~/.hermes/profiles/leitor-inteligente/skills/)
            skills = []
            if SKILLS_ROOT.exists():
                for d in sorted(SKILLS_ROOT.iterdir()):
                    # Pula dotfiles (.curator_backups etc) e arquivos soltos
                    if not d.is_dir() or d.name.startswith('.'):
                        continue
                    try:
                        skill_md = d / 'SKILL.md'
                        if skill_md.exists():
                            skills.append({'slug': d.name, 'skill_md_size': skill_md.stat().st_size})
                    except (PermissionError, OSError) as e:
                        print(f'[admin-skill-gen] skip {d}: {e}', flush=True)
                        continue
            return send_json(self, 200, {'skills': skills, 'count': len(skills)})
        return send_json(self, 404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/generate-skill':
            return send_json(self, 404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n))
            book_slug = str(data.get('book_slug') or data.get('slug') or '').strip()
            if not book_slug:
                return send_json(self, 400, {'error': 'book_slug obrigatório'})
            mode = str(data.get('mode', 'analyze'))  # 'analyze' | 'full'
            print(f'[admin-skill-gen] POST generate-skill slug={book_slug} mode={mode}', flush=True)

            # Step 1: exporta texto
            exp = export_book_text(book_slug)
            if not exp['ok']:
                return send_json(self, 400, exp)

            # Step 2: roda book-to-skill analyze
            gen = run_book_to_skill(
                exp['txt_path'], book_slug,
                title=exp['title'], author=exp['author'],
                first_chars_in=exp.get('first_chars', ''),
                mode=mode,
            )
            if not gen['ok']:
                return send_json(self, 500, gen)

            # Step 3: monta SKILL.md + cheatsheet no padrão validado
            analysis_md = Path(gen['analysis_path']).read_text(encoding='utf-8')
            built = build_skill_files(book_slug, exp['title'], exp['author'], analysis_md)

            # Step 4: atualiza SOUL.md
            update_soul_md(book_slug, exp['title'])

            # Step 5: marca ebooks.skill_generated = true
            try:
                # Busca ebook_id pra fazer o PATCH
                ebooks = supa_get(f'ebooks?select=id&slug=eq.{book_slug}&limit=1')
                if ebooks:
                    supa_patch(
                        'ebooks',
                        f'id=eq.{ebooks[0]["id"]}',
                        {'skill_generated': True, 'skill_generated_at': 'now()'},
                    )
            except Exception as e:
                print(f'[admin-skill-gen] WARN marcou skill_generated: {e}', flush=True)

            return send_json(self, 200, {
                'ok': True,
                'slug': book_slug,
                'title': exp['title'],
                'author': exp['author'],
                'total_pages': exp['total_pages'],
                'total_chars': exp['total_chars'],
                'skill_dir': built['skill_dir'],
                'files': built['files'],
            })
        except Exception as e:
            print(f'[admin-skill-gen] ERROR: {e}\n{traceback.format_exc()}', flush=True)
            return send_json(self, 500, {'error': str(e)[:500]})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '9141'))
    print(f'admin-skill-gen: porta {port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
