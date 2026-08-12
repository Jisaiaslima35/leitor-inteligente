#!/usr/bin/env python3
"""Leitor IA - Upload Book API.
Recebe PDF uploaded pelo usuário, processa (texto ou OCR), indexa no Supabase
com isolamento total por user_id. Cada usuário só vê/processa seus próprios PDFs.
Roda na porta 9134.
"""
import json, os, re, subprocess, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime
import threading
import base64
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# --- Config ---
SUPABASE_ENV = {}
for line in Path('/root/.hermes/secrets/leitor-supabase.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        SUPABASE_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]

SUPABASE_URL = SUPABASE_ENV.get('SUPABASE_URL', '')
SUPABASE_SR = SUPABASE_ENV.get('SUPABASE_SERVICE_ROLE', '')

# SMTP config (Gmail app password — opcional; se faltar, pula notificação)
SMTP_ENV = {}
smtp_env_path = Path('/root/.hermes/secrets/leitor-smtp.env')
if smtp_env_path.exists():
    for line in smtp_env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            SMTP_ENV[line.split('=', 1)[0]] = line.split('=', 1)[1]
SMTP_HOST = SMTP_ENV.get('SMTP_HOST', '')
SMTP_PORT = int(SMTP_ENV.get('SMTP_PORT', '587'))
SMTP_USER = SMTP_ENV.get('SMTP_USER', '')
SMTP_PASS = SMTP_ENV.get('SMTP_PASS', '')
SMTP_FROM_EMAIL = SMTP_ENV.get('SMTP_FROM_EMAIL', SMTP_USER)
SMTP_FROM_NAME = SMTP_ENV.get('SMTP_FROM_NAME', 'Leitor Inteligente')
APP_URL = SMTP_ENV.get('APP_URL', 'https://preview.automacaojs.us/leitor-inteligente')

UPLOAD_TMP_PREFIX = 'tmp/'  # PDFs sendo processados ficam em {user_id}/tmp/...
UPLOAD_FINAL_PREFIX = ''    # Quando processado, move pra {user_id}/{ebook_id}/

# Limites
MAX_PDF_MB = 50
MIN_TEXT_PER_PAGE_CHARS = 200  # < isso = escaneado, roda OCR


# --- Helpers Supabase ---
def supabase_call(path, method='GET', body=None, headers=None):
    h = {
        'apikey': SUPABASE_SR,
        'Authorization': f'Bearer {SUPABASE_SR}',
    }
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f'{SUPABASE_URL}{path}', data=data, headers=h, method=method)
    with urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def resolve_user_id(auth_header: str) -> str | None:
    """Extrai user_id do JWT Supabase."""
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    token = auth_header[7:]
    parts = token.split('.')
    if len(parts) != 3:
        return None
    try:
        payload_b64 = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get('sub')
    except Exception:
        return None


def slugify(text: str) -> str:
    """Gera slug a partir de title. Limita a 60 chars, lowercase, sem acentos."""
    import unicodedata
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    text = re.sub(r'[^a-zA-Z0-9\s-]', '', text.lower())
    text = re.sub(r'\s+', '-', text).strip('-')
    return text[:60] or 'livro'


def get_user_email(user_id: str) -> str | None:
    """Busca email do user no Supabase Auth admin. Retorna None se falhar."""
    try:
        req = Request(
            f'{SUPABASE_URL}/auth/v1/admin/users/{user_id}',
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
            method='GET',
        )
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            return data.get('email')
    except Exception as e:
        print(f'[upload] get_user_email falhou: {e}', flush=True)
        return None


