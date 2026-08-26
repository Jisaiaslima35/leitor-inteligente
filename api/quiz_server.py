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
    """Valida Bearer do Supabase via /auth/v1/user. Retorna user_id ou None."""
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:].strip()
    if not token:
        return None
    if not SUPABASE_URL:
        log.error('SUPABASE_URL não configurada')
        return None

    try:
        r = requests.get(
            f'{SUPABASE_URL}/auth/v1/user',
            headers={
                'Authorization': f'Bearer {token}',
                'apikey': _supabase_anon_key(),
            },
            timeout=10,
        )
    except Exception as e:
        log.error(f'auth/v1/user falhou: {e}')
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json().get('id')
    except Exception:
        return None


def _supabase_anon_key() -> str:
    """Lê SUPABASE_ANON_KEY do cofre (key pública, pode estar em vários paths)."""
    for env_path in ('/root/.hermes/.env', '/root/.hermes/secrets/leitor-supabase.env'):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    if k.strip() == 'SUPABASE_ANON_KEY':
                        return v.strip()
        except FileNotFoundError:
            continue
    return ''


def _supabase_service_role() -> str:
    """Service role — bypassa RLS (necessário pro backend inserir scores)."""
    # Primeiro tenta o .env global
    for env_path in ('/root/.hermes/.env', '/root/.hermes/secrets/leitor-supabase.env'):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    if k.strip() == 'SUPABASE_SERVICE_ROLE':
                        return v.strip()
        except FileNotFoundError:
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
    """Grava resultado do quiz em user_quiz_scores."""
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
    return jsonify({
        'ok': True,
        'score': score,
        'id': inserted[0]['id'] if inserted else None,
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
    return jsonify({
        'ok': True,
        'total_score': total,
        'quizzes_count': len(rows),
        'best_correct': best_correct,
    })


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
