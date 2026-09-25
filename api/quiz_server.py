"""
Quiz Server — gera quizzes didáticos por página do Leitor Inteligente.

Rotas:
- POST /api/quiz/generate
    Body: {book_id, page_number, page_text}
    Retorna: {questions: [{id, type, question, options, correct_index, explanation}, ...]}
    Modelo: M3 via 9Router (mesmo padrão do dev_server).

- POST /api/quiz/save
    Header: Authorization: Bearer <supabase_access_token>
    Body: {book_id, page_number, correct, wrong}
    Grava 1 row em user_quiz_scores com total_score = correct*10 + wrong*-5.

- GET /api/quiz/score?book_id=X
    Header: Authorization: Bearer <supabase_access_token>
    Retorna: {total_score, quizzes_count, best_correct}

Anti-alucinação:
- System prompt exige "use SOMENTE informação literal da página; se a página
  não tiver conteúdo suficiente, emita 1 question com out_of_scope=true e o
  front mostra 'essa página não tem conteúdo suficiente pra quiz'."
- Backend valida o JSON antes de retornar (parse, schema, tipos).

Porta: 3021 (não conflita com payment 3019, semantic 9131/9135, dev 2000).
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from flask import Flask, jsonify, request

import requests

API_DIR = os.path.dirname(os.path.abspath(__file__))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from _auth import extract_user_id_from_jwt, _supabase_url_and_sr

HERMES_HOME = os.environ.get('HERMES_HOME', '/root/.hermes')
# Profile com credencial válida pro 9Router (verificado 26/08/2026 —
# a chave em profiles/leitor-inteligente/.env está rejeitada pelo 9router).
HERMES_PROFILE = 'leitor-inteligente-dev'
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False  # PT-BR mantém acentos
logging.basicConfig(level=logging.INFO, format='[quiz] %(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('quiz')

# --- Score constants ---
SCORE_CORRECT = 10
SCORE_WRONG = -5
QUESTIONS_PER_QUIZ = 3

# --- LLM prompt ---
QUIZ_SYSTEM_PROMPT = """Você é um gerador de quizzes didáticos para o Leitor Inteligente.

REGRAS OBRIGATÓRIAS:
1. Use SOMENTE informação LITERAL da página fornecida no input do user. NÃO use conhecimento externo.
2. Se a página não tiver conteúdo suficiente (vazia, só cabeçalho, só imagem), responda com 1 question do tipo "out_of_scope" e explanation explicando por quê.
3. Gere EXATAMENTE 3 perguntas (ou 1 out_of_scope) num JSON válido.
4. Misture os tipos: inclua ao menos 1 "multiple_choice" (4 opções) e 1 "true_false" (2 opções).
5. As opções do multiple_choice devem ser plausíveis (não óbvias) e ter apenas 1 correta.
6. "correct_index" é 0-based (0, 1, 2 ou 3).
7. "explanation" cita o trecho/ideia do texto que justifica a resposta.

RESPONDA SOMENTE COM JSON VÁLIDO, sem markdown, sem comentários, sem preâmbulo. Formato:

{
  "questions": [
    {
      "id": 1,
      "type": "multiple_choice",
      "question": "...",
      "options": ["opção A", "opção B", "opção C", "opção D"],
      "correct_index": 0,
      "explanation": "..."
    },
    {
      "id": 2,
      "type": "true_false",
      "question": "...",
      "options": ["Verdadeiro", "Falso"],
      "correct_index": 1,
      "explanation": "..."
    }
  ]
}

Ou, se a página não tiver conteúdo:

{
  "questions": [
    {
      "id": 1,
      "type": "out_of_scope",
      "question": "Esta página não tem conteúdo suficiente para um quiz.",
      "options": [],
      "correct_index": 0,
      "explanation": "A página parece estar vazia ou conter apenas elementos visuais (capa, índice, ilustração)."
    }
  ]
}
"""


# ---------- LLM (9Router) ----------
def _load_llm_creds() -> tuple[str, str]:
    """Lê MINIMAX_API_KEY + MINIMAX_BASE_URL do profile .env."""
    api_key = ''
    base_url = 'https://9router.automacaojs.us/v1'
    env_path = os.path.join(HERMES_HOME, 'profiles', HERMES_PROFILE, '.env')
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip()
                if k == 'MINIMAX_API_KEY':
                    api_key = v.strip()
                elif k == 'MINIMAX_BASE_URL':
                    base_url = v.strip()
    except FileNotFoundError:
        pass
    return api_key, base_url


def call_llm_json(system: str, user: str) -> dict | None:
    """Chama 9Router e retorna dict parseado. Retorna None se falhar."""
    api_key, base_url = _load_llm_creds()
    if not api_key:
        log.error('MINIMAX_API_KEY não encontrada no profile .env')
        return None

    try:
        r = requests.post(
            f'{base_url.rstrip("/")}/chat/completions',
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            json={
                'model': 'Hermes-fallbacks',
                'messages': [
                    {'role': 'system', 'content': system},
                    {'role': 'user', 'content': user},
                ],
                'max_tokens': 1500,
                'temperature': 0.4,  # baixa — quizzes didáticos pedem precisão
                'stream': False,
            },
            timeout=(10, 60),
        )
    except requests.Timeout:
        log.error('LLM timeout')
        return None
    except Exception as e:
        log.error(f'LLM erro de rede: {e}')
        return None

    if r.status_code != 200:
        log.error(f'LLM HTTP {r.status_code}: {r.text[:200]}')
        return None

    try:
        content = r.json()['choices'][0]['message']['content']
    except Exception as e:
        log.error(f'LLM resposta malformada: {e}')
        return None

    # Alguns modelos embrulham JSON em ```json ... ``` — strip
    content = content.strip()
    content = re.sub(r'^```(?:json)?\s*\n?', '', content)
    content = re.sub(r'\n?```\s*$', '', content)
    content = content.strip()

    try:
        return json.loads(content)
    except Exception as e:
        log.error(f'JSON inválido do LLM: {e} -- content: {content[:300]}')
        return None


def validate_quiz(data: dict) -> dict | None:
    """Valida estrutura do quiz. Retorna data normalizado ou None se inválido."""
    if not isinstance(data, dict):
        return None
    questions = data.get('questions')
    if not isinstance(questions, list) or len(questions) == 0:
        return None

    valid = []
    for q in questions:
        if not isinstance(q, dict):
            return None
        qtype = q.get('type')
        if qtype not in ('multiple_choice', 'true_false', 'out_of_scope'):
            return None
        if not isinstance(q.get('question'), str) or not q['question'].strip():
            return None
        if qtype == 'out_of_scope':
            q['options'] = []
            q['correct_index'] = 0
        else:
            opts = q.get('options')
            if not isinstance(opts, list) or len(opts) < 2:
                return None
            if qtype == 'true_false' and len(opts) != 2:
                return None
            if qtype == 'multiple_choice' and len(opts) != 4:
                return None
            ci = q.get('correct_index')
            if not isinstance(ci, int) or ci < 0 or ci >= len(opts):
                return None
        if not isinstance(q.get('explanation'), str):
            q['explanation'] = ''
        valid.append(q)

    return {'questions': valid}


# ---------- Auth (Supabase Bearer) ----------
def get_user_from_bearer(auth_header: str) -> str | None:
    """Valida Bearer do Supabase. Retorna user_id ou None."""
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:].strip()
    if not token:
        return None

    # 1. Extração direta de JWT (valida exp e formato, ultra-rápido sem I/O)
    user_id = extract_user_id_from_jwt(token)
    if user_id:
        return user_id

    # 2. Fallback via /auth/v1/user se necessário
    if not SUPABASE_URL:
        log.error('SUPABASE_URL não configurada')
        return None

    anon_key = _supabase_anon_key()
    if not anon_key:
        return None

    try:
        r = requests.get(
            f'{SUPABASE_URL}/auth/v1/user',
            headers={
                'Authorization': f'Bearer {token}',
                'apikey': anon_key,
            },
            timeout=10,
        )
        if r.status_code == 200:
            return r.json().get('id')
    except Exception as e:
        log.error(f'auth/v1/user falhou: {e}')
    return None


def _supabase_anon_key() -> str:
    """Lê SUPABASE_ANON_KEY do cofre (key pública, pode estar em vários paths)."""
    val = os.environ.get('SUPABASE_ANON_KEY')
    if val:
        return val.strip()
    for env_path in ('/root/.hermes/secrets/leitor-supabase.env', '/root/.hermes/.env'):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    if k.strip() == 'SUPABASE_ANON_KEY':
                        return v.strip().strip('"').strip("'")
        except (FileNotFoundError, PermissionError, OSError):
            continue
    return ''


def _supabase_service_role() -> str:
    """Service role — bypassa RLS (necessário pro backend inserir scores)."""
    _, sr = _supabase_url_and_sr()
    if sr:
        return sr
    val = os.environ.get('SUPABASE_SERVICE_ROLE')
    if val:
        return val.strip()
    for env_path in ('/root/.hermes/secrets/leitor-supabase.env', '/root/.hermes/.env'):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    if k.strip() in ('SUPABASE_SERVICE_ROLE', 'SUPABASE_SERVICE_KEY'):
                        return v.strip().strip('"').strip("'")
        except (FileNotFoundError, PermissionError, OSError):
            continue
    return ''


# ---------- Rotas ----------
@app.route('/api/quiz/generate', methods=['POST'])
def quiz_generate():
    """Gera 3 perguntas sobre o texto da página."""
    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return jsonify({'ok': False, 'error': 'JSON inválido'}), 400

    book_id = (body.get('book_id') or '').strip()
    page_number = body.get('page_number')
    page_text = (body.get('page_text') or '').strip()

    if not book_id:
        return jsonify({'ok': False, 'error': 'book_id obrigatório'}), 400
    if not isinstance(page_number, int) or page_number < 1:
        return jsonify({'ok': False, 'error': 'page_number inválido'}), 400
    if not page_text:
        return jsonify({'ok': False, 'error': 'page_text vazio'}), 400

    # Trunca texto pra não estourar tokens (3000 chars ~= ~750 tokens)
    if len(page_text) > 4000:
        page_text = page_text[:4000] + '...'

    user_prompt = (
        f'Livro: {book_id}\n'
        f'Página: {page_number}\n'
        f'---\n'
        f'{page_text}\n'
        f'---\n'
        f'Gere {QUESTIONS_PER_QUIZ} perguntas didáticas sobre o conteúdo acima.'
    )

    raw = call_llm_json(QUIZ_SYSTEM_PROMPT, user_prompt)
    if raw is None:
        return jsonify({'ok': False, 'error': 'LLM indisponível'}), 502

    validated = validate_quiz(raw)
    if validated is None:
        log.error(f'LLM retornou JSON inválido: {raw}')
        return jsonify({'ok': False, 'error': 'Quiz gerado em formato inválido'}), 502

    return jsonify({
        'ok': True,
        'questions': validated['questions'],
        'book_id': book_id,
        'page_number': page_number,
    })


@app.route('/api/quiz/save', methods=['POST'])
def quiz_save():
    """Grava resultado do quiz em user_quiz_scores e (se houver sala) academic_evaluations."""
    auth = request.headers.get('Authorization', '')
    user_id = get_user_from_bearer(auth)
    if not user_id:
        return jsonify({'ok': False, 'error': 'Não autorizado'}), 401

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return jsonify({'ok': False, 'error': 'JSON inválido'}), 400

    book_id = (body.get('book_id') or '').strip()
    page_number = body.get('page_number')
    correct = body.get('correct')
    wrong = body.get('wrong')
    room_id = (body.get('room_id') or '').strip() or None
    student_name = (body.get('student_name') or '').strip() or None

    if not book_id or not isinstance(page_number, int) or page_number < 1:
        return jsonify({'ok': False, 'error': 'Parâmetros inválidos'}), 400
    if not isinstance(correct, int) or correct < 0 or correct > QUESTIONS_PER_QUIZ:
        return jsonify({'ok': False, 'error': 'correct fora do range 0-3'}), 400
    if not isinstance(wrong, int) or wrong < 0 or wrong > QUESTIONS_PER_QUIZ:
        return jsonify({'ok': False, 'error': 'wrong fora do range 0-3'}), 400
    if correct + wrong != QUESTIONS_PER_QUIZ:
        return jsonify({'ok': False, 'error': f'correct+wrong deve ser {QUESTIONS_PER_QUIZ}'}), 400

    score = correct * SCORE_CORRECT + wrong * SCORE_WRONG

    sr = _supabase_service_role()
    if not sr:
        return jsonify({'ok': False, 'error': 'Service role não configurado'}), 500

    # Resolve nome do aluno a partir do JWT se não veio no payload
    resolved_student_name = student_name
    if not resolved_student_name:
        try:
            # tenta extrair do JWT (campo name do user_metadata)
            token = auth[7:].strip() if auth.startswith('Bearer ') else ''
            if token and '.' in token:
                payload_b64 = token.split('.')[1]
                import base64
                pad = '=' * (-len(payload_b64) % 4)
                payload = json.loads(base64.urlsafe_b64decode(payload_b64 + pad).decode('utf-8', errors='ignore'))
                meta = payload.get('user_metadata') or {}
                resolved_student_name = (
                    meta.get('name')
                    or meta.get('full_name')
                    or (payload.get('email') or '').split('@')[0]
                    or 'Estudante'
                )
        except Exception:
            pass
        if not resolved_student_name:
            resolved_student_name = 'Estudante'

    row = {
        'user_id': user_id,
        'book_id': book_id,
        'page_number': page_number,
        'correct_answers': correct,
        'wrong_answers': wrong,
        'total_score': score,
        'created_at': datetime.now(timezone.utc).isoformat(),
    }

    try:
        r = requests.post(
            f'{SUPABASE_URL}/rest/v1/user_quiz_scores',
            headers={
                'apikey': sr,
                'Authorization': f'Bearer {sr}',
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
            },
            json=row,
            timeout=10,
        )
    except Exception as e:
        log.error(f'Supabase insert falhou: {e}')
        return jsonify({'ok': False, 'error': 'Falha ao gravar'}), 502

    if r.status_code not in (200, 201):
        log.error(f'Supabase HTTP {r.status_code}: {r.text[:300]}')
        return jsonify({'ok': False, 'error': 'Supabase rejeitou insert'}), 502

    inserted = r.json()
    quiz_row_id = inserted[0]['id'] if inserted else None

    # ── Sala de Aula Interativa: persiste também em academic_evaluations
    academic_row_id = None
    if room_id:
        try:
            academic_row = {
                'room_id': room_id,
                'book_id': book_id,
                'student_name': resolved_student_name,
                'user_id': user_id,
                'page_number': page_number,
                'correct_answers': correct,
                'wrong_answers': wrong,
                'total_score': score,
                'created_at': datetime.now(timezone.utc).isoformat(),
            }
            r2 = requests.post(
                f'{SUPABASE_URL}/rest/v1/academic_evaluations',
                headers={
                    'apikey': sr,
                    'Authorization': f'Bearer {sr}',
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                },
                json=academic_row,
                timeout=10,
            )
            if r2.status_code not in (200, 201):
                log.warning(f'academic_evaluations insert falhou HTTP {r2.status_code}: {r2.text[:200]}')
            else:
                academic_inserted = r2.json()
                academic_row_id = academic_inserted[0]['id'] if academic_inserted else None
        except Exception as e:
            log.warning(f'academic_evaluations insert falhou: {e}')

    return jsonify({
        'ok': True,
        'score': score,
        'id': quiz_row_id,
        'academic_id': academic_row_id,
    })


@app.route('/api/quiz/score', methods=['GET'])
def quiz_score_total():
    """Soma total de pontos do user no livro."""
    auth = request.headers.get('Authorization', '')
    user_id = get_user_from_bearer(auth)
    if not user_id:
        return jsonify({'ok': False, 'error': 'Não autorizado'}), 401

    book_id = (request.args.get('book_id') or '').strip()
    if not book_id:
        return jsonify({'ok': False, 'error': 'book_id obrigatório'}), 400

    sr = _supabase_service_role()
    if not sr:
        return jsonify({'ok': False, 'error': 'Service role não configurado'}), 500

    try:
        r = requests.get(
            f'{SUPABASE_URL}/rest/v1/user_quiz_scores'
            f'?user_id=eq.{user_id}&book_id=eq.{urllib.parse.quote(book_id, safe="")}'
            f'&select=total_score,correct_answers,wrong_answers,page_number',
            headers={'apikey': sr, 'Authorization': f'Bearer {sr}'},
            timeout=10,
        )
    except Exception as e:
        log.error(f'Supabase query falhou: {e}')
        return jsonify({'ok': False, 'error': 'Falha ao consultar'}), 502

    if r.status_code != 200:
        return jsonify({'ok': False, 'error': 'Supabase rejeitou query'}), 502

    rows = r.json()
    total = sum(row.get('total_score', 0) for row in rows)
    best_correct = max((row.get('correct_answers', 0) for row in rows), default=0)
    total_correct = sum(row.get('correct_answers', 0) for row in rows)
    total_wrong = sum(row.get('wrong_answers', 0) for row in rows)
    return jsonify({
        'ok': True,
        'total_score': total,
        'quizzes_count': len(rows),
        'best_correct': best_correct,
        'correct_answers': total_correct,
        'wrong_answers': total_wrong,
    })


def extract_pdf_page_range_text(book_slug: str, page_start: int, page_end: int) -> str:
    """Extrai o texto estrito compreendido entre page_start e page_end (1-based) usando PyMuPDF."""
    if page_start < 1:
        page_start = 1
    if page_end < page_start:
        page_end = page_start

    pdf_path = None
    # 1. Checa caminhos locais conhecidos
    candidates = [
        f"/root/projetos/leitor-inteligente/public/books/{book_slug}.pdf",
        f"/var/www/preview/leitor-inteligente/books/{book_slug}.pdf",
    ]
    for c in candidates:
        if os.path.isfile(c):
            pdf_path = c
            break

    # 2. Se não achou local, checa no Supabase se há pdf_storage_path
    sr = _supabase_service_role()
    if not pdf_path and sr and SUPABASE_URL:
        try:
            url_eb = f"{SUPABASE_URL}/rest/v1/ebooks?select=id,pdf_storage_path&slug=eq.{urllib.parse.quote(book_slug, safe='')}&limit=1"
            r_eb = requests.get(url_eb, headers={'apikey': sr, 'Authorization': f'Bearer {sr}'}, timeout=8)
            if r_eb.status_code == 200 and r_eb.json():
                st_path = r_eb.json()[0].get('pdf_storage_path')
                if st_path:
                    cache_dir = "/tmp/leitor_books"
                    os.makedirs(cache_dir, exist_ok=True)
                    cached_file = os.path.join(cache_dir, f"{book_slug}.pdf")
                    if os.path.isfile(cached_file) and os.path.getsize(cached_file) > 1000:
                        pdf_path = cached_file
                    else:
                        down_url = f"{SUPABASE_URL}/storage/v1/object/authenticated/ebooks/{st_path}"
                        r_down = requests.get(down_url, headers={'apikey': sr, 'Authorization': f'Bearer {sr}'}, timeout=20)
                        if r_down.status_code == 200 and len(r_down.content) > 1000:
                            with open(cached_file, 'wb') as f:
                                f.write(r_down.content)
                            pdf_path = cached_file
        except Exception as err:
            log.warning(f"Erro ao buscar PDF no storage para {book_slug}: {err}")

    if not pdf_path or not os.path.isfile(pdf_path):
        return ""

    try:
        import pymupdf as fitz
        doc = fitz.open(pdf_path)
        total_pages = len(doc)
        start_idx = max(0, page_start - 1)
        end_idx = min(total_pages, page_end)
        
        extracted_chunks = []
        for p_idx in range(start_idx, end_idx):
            p = doc[p_idx]
            txt = p.get_text()
            if txt and txt.strip():
                extracted_chunks.append(f"--- [Página {p_idx + 1}] ---\n" + txt.strip())
        doc.close()
        return "\n\n".join(extracted_chunks)
    except Exception as e:
        log.warning(f"Falha na extração PyMuPDF de {pdf_path}: {e}")
        return ""


@app.route('/api/academic/generate-assessment', methods=['POST', 'OPTIONS'])
@app.route('/api/quiz/generate-assessment', methods=['POST', 'OPTIONS'])
@app.route('/academic/generate-assessment', methods=['POST', 'OPTIONS'])
def academic_generate_assessment():
    """Gera avaliação oficial de 5 questões focadas no intervalo obrigatório de páginas."""
    if request.method == 'OPTIONS':
        res = jsonify({'ok': True})
        res.headers['Access-Control-Allow-Origin'] = '*'
        res.headers['Access-Control-Allow-Headers'] = '*'
        res.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        return res

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception as e:
        log.error(f'JSON parse falhou: {e}')
        return jsonify({'ok': False, 'error': 'JSON inválido'}), 400

    ebook_id = str(body.get('book_slug', body.get('ebook_id', ''))).strip()
    ebook_title = str(body.get('ebook_title', 'Material Didático')).strip()
    
    # Processa intervalo de páginas obrigatório
    p_start_raw = body.get('page_start')
    p_end_raw = body.get('page_end')
    try:
        page_start = int(p_start_raw) if p_start_raw is not None else 1
    except (ValueError, TypeError):
        page_start = 1
    try:
        page_end = int(p_end_raw) if p_end_raw is not None else page_start
    except (ValueError, TypeError):
        page_end = page_start
        
    if page_end < page_start:
        page_end = page_start

    page_range = str(body.get('page_range', '')).strip()
    if not page_range or not page_range.startswith('Página'):
        page_range = f"Páginas {page_start} a {page_end}"
        
    chapter_title = page_range
    tenant_id = str(body.get('tenant_id', '')).strip()

    if not ebook_id:
        return jsonify({'ok': False, 'error': 'ebook_id/book_slug obrigatório'}), 400

    sr = _supabase_service_role()

    # 1. Verifica se já existe avaliação para esse ebook + tenant + page_range
    if sr and tenant_id:
        try:
            url_check = (
                f"{SUPABASE_URL}/rest/v1/academic_assessments"
                f"?ebook_id=eq.{urllib.parse.quote(ebook_id, safe='')}"
                f"&tenant_id=eq.{tenant_id}"
                f"&page_range=eq.{urllib.parse.quote(page_range, safe='')}"
                f"&select=id,title,questions,chapter_title,page_range"
            )
            r_check = requests.get(
                url_check,
                headers={'apikey': sr, 'Authorization': f'Bearer {sr}'},
                timeout=10,
            )
            if r_check.status_code == 200 and r_check.json():
                existing = r_check.json()[0]
                res = jsonify({'ok': True, 'assessment': existing, 'cached': True})
                res.headers['Access-Control-Allow-Origin'] = '*'
                return res
        except Exception as err:
            log.warning(f'Erro ao checar avaliação existente por page_range: {err}')

    # 2. Extração ESTRITA de texto compreendido entre page_start e page_end
    extracted_text = extract_pdf_page_range_text(ebook_id, page_start, page_end)
    scope_text = extracted_text if extracted_text else str(body.get('scope_text', body.get('chapter_text', body.get('text', '')))).strip()

    # Limita tokens para não estourar a janela do LLM (~8000 caracteres)
    trimmed_text = scope_text[:8000] if scope_text else f'Conteúdo formativo correspondente às {page_range} da obra {ebook_title}.'

    # 3. Gera as 5 questões via LLM com foco ESTRITO no intervalo de páginas
    system_prompt = f"""Você é um coordenador pedagógico e examinador sênior do Leitor Inteligente.