def send_book_ready_email(to_email: str, ebook_title: str, ebook_slug: str, page_count: int) -> bool:
    """Envia email 'Seu livro X tá pronto' via SMTP Gmail. Retorna True se enviou."""
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASS:
        print(f'[upload] SMTP não configurado, pulando email', flush=True)
        return False
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = f'📚 "{ebook_title}" tá pronto no Leitor Inteligente!'
        msg['From'] = f'{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>'
        msg['To'] = to_email

        text = f"""Oi!

Seu livro "{ebook_title}" ({page_count} páginas) terminou de ser processado
e já tá disponível na sua biblioteca.

Acesse agora:
{APP_URL}/#/library

Bons estudos,
Equipe Leitor Inteligente
"""
        html = f"""<!DOCTYPE html>
<html><body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
<h2 style="color: #52c1a6;">📚 Seu livro tá pronto!</h2>
<p>Oi!</p>
<p>O livro <strong>{ebook_title}</strong> ({page_count} páginas) terminou de ser processado e já tá disponível na sua biblioteca.</p>
<p style="margin: 30px 0;">
  <a href="{APP_URL}/#/library" style="background: #52c1a6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
    Abrir minha biblioteca →
  </a>
</p>
<p style="color: #777; font-size: 14px;">Bons estudos,<br>Equipe Leitor Inteligente</p>
</body></html>"""

        msg.attach(MIMEText(text, 'plain', 'utf-8'))
        msg.attach(MIMEText(html, 'html', 'utf-8'))

        ctx = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            s.starttls(context=ctx)
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_FROM_EMAIL, [to_email], msg.as_string())
        print(f'[upload] Email enviado pra {to_email}', flush=True)
        return True
    except Exception as e:
        print(f'[upload] ERRO email: {e}', flush=True)
        traceback.print_exc()
        return False


# --- Pipeline de processamento ---
def detect_scanned(pdf_path: str) -> bool:
    """PDF é escaneado se a média de chars por página é < 200.

    IMPORTANTE: usa extração do doc INTEIRO + divide por page count, porque
    `pdftotext -f X -l Y` retorna vazio em alguns PDFs (bug do poppler com
    PDFs de origem iText/pdftk como '21 dias para curar...' 132p).
    Sem esse fix, livros com texto seriam classificados como escaneados
    e o OCR (lento + pode garble) rodaria à toa.
    """
    try:
        result = subprocess.run(
            ['pdftotext', pdf_path, '-'],
            capture_output=True, text=True, timeout=15
        )
        total_chars = len(result.stdout.strip())
        page_count = get_real_page_count(pdf_path)
        if page_count <= 0:
            # Sem page count, fallback conservador: se tem > 1000 chars totais,
            # provavelmente tem texto. Caso contrário, tenta OCR.
            return total_chars < 1000
        avg_chars = total_chars / page_count
        return avg_chars < MIN_TEXT_PER_PAGE_CHARS
    except Exception:
        return False


def get_real_page_count(pdf_path: str) -> int:
    """Extrai contagem REAL de páginas via pdfinfo (poppler-utils).
    Mais confiável que regex no frontend. Retorna 0 se falhar."""
    try:
        result = subprocess.run(
            ['pdfinfo', pdf_path],
            capture_output=True, text=True, timeout=15
        )
        for line in result.stdout.splitlines():
            if line.startswith('Pages:'):
                return int(line.split(':', 1)[1].strip())
    except Exception as e:
        print(f'[upload] pdfinfo falhou: {e}', flush=True)
    return 0


def run_ocr(input_pdf: str, output_pdf: str) -> bool:
    """Roda Tesseract PT-BR via ocrmypdf."""
    try:
        result = subprocess.run(
            ['ocrmypdf', '-l', 'por', '--skip-text', '--deskew', '--clean',
             '--output-type', 'pdf', input_pdf, output_pdf],
            capture_output=True, text=True, timeout=1800
        )
        return result.returncode == 0 and os.path.exists(output_pdf)
    except Exception as e:
        print(f'[upload] OCR falhou: {e}', flush=True)
        return False


# --- Marker-pdf fallback ---
# Consome 4-6GB RAM. Pra não concorrer com outros serviços da VPS,
# só 1 marker-pdf roda por vez. Usa fcntl.flock (lock advisory do kernel,
# atômico entre processos). Lock libera automaticamente se processo morre.
MARKER_LOCK_FILE = '/tmp/marker-pdf.lock'
MARKER_SCRIPT = '/root/.hermes/profiles/leitor-inteligente/skills/productivity/ocr-and-documents/scripts/extract_marker.py'
MARKER_LOCK_TIMEOUT_SEC = 1800  # 30min max esperando

class MarkerLock:
    """Lock advisory em arquivo. Adquirir = fcntl.flock(LOCK_EX)."""
    def __init__(self, path: str = MARKER_LOCK_FILE, timeout: int = MARKER_LOCK_TIMEOUT_SEC):
        self.path = path
        self.timeout = timeout
        self.fd = None
    def __enter__(self):
        import fcntl
        self.fd = open(self.path, 'w')
        t0 = time.time()
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.fd.write(f'{os.getpid()} {time.time()}\n')
                self.fd.flush()
                print(f'[marker-lock] ADQUIRIDO por pid={os.getpid()}', flush=True)
                return self
            except (IOError, OSError):
                waited = time.time() - t0
                if waited > self.timeout:
                    self.fd.close()
                    self.fd = None
                    raise TimeoutError(f'marker-lock timeout depois de {int(waited)}s')
                if int(waited) % 60 == 0 and int(waited) > 0:
                    print(f'[marker-lock] aguardando... {int(waited)}s', flush=True)
                time.sleep(5)
    def __exit__(self, *args):
        if self.fd:
            import fcntl
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            self.fd.close()
            self.fd = None
            print(f'[marker-lock] LIBERADO por pid={os.getpid()}', flush=True)


def run_marker_ocr(input_pdf: str, output_md: str) -> bool:
    """Roda marker-pdf (fallback). SEMPRE dentro de `with MarkerLock():`."""
    try:
        print(f'[marker] iniciando marker-pdf em {input_pdf}', flush=True)
        result = subprocess.run(
            ['python3', MARKER_SCRIPT, input_pdf,
             '--output_dir', os.path.dirname(output_md),
             '--json'],
            capture_output=True, text=True, timeout=3600,
        )
        if result.returncode != 0:
            print(f'[marker] falhou (rc={result.returncode}): {result.stderr[:300]}', flush=True)
            return False
        try:
            data = json.loads(result.stdout)
            md = data.get('markdown', '')
            with open(output_md, 'w') as f:
                f.write(md)
            print(f'[marker] OK: {len(md)} chars extraídos', flush=True)
            return True
        except Exception as e:
            print(f'[marker] falha ao parsear JSON: {e}', flush=True)
            return False
    except subprocess.TimeoutExpired:
        print(f'[marker] TIMEOUT (>1h)', flush=True)
        return False
    except Exception as e:
        print(f'[marker] ERRO: {e}', flush=True)
        return False


def extract_pages_with_fallback(pdf_path: str) -> list[dict]:
    """Pipeline híbrido de extração (3 níveis).

    1. pdftotext direto (PDF com texto embutido)
    2. Tesseract via ocrmypdf (PDF escaneado)
    3. marker-pdf (último recurso, consome 4-6GB RAM, usa lock)

    Retorna [{page: int, text: str}, ...].
    """
    # Nível 1: pdftotext direto
    pages = extract_pages(pdf_path)
    total_chars = sum(len(p['text']) for p in pages)
    if total_chars >= 1000:
        print(f'[extract] N1 OK: {len(pages)} páginas, {total_chars} chars (pdftotext)', flush=True)
        return pages
    print(f'[extract] N1 fraco: {total_chars} chars. Tentando Tesseract...', flush=True)

    # Nível 2: Tesseract
    ocr_path = pdf_path + '.ocr.pdf'
    if not run_ocr(pdf_path, ocr_path):
        print(f'[extract] N2 falhou (Tesseract erro). Indo pra marker-pdf...', flush=True)
    else:
        pages = extract_pages(ocr_path)
        total_chars = sum(len(p['text']) for p in pages)
        if total_chars >= 1000:
            print(f'[extract] N2 OK: {len(pages)} páginas, {total_chars} chars (Tesseract)', flush=True)
            return pages
        print(f'[extract] N2 fraco: {total_chars} chars. Indo pra marker-pdf...', flush=True)

    # Nível 3: marker-pdf (com lock)
    md_path = pdf_path + '.marker.md'
    try:
        with MarkerLock():
            if run_marker_ocr(pdf_path, md_path) and os.path.exists(md_path):
                with open(md_path) as f:
                    md_text = f.read()
                if len(md_text) >= 1000:
                    print(f'[extract] N3 OK: {len(md_text)} chars (marker-pdf)', flush=True)
                    # Marker retorna markdown contínuo, sem split por página.
                    # Trade-off: RAG funciona, perdemos navegação por página.
                    return [{'page': 1, 'text': md_text}]
    except TimeoutError:
        print(f'[extract] N3 timeout esperando lock. Sem mais fallbacks.', flush=True)

    print(f'[extract] N3 falhou. Sem mais fallbacks.', flush=True)
    return pages  # retorna o melhor que conseguiu (provavelmente fraco)