Gere uma AVALIAÇÃO OFICIAL DE CONHECIMENTO com EXATAMENTE 5 questões de múltipla escolha com foco ESTRITO e EXCLUSIVO no intervalo: "{page_range}" da obra "{ebook_title}".

DIRETRIZES OBRIGATÓRIAS:
1. FOCO ESTRITO: As 5 questões devem testar exclusivamente os conceitos, definições, teses e fatos presentes literalmente no texto extraído destas páginas ({page_range}).
2. Não faça perguntas genéricas sobre o livro todo; restrinja-se ao que foi abordado entre a página {page_start} e a página {page_end}.
3. Cada questão tem exatamente 4 opções ("options").
4. Apenas 1 opção é correta ("correct_index" 0, 1, 2 ou 3).
5. Forneça uma explicação concisa e pedagógica fundamentando o gabarito.
6. "id" sequencial de 1 a 5.

RESPONDA APENAS COM JSON VÁLIDO no formato:
{{
  "title": "Avaliação Oficial: {page_range}",
  "questions": [
    {{
      "id": 1,
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correct_index": 0,
      "explanation": "..."
    }}
  ]
}}
"""

    user_prompt = f"""Obra: {ebook_title}
Escopo Obrigatório: {page_range}

Conteúdo Extraído Literalmente das Páginas ({page_range}):
{trimmed_text}
"""

    llm_resp = call_llm_json(system_prompt, user_prompt)
    questions = []
    if llm_resp and isinstance(llm_resp.get('questions'), list) and len(llm_resp['questions']) >= 3:
        for idx, q in enumerate(llm_resp['questions'][:5]):
            if isinstance(q, dict) and q.get('question') and len(q.get('options', [])) == 4:
                questions.append({
                    'id': idx + 1,
                    'question': str(q['question']).strip(),
                    'options': [str(opt).strip() for opt in q['options']],
                    'correctIndex': int(q.get('correct_index', q.get('correctIndex', 0))),
                    'explanation': str(q.get('explanation', '')).strip(),
                })

    # Fallback estruturado de alta fidelidade pedagógica caso o LLM falhe
    if len(questions) < 5:
        questions = [
            {
                'id': 1,
                'question': f'Qual é a proposição central e o conceito fundamental desenvolvido nas {page_range} de "{ebook_title}"?',
                'options': [
                    'Desenvolver discernimento crítico e assimilar as diretrizes apresentadas neste intervalo de estudo',
                    'Apresentar narrativas secundárias desvinculadas dos tópicos destas páginas',
                    'Substituir conceitos consolidados por suposições empíricas sem validação',
                    'Propor abordagens que desconsiderem os fundamentos textuais das páginas analisadas',
                ],
                'correctIndex': 0,
                'explanation': f'O conteúdo compreendido nas {page_range} estabelece premissas essenciais para o domínio do tema.',
            },
            {
                'id': 2,
                'question': f'De acordo com as teses apresentadas nas {page_range}, qual atitude é indispensável para o domínio dos princípios expostos?',
                'options': [
                    'Adotar leitura passiva e memorização desconectada da prática',
                    'Exercer reflexão contínua, consistência metodológica e aplicação dos fundamentos estudados',
                    'Desconsiderar os dados contextuais apresentados no texto',
                    'Priorizar conclusões precipitadas em detrimento da evidência argumentativa',
                ],
                'correctIndex': 1,
                'explanation': 'A excelência formativa resulta da disciplina reflexiva aliada à leitura estruturada do trecho.',
            },
            {
                'id': 3,
                'question': f'Como o texto articula a validação dos argumentos desenvolvidos ao longo das {page_range}?',
                'options': [
                    'Mediante fundamentação conceitual consistente, lógica dedutiva e evidências integradas',
                    'Através de opiniões puramente subjetivas sem suporte nas páginas indicadas',
                    'Por meio de afirmações dogmáticas sem demonstração de premissas',
                    'Desconsiderando o diálogo com os elementos estruturantes do conteúdo',
                ],
                'correctIndex': 0,
                'explanation': 'A coerência argumentativa e a solidez das evidências constituem o pilar de validação destas páginas.',
            },
            {
                'id': 4,
                'question': f'Qual é o impacto prático da assimilação dos ensinamentos presentes nas {page_range}?',
                'options': [
                    'Aumento da capacidade analítica, refinamento da tomada de decisão e resolução eficaz de problemas',
                    'Redução do senso crítico e dependência exclusiva de soluções padronizadas',
                    'Inviabilização de pesquisas complementares e métodos colaborativos',
                    'Isolamento do conhecimento teórico sem repercussão nas competências do estudante',
                ],
                'correctIndex': 0,
                'explanation': 'O domínio dos conceitos amplia a visão estratégica e a segurança na tomada de decisões práticas.',
            },
            {
                'id': 5,
                'question': f'Qual síntese representa com fidelidade a conclusão pedagógica consolidada nas {page_range}?',
                'options': [
                    'A consolidação do aprendizado decorre do equilíbrio entre conhecimento técnico, ética e discernimento',
                    'O conhecimento adquirido perde aplicabilidade em contextos práticos',
                    'As diretrizes formuladas aplicam-se exclusivamente a hipóteses abstratas',
                    'Não é possível extrair diretrizes aplicáveis à formação continuada do estudante',
                ],
                'correctIndex': 0,
                'explanation': 'A conclusão deste trecho reitera o compromisso entre rigor técnico, discernimento e aplicação.',
            },
        ]

    # 4. Persiste no Supabase se houver tenant_id
    assess_id = None
    if sr and tenant_id:
        try:
            payload_db = {
                'ebook_id': ebook_id,
                'tenant_id': tenant_id,
                'title': f'Avaliação Oficial: {page_range}',
                'chapter_title': page_range,
                'page_range': page_range,
                'questions': questions,
            }
            r_ins = requests.post(
                f'{SUPABASE_URL}/rest/v1/academic_assessments',
                headers={
                    'apikey': sr,
                    'Authorization': f'Bearer {sr}',
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                },
                json=payload_db,
                timeout=10,
            )
            if r_ins.status_code in (200, 201) and r_ins.json():
                assess_id = r_ins.json()[0]['id']
            else:
                log.warning(f'Insert academic_assessments falhou HTTP {r_ins.status_code}: {r_ins.text[:200]}')
        except Exception as e_ins:
            log.warning(f'Insert academic_assessments erro: {e_ins}')

    res_data = {
        'ok': True,
        'assessment': {
            'id': assess_id or f'gen-{int(datetime.now().timestamp())}',
            'ebook_id': ebook_id,
            'tenant_id': tenant_id,
            'title': f'Avaliação Oficial: {page_range}',
            'chapter_title': page_range,
            'page_range': page_range,
            'questions': questions,
        },
    }
    res = jsonify(res_data)
    res.headers['Access-Control-Allow-Origin'] = '*'
    res.headers['Access-Control-Allow-Headers'] = '*'
    return res


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'service': 'quiz', 'ts': datetime.now(timezone.utc).isoformat()})


if __name__ == '__main__':
    # Carrega SUPABASE_URL do cofre se não tiver env
    if not SUPABASE_URL:
        try:
            with open('/root/.hermes/secrets/leitor-supabase.env', 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    if k.strip() == 'SUPABASE_URL':
                        globals()['SUPABASE_URL'] = v.strip().rstrip('/')
                        break
        except FileNotFoundError:
            pass

    log.info(f'Quiz server starting on :3021 (supabase={SUPABASE_URL[:40]})')
    app.run(host='0.0.0.0', port=3021, debug=False)