def extract_pages(pdf_path: str) -> list[dict]:
    """Extrai texto por página. Retorna [{page: int, text: str}, ...]."""
    result = subprocess.run(
        ['pdftotext', '-layout', pdf_path, '-'],
        capture_output=True, text=True, timeout=60
    )
    pages_raw = result.stdout.split('\f')
    pages = []
    for i, txt in enumerate(pages_raw, 1):
        txt = txt.strip()
        if len(txt) > 5:  # ignora páginas vazias/capa
            pages.append({'page': i, 'text': txt})
    return pages


def detect_chapters(pages: list[dict]) -> list[tuple[int, str, int, int]]:
    """Detecta capítulos por heurística: 'CAPÍTULO X' ou 'Capítulo X'.
    Retorna [(chapter_num, title, start_page, end_page), ...]."""
    chapters = []
    chapter_pattern = re.compile(r'(?:^|\n)\s*(?:cap[íi]tulo|capitulo)\s+(\d+|[a-z]+)\b[^\n]*', re.IGNORECASE)
    for p in pages:
        m = chapter_pattern.search(p['text'])
        if m:
            # Pega o número do capítulo
            raw = m.group(1)
            num_map = {'um': 1, 'dois': 2, 'tres': 3, 'quatro': 4, 'cinco': 5,
                       'seis': 6, 'sete': 7, 'oito': 8, 'nove': 9, 'dez': 10}
            num = int(raw) if raw.isdigit() else num_map.get(raw.lower(), 0)
            # Pega a primeira linha com o match como título
            for line in p['text'].split('\n'):
                if 'capítulo' in line.lower() or 'capitulo' in line.lower():
                    title = line.strip()[:120]
                    break
            else:
                title = f'Capítulo {num}'
            chapters.append({'num': num, 'title': title, 'page': p['page']})
    # Garante ranges
    out = []
    for i, ch in enumerate(chapters):
        start = ch['page']
        end = chapters[i + 1]['page'] - 1 if i + 1 < len(chapters) else pages[-1]['page']
        out.append((ch['num'], ch['title'], start, end))
    return out


def chapter_for_page(page_num: int, chapters: list) -> tuple[int | None, str | None]:
    for n, title, start, end in chapters:
        if start <= page_num <= end:
            return n, title
    return None, None


# --- Jobs em background ---
def run_pipeline(user_id: str, ebook_id: str, storage_path: str, title: str, author: str, total_pages: int):
    """Job async: processa PDF, gera embeddings, salva tudo."""
    tmp_dir = f'/tmp/upload-{user_id}-{int(time.time())}'
    os.makedirs(tmp_dir, exist_ok=True)
    raw_pdf = f'{tmp_dir}/raw.pdf'
    ocr_pdf = f'{tmp_dir}/ocr.pdf'
    final_pdf_local = f'{tmp_dir}/final.pdf'

    try:
        t0 = time.time()
        print(f'[upload-job] START user={user_id} ebook={ebook_id} path={storage_path}', flush=True)

        # 1. Baixa do Storage
        sign_url_req = Request(
            f'{SUPABASE_URL}/storage/v1/object/sign/ebooks/{storage_path}',
            data=json.dumps({'expiresIn': 300}).encode(),
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/json'},
            method='POST'
        )
        with urlopen(sign_url_req, timeout=15) as r:
            sign = json.loads(r.read())
            signed_path = sign.get('signedURL') or sign.get('signedUrl')
        download_url = f'{SUPABASE_URL}/storage/v1{signed_path}'
        dl_req = Request(download_url)
        with urlopen(dl_req, timeout=120) as r:
            with open(raw_pdf, 'wb') as f:
                f.write(r.read())

        # 2. Detecta OCR
        is_scanned = detect_scanned(raw_pdf)
        process_pdf = ocr_pdf if is_scanned else raw_pdf
        if is_scanned:
            print(f'[upload-job] PDF escaneado, rodando OCR...', flush=True)
            if not run_ocr(raw_pdf, ocr_pdf):
                print(f'[upload-job] OCR falhou, usando original', flush=True)
                process_pdf = raw_pdf
        print(f'[upload-job] PDF lido em {time.time()-t0:.1f}s (escaneado={is_scanned})', flush=True)

        # 2b. Extrai contagem REAL de páginas via pdfinfo (sobrescreve total_pages do frontend)
        real_pages = get_real_page_count(process_pdf)
        if real_pages > 0:
            old_total = total_pages
            total_pages = real_pages
            print(f'[upload-job] total_pages real via pdfinfo: {real_pages} (frontend disse {old_total})', flush=True)
        else:
            print(f'[upload-job] pdfinfo falhou, mantendo total_pages do frontend: {total_pages}', flush=True)

        # 3. Extrai páginas (pipeline híbrido: pdftotext → Tesseract → marker-pdf)
        pages = extract_pages_with_fallback(process_pdf)
        if not pages:
            raise RuntimeError('PDF sem texto extraível (mesmo após Tesseract + marker-pdf fallback)')
        print(f'[upload-job] {len(pages)} páginas extraídas', flush=True)

        # 4. Detecta capítulos
        chapters = detect_chapters(pages)

        # 5. Salva PDF final no path do ebook (depois do upload original pra signed URL funcionar após)
        import shutil
        shutil.copy(process_pdf, final_pdf_local)
        final_storage_path = f'{user_id}/{ebook_id}/livro.pdf'
        with open(final_pdf_local, 'rb') as f:
            pdf_bytes = f.read()
        upload_req = Request(
            f'{SUPABASE_URL}/storage/v1/object/ebooks/{final_storage_path}',
            data=pdf_bytes,
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/pdf', 'x-upsert': 'true',
                     'Content-Length': str(len(pdf_bytes))},
            method='POST'
        )
        try:
            with urlopen(upload_req, timeout=120) as r:
                # Some buckets return JSON; others return empty. Either way: 2xx = ok
                print(f'[upload-job] PDF final armazenado em {final_storage_path}', flush=True)
        except HTTPError as e:
            body = e.read().decode('utf-8', errors='ignore')[:300]
            print(f'[upload-job] ERRO upload PDF final HTTP {e.code}: {body}', flush=True)
            raise
        except Exception as e:
            print(f'[upload-job] ERRO upload PDF final: {e}', flush=True)
            raise

        # 5b. UPDATE ebooks.pdf_storage_path no banco → reader/signed-url sabe o path novo
        upd_path_req = Request(
            f'{SUPABASE_URL}/rest/v1/ebooks?id=eq.{ebook_id}',
            data=json.dumps({'pdf_storage_path': final_storage_path}).encode(),
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/json'},
            method='PATCH'
        )
        try:
            with urlopen(upd_path_req, timeout=15) as r:
                print(f'[upload-job] ebooks.pdf_storage_path atualizado → {final_storage_path}', flush=True)
        except Exception as e:
            print(f'[upload-job] WARN atualizou pdf_storage_path: {e}', flush=True)

        # 6. INSERT ebook_pages (sem embedding ainda)
        page_rows = []
        for p in pages:
            pn = p['page']
            cn, ct = chapter_for_page(pn, chapters)
            page_rows.append({
                'ebook_id': ebook_id,
                'page_number': pn,
                'chapter_number': cn,
                'chapter_title': ct,
                'page_text': p['text'],
                'word_count': len(p['text'].split())
            })

        # Salva em arquivo (evita OSError 7 com subprocess curl)
        rows_path = f'{tmp_dir}/rows.json'
        with open(rows_path, 'w') as f:
            json.dump(page_rows, f)

        ins_req = Request(
            f'{SUPABASE_URL}/rest/v1/ebook_pages',
            data=open(rows_path, 'rb').read(),
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/json',
                     'Prefer': 'resolution=ignore-duplicates'},
            method='POST'
        )
        urlopen(ins_req, timeout=60)
        print(f'[upload-job] {len(page_rows)} páginas inseridas', flush=True)

        # 7. Gera embeddings BGE-small-en
        from fastembed import TextEmbedding
        model = TextEmbedding(model_name='BAAI/bge-small-en-v1.5')
        texts = [p['text'] for p in pages]
        print(f'[upload-job] gerando embeddings...', flush=True)
        embeddings = list(model.embed(texts, batch_size=16, parallel=1))
        print(f'[upload-job] embeddings prontos em {time.time()-t0:.1f}s', flush=True)

        # 8. PATCH embeddings (um por um — PostgREST não suporta batch)
        from urllib.error import HTTPError
        emb_ok = 0
        emb_fail = []
        for i, p in enumerate(pages):
            try:
                emb = embeddings[i].tolist()
                patch_req = Request(
                    f'{SUPABASE_URL}/rest/v1/ebook_pages?ebook_id=eq.{ebook_id}&page_number=eq.{p["page"]}',
                    data=json.dumps({'embedding': emb}).encode(),
                    headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                             'Content-Type': 'application/json'},
                    method='PATCH'
                )
                with urlopen(patch_req, timeout=15):
                    emb_ok += 1
            except HTTPError as e:
                body = e.read().decode('utf-8', errors='ignore')[:200]
                emb_fail.append((p['page'], e.code, body))
            except Exception as e:
                emb_fail.append((p['page'], 'EXC', str(e)[:200]))
        print(f'[upload-job] embeddings: {emb_ok}/{len(pages)} ok, {len(emb_fail)} falhas', flush=True)
        if emb_fail:
            for f in emb_fail[:3]:
                print(f'  falha: page={f[0]} code={f[1]} body={f[2][:100]}', flush=True)
        print(f'[upload-job] {len(pages)} embeddings salvos', flush=True)

        # 9. EXTRAÇÃO AUTOMÁTICA DE CAPA (PyMuPDF + heurística de página vazia)
        cover_url = None
        try:
            from cover_extractor import extract_cover as _extract_cover
            cover_local = f'{tmp_dir}/cover.jpg'
            extracted = _extract_cover(final_pdf_local, cover_local, max_pages=5)
            if extracted and os.path.exists(extracted):
                cover_storage_path = f'{user_id}/{ebook_id}/cover.jpg'
                # Upload via REST signed upload (token vem do /upload-url/sign)
                sign_req = Request(
                    f'{SUPABASE_URL}/storage/v1/object/upload/sign/ebooks/{cover_storage_path}',
                    headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}'},
                    method='POST'
                )
                with urlopen(sign_req, timeout=15) as r:
                    sign_data = json.loads(r.read())
                token = sign_data['token']
                with open(extracted, 'rb') as f:
                    cover_bytes = f.read()
                upload_req = Request(
                    f'{SUPABASE_URL}/storage/v1/object/upload/sign/ebooks/{cover_storage_path}?token={token}',
                    data=cover_bytes,
                    headers={
                        'apikey': SUPABASE_SR,
                        'Authorization': f'Bearer {SUPABASE_SR}',
                        'Content-Type': 'image/jpeg',
                        'x-upsert': 'true',
                    },
                    method='PUT'
                )
                with urlopen(upload_req, timeout=30) as r:
                    upload_resp = json.loads(r.read())
                    print(f'[upload-job] cover uploaded: {cover_storage_path}', flush=True)
                # URL pública (bucket ebooks já é público pra leitura via signed URL)
                cover_url = f'{SUPABASE_URL}/storage/v1/object/public/ebooks/{cover_storage_path}'
                print(f'[upload-job] cover_url: {cover_url}', flush=True)
        except Exception as cover_err:
            print(f'[upload-job] cover extraction falhou (não-crítico): {cover_err}', flush=True)
            traceback.print_exc()

        # 10. UPDATE ebook (chapter_count + cover_url + total_pages)
        chapter_count = len(chapters) if chapters else 0
        upd_payload = {'chapter_count': chapter_count, 'total_pages': len(pages)}
        if cover_url:
            upd_payload['cover_url'] = cover_url
        upd_req = Request(
            f'{SUPABASE_URL}/rest/v1/ebooks?id=eq.{ebook_id}',
            data=json.dumps(upd_payload).encode(),
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/json'},
            method='PATCH'
        )
        urlopen(upd_req, timeout=15)
        if cover_url:
            print(f'[upload-job] cover_url salva no ebook', flush=True)

        # 10. INSERT user_library (libera pro próprio user, sem precisar comprar)
        lib_req = Request(
            f'{SUPABASE_URL}/rest/v1/user_library',
            data=json.dumps({'user_id': user_id, 'ebook_id': ebook_id,
                             'payment_status': 'confirmed'}).encode(),
            headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                     'Content-Type': 'application/json',
                     'Prefer': 'resolution=ignore-duplicates,return=representation'},
            method='POST'
        )
        try:
            with urlopen(lib_req, timeout=15) as r:
                inserted = json.loads(r.read())
                print(f'[upload-job] user_library: {len(inserted)} row(s) inserida(s)', flush=True)
        except HTTPError as e:
            body = e.read().decode('utf-8', errors='ignore')[:300]
            print(f'[upload-job] ERRO user_library HTTP {e.code}: {body}', flush=True)
            raise  # repropaga pra cair no except geral
        except Exception as e:
            print(f'[upload-job] ERRO user_library: {e}', flush=True)
            raise

        # 10b. Notificação por email (Path B) — em thread daemon pra não bloquear
        def _send_email():
            user_email = get_user_email(user_id)
            if not user_email:
                print(f'[upload-job] sem email pra user={user_id}, pulando', flush=True)
                return
            send_book_ready_email(user_email, title, ebook_id, len(pages))
        threading.Thread(target=_send_email, daemon=True).start()

        # 11. Limpa tmp
        try:
            supabase_call(
                f'/storage/v1/object/ebooks/{storage_path}', method='DELETE'
            )
        except Exception:
            pass

        print(f'[upload-job] DONE user={user_id} ebook={ebook_id} em {time.time()-t0:.1f}s', flush=True)

    except Exception as e:
        print(f'[upload-job] ERRO user={user_id}: {e}', flush=True)
        traceback.print_exc()
        # Marca ebook como failed (best-effort)
        try:
            supabase_call(
                f'/rest/v1/ebooks?id=eq.{ebook_id}',
                method='PATCH',
                body={'description': f'[ERRO NO PROCESSAMENTO] {str(e)[:500]}'}
            )
        except Exception:
            pass
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)


# --- HTTP ---
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok', 'service': 'upload-api', 'port': 9134})
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path == '/upload-url':
            # Gera signed URL pra upload direto pro Storage
            try:
                auth = self.headers.get('Authorization', '')
                user_id = resolve_user_id(auth)
                if not user_id:
                    return self.send_json(401, {'error': 'Sessão inválida. Faça login.'})
                n = int(self.headers.get('Content-Length', '0'))
                data = json.loads(self.rfile.read(n)) if n else {}
                filename = (data.get('filename') or 'livro.pdf').strip()
                # Sanitiza filename pra evitar caracteres não-ASCII no signed URL
                # (Supabase Storage rejeita caracteres como á, í, ã no path)
                import re as _re
                import unicodedata as _ud
                # Normaliza NFKD (decompõe acentos) → remove combining marks → só ASCII
                filename = _ud.normalize('NFKD', filename).encode('ascii', 'ignore').decode('ascii')
                filename = _re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
                if not filename.endswith('.pdf'):
                    filename += '.pdf'
                filename = filename[:80]  # limite do Storage
                # Path isolado por user: {user_id}/tmp/{ts}_{filename}
                ts = int(time.time())
                storage_path = f'{user_id}/tmp/{ts}_{filename}'
                sign_req = Request(
                    f'{SUPABASE_URL}/storage/v1/object/upload/sign/ebooks/{storage_path}',
                    data=json.dumps({'expiresIn': 600}).encode(),
                    headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                             'Content-Type': 'application/json'},
                    method='POST'
                )
                with urlopen(sign_req, timeout=15) as r:
                    sign = json.loads(r.read())
                    token = sign.get('token')
                # URL completa pra PUT (frontend faz PUT direto)
                upload_url = f'{SUPABASE_URL}/storage/v1/object/upload/sign/ebooks/{storage_path}?token={token}'
                self.send_json(200, {
                    'upload_url': upload_url,
                    'storage_path': storage_path,
                    'expires_in': 600
                })
            except Exception as e:
                self.send_json(500, {'error': str(e)[:500]})
            return

        if self.path == '/process':
            # Recebe notificação que upload terminou, dispara processamento
            try:
                auth = self.headers.get('Authorization', '')
                user_id = resolve_user_id(auth)
                if not user_id:
                    return self.send_json(401, {'error': 'Sessão inválida. Faça login.'})
                n = int(self.headers.get('Content-Length', '0'))
                data = json.loads(self.rfile.read(n)) if n else {}
                storage_path = (data.get('storage_path') or '').strip()
                title = (data.get('title') or 'Sem título').strip()
                author = (data.get('author') or 'Desconhecido').strip()
                total_pages = int(data.get('total_pages') or 0)

                # Validação: storage_path DEVE começar com user_id (isolamento!)
                if not storage_path.startswith(f'{user_id}/'):
                    return self.send_json(403, {'error': 'Você só pode processar seus próprios uploads'})

                # INSERT ebook (com owner_user_id = user_id)
                slug = slugify(title) + '-' + datetime.now().strftime('%Y%m%d%H%M%S')
                ebook_req = Request(
                    f'{SUPABASE_URL}/rest/v1/ebooks',
                    data=json.dumps({
                        'slug': slug,
                        'title': title,
                        'author': author,
                        'description': f'Enviado por {user_id[:8]}... em {datetime.now().isoformat()}',
                        'pdf_storage_path': storage_path,  # será atualizado quando mover pra {user_id}/{ebook_id}/livro.pdf
                        'total_pages': total_pages,
                        'price_cents': 0,
                        'owner_user_id': user_id,
                        'is_published': True,
                    }).encode(),
                    headers={'apikey': SUPABASE_SR, 'Authorization': f'Bearer {SUPABASE_SR}',
                             'Content-Type': 'application/json',
                             'Prefer': 'return=representation'},
                    method='POST'
                )
                with urlopen(ebook_req, timeout=15) as r:
                    ebook_data = json.loads(r.read())
                ebook_id = ebook_data[0]['id']

                # Dispara job em background
                threading.Thread(
                    target=run_pipeline,
                    args=(user_id, ebook_id, storage_path, title, author, total_pages),
                    daemon=True
                ).start()

                # ETA: ~3s por página (BGE CPU), mínimo 60s
                eta_seconds = max(60, total_pages * 3)
                self.send_json(200, {
                    'ebook_id': ebook_id,
                    'slug': slug,
                    'status': 'processing',
                    'eta_seconds': eta_seconds,
                    'eta_minutes': max(1, eta_seconds // 60),
                    'message': f'Livro sendo indexado. Pronto em ~{eta_seconds // 60} minuto(s). Atualize a biblioteca ou espere o aviso.'
                })
            except Exception as e:
                self.send_json(500, {'error': str(e)[:500]})
            return

        self.send_json(404, {'error': 'not found'})


if __name__ == '__main__':
    print(f'Leitor IA Upload API: porta 9134', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9134), Handler).serve_forever()