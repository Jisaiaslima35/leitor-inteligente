#!/usr/bin/env python3
import io
import json, os, re, threading, unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from functools import lru_cache

BOOK_TEXT = Path('/root/projetos/leitor-inteligente/data/o-poder-do-habito-pages.json')
PAGES = json.loads(BOOK_TEXT.read_text(encoding='utf-8'))

CHAPTERS = [
    (0, 'Prólogo — A cura do hábito', 6, 14),
    (1, 'O loop do hábito', 16, 41),
    (2, 'O cérebro ansioso', 42, 70),
    (3, 'A regra de ouro da mudança de hábito', 71, 101),
    (4, 'Hábitos angulares, ou a balada de Paul O’Neill', 103, 129),
    (5, 'Starbucks e o hábito do sucesso', 130, 153),
    (6, 'O poder de uma crise', 154, 178),
    (7, 'Como a Target sabe o que você quer antes que você saiba', 179, 206),
    (8, 'A Saddleback Church e o boicote aos ônibus de Montgomery', 208, 234),
    (9, 'A neurologia do livre-arbítrio', 235, 260),
    (10, 'Apêndice — Um guia para o leitor', 261, 271),
]

STOP = set('a o as os de da do das dos e ou em no na nos nas para por que com um uma é foi ser ter se sua seu esse essa deste deste livro capítulo pagina página explique diz fala sobre qual como quem onde porque'.split())

def norm(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s.lower()) if unicodedata.category(c) != 'Mn')

def tokens(s):
    return [x for x in re.findall(r'[a-z0-9]+', norm(s)) if len(x) > 2 and x not in STOP]

def find_chapter(number):
    for n,title,start,end in CHAPTERS:
        if n == number: return n,title,start,end
    return None

def retrieve(question, current_page=1):
    qn = norm(question)
    sources = []
    # Capítulo explícito tem prioridade absoluta.
    m = re.search(r'cap[ií]tulo\s+(\d+|um|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove)', qn)
    if m:
        words={'um':1,'dois':2,'tres':3,'quatro':4,'cinco':5,'seis':6,'sete':7,'oito':8,'nove':9}
        raw=m.group(1); number=int(raw) if raw.isdigit() else words.get(raw)
        ch=find_chapter(number)
        if ch:
            _,title,start,end=ch
            picks=[start, min(start+1,end), (start+end)//2, max(start,end-1), end]
            for p in dict.fromkeys(picks):
                sources.append({'page':p,'title':f'Capítulo {number} — {title}','text':PAGES[p-1]['text'][:7000]})
            return sources
    # Página explícita tem prioridade absoluta.
    m = re.search(r'p[aá]gina\s+(\d+)', qn)
    if m:
        p=max(1,min(len(PAGES),int(m.group(1))))
        for x in range(max(1,p-1),min(len(PAGES),p+1)+1):
            sources.append({'page':x,'title':f'Página {x}','text':PAGES[x-1]['text'][:7000]})
        return sources
    # Perguntas sobre autor/metadados.
    if any(x in qn for x in ['charles duhigg','autor','quem escreveu']):
        return [{'page':3,'title':'Ficha bibliográfica e autoria','text':PAGES[2]['text'][:7000]}]
    # Pesquisa lexical em todas as páginas, com página atual levemente favorecida.
    qt=tokens(question)
    scored=[]
    for item in PAGES:
        text=norm(item['text'])
        score=sum(3 if re.search(rf'\b{re.escape(t)}\b',text) else 1 if t in text else 0 for t in qt)
        if abs(item['page']-current_page)<=2: score += 0.7
        if score>0: scored.append((score,item))
    scored.sort(key=lambda x:x[0],reverse=True)
    for _,item in scored[:5]:
        title=next((f'Capítulo {n} — {t}' for n,t,s,e in CHAPTERS if s<=item['page']<=e),f'Página {item["page"]}')
        sources.append({'page':item['page'],'title':title,'text':item['text'][:7000]})
    if not sources:
        p=max(1,min(len(PAGES),current_page))
        sources=[{'page':p,'title':f'Página atual {p}','text':PAGES[p-1]['text'][:7000]}]
    return sources

def gateway_key():
    for path in ['/root/.hermes/.env']:
        for line in Path(path).read_text(errors='ignore').splitlines():
            if line.startswith('API_SERVER_KEY='):
                return line.split('=',1)[1].strip().strip('"').strip("'")
    raise RuntimeError('API_SERVER_KEY ausente')

KEY = gateway_key()

# 18/09/2026 v20: voice agent mobile — relay de transcrição pro Whisper local
# rodando em 127.0.0.1:9903 (audio-api.service, Rádio Louvor, faster-whisper).
# Mobile não tem window.SpeechRecognition; o front grava via MediaRecorder e
# manda o Blob webm/mp4 pra cá. Sem estado, sem auth (rota interna).
WHISPER_URL = 'http://127.0.0.1:9903/audio'
WHISPER_TIMEOUT = 25  # segundos; faster-whisper ~4s típico mas pode variar
WHISPER_MAX_AUDIO_BYTES = 8 * 1024 * 1024  # 8MB

def answer(question, current_page, is_voice=False, modo_mentor=False):
    sources=retrieve(question,current_page)
    context='\n\n'.join(f'[FONTE: {s["title"]}, PDF página {s["page"]}]\n{s["text"]}' for s in sources)
    if is_voice:
        if modo_mentor:
            system = (
                "Você é o Mentor Socrático do livro O Poder do Hábito, conversando exclusivamente por VOZ em tempo real. "
                "REGRAS RÍGIDAS DE CONVERSAÇÃO (OBRIGATÓRIO):\n"
                "1. LIMITE ABSOLUTO: Responda em NO MÁXIMO 2 frases curtas (MÁXIMO DE 30 PALAVRAS NO TOTAL).\n"
                "2. ZERO METADADOS: JAMAIS cite ficha técnica, tradutor, editora, ano ou páginas.\n"
                "3. Conclua SEMPRE com 1 pergunta curta provocando reflexão ou ação prática."
            )
        else:
            system = (
                "Você é o Professor IA do livro O Poder do Hábito, conversando exclusivamente por VOZ em tempo real. "
                "REGRAS RÍGIDAS DE CONVERSAÇÃO (OBRIGATÓRIO):\n"
                "1. LIMITE ABSOLUTO: Responda em NO MÁXIMO 2 frases curtas e simples (MÁXIMO DE 30 PALAVRAS NO TOTAL).\n"
                "2. ZERO METADADOS: JAMAIS cite editora, tradutor, ano ou listas de capítulos.\n"
                "3. Explique a ideia central em 1 frase e valide o entendimento em outra frase curta."
            )
        tokens_limit = 100
    else:
        system='''Você é o Professor IA do livro O Poder do Hábito, de Charles Duhigg. Responda em português do Brasil, de forma didática e fiel ao livro. Use SOMENTE o contexto fornecido para explicar conteúdo da obra. Se a pergunta mencionar uma página ou capítulo, responda especificamente sobre ele. Não substitua a resposta por dicas genéricas sobre deixa/rotina/recompensa. Cite no fim as páginas PDF usadas. Se o contexto não contiver a resposta, diga claramente que não encontrou naquele conteúdo.'''
        tokens_limit = 900

    payload=json.dumps({
        'model':'hermes-agent',
        'messages':[
            {'role':'system','content':system},
            {'role':'user','content':f'Pergunta do leitor: {question}\nPágina atual no leitor: {current_page}\n\nCONTEXTO DO LIVRO:\n{context}'}
        ],
        'temperature':0.2,
        'max_tokens':tokens_limit
    }).encode()
    req=Request('http://127.0.0.1:8642/v1/chat/completions',data=payload,headers={'Content-Type':'application/json','Authorization':f'Bearer {KEY}'},method='POST')
    with urlopen(req,timeout=120) as r:
        data=json.loads(r.read())
    text=data['choices'][0]['message']['content'].strip()
    return {'answer':text,'sources':[{'id':f'p{s["page"]}','title':s['title'],'page':s['page'],'excerpt':s['text'][:240]} for s in sources]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send_json(self,code,obj):
        body=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(body))); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','Content-Type'); self.send_header('Access-Control-Allow-Methods','POST,GET,OPTIONS'); self.end_headers()
    def do_GET(self):
        if self.path=='/health': self.send_json(200,{'status':'ok','pages':len(PAGES),'chapters':len(CHAPTERS)})
        else: self.send_json(404,{'error':'not found'})

    def _extract_multipart_audio(self, body: bytes, boundary: bytes) -> bytes | None:
        """Extrai o conteúdo do campo 'audio' do multipart/form-data.

        Espelha o parser do audio-api.service (127.0.0.1:9903) — formato
        canonical: --boundary\r\nContent-Disposition: form-data; name="audio"\r\n\r\n
        <bytes>\r\n--boundary--\r\n
        """
        sep = b'--' + boundary
        for part in body.split(sep):
            if b'name="audio"' not in part:
                continue
            idx = part.find(b'\r\n\r\n')
            if idx == -1:
                continue
            content = part[idx + 4:]
            if content.endswith(b'\r\n'):
                content = content[:-2]
            return content
        return None

    def _handle_transcribe(self):
        """Relay multipart → 127.0.0.1:9903/audio (faster-whisper).

        Espera multipart/form-data com campo 'audio'. Devolve {text} ou
        {text:'', empty:true} se Whisper não detectou fala.
        """
        try:
            ctype = self.headers.get('Content-Type', '')
            if 'multipart/form-data' not in ctype:
                return self.send_json(400, {'error': 'Content-Type deve ser multipart/form-data'})

            # Boundary: aceita com ou sem aspas em torno do valor
            try:
                boundary_raw = ctype.split('boundary=')[1].split(';')[0].strip()
                if boundary_raw.startswith('"') and boundary_raw.endswith('"'):
                    boundary_raw = boundary_raw[1:-1]
                boundary = boundary_raw.encode()
            except (IndexError, ValueError):
                return self.send_json(400, {'error': 'boundary ausente no Content-Type'})

            n = int(self.headers.get('Content-Length', '0'))
            if n <= 0:
                return self.send_json(400, {'error': 'body vazio'})
            if n > WHISPER_MAX_AUDIO_BYTES:
                return self.send_json(413, {'error': f'audio > {WHISPER_MAX_AUDIO_BYTES // (1024*1024)}MB'})

            body = self.rfile.read(n)
            audio_bytes = self._extract_multipart_audio(body, boundary)
            if not audio_bytes:
                return self.send_json(400, {'error': 'campo "audio" ausente no multipart'})

            # Repassa pro Whisper local — reconstrói multipart novo (boundary limpo)
            mp = io.BytesIO()
            mp.write(b'--XCLDWHISPER\r\n')
            mp.write(b'Content-Disposition: form-data; name="audio"\r\n')
            mp.write(b'Content-Type: application/octet-stream\r\n\r\n')
            mp.write(audio_bytes)
            mp.write(b'\r\n--XCLDWHISPER--\r\n')

            req = Request(
                WHISPER_URL,
                data=mp.getvalue(),
                headers={'Content-Type': 'multipart/form-data; boundary=XCLDWHISPER'},
                method='POST',
            )
            try:
                with urlopen(req, timeout=WHISPER_TIMEOUT) as r:
                    whisper_resp = json.loads(r.read())
            except Exception as we:
                return self.send_json(504, {'error': f'whisper timeout/erro: {str(we)[:180]}'})

            transcricao = (whisper_resp.get('transcricao') or '').strip()
            if not transcricao or transcricao == '(áudio sem fala detectada)':
                return self.send_json(200, {'text': '', 'empty': True})

            return self.send_json(200, {'text': transcricao})
        except Exception as e:
            return self.send_json(500, {'error': f'transcribe falhou: {str(e)[:200]}'})

    def do_POST(self):
        if self.path in ('/voice/session/start', '/api/voice/session/start'):
            try:
                from voice_session import start_voice_session
                n = int(self.headers.get('Content-Length', '0'))
                data = json.loads(self.rfile.read(n)) if n > 0 else {}
                ebook_id = str(data.get('ebook_id') or data.get('book_id') or data.get('slug') or '').strip()
                if not ebook_id:
                    return self.send_json(400, {'error': 'ebook_id obrigatório'})
                origin = self.headers.get('Origin', 'https://leitorinteligente.automacaojs.us')
                res = start_voice_session(ebook_id, origin)
                return self.send_json(200, res)
            except ValueError as ve:
                return self.send_json(404, {'error': str(ve)})
            except Exception as e:
                return self.send_json(500, {'error': str(e)[:500]})

        if self.path in ('/voice/query', '/api/voice/query'):
            try:
                from voice_session import answer_voice_query
                n = int(self.headers.get('Content-Length', '0'))
                data = json.loads(self.rfile.read(n)) if n > 0 else {}
                q = str(data.get('question', '')).strip()
                ebook_id = str(data.get('ebook_id') or data.get('book_id') or data.get('bookId') or data.get('slug') or '').strip()
                if not q:
                    return self.send_json(400, {'error': 'Pergunta vazia'})
                if not ebook_id:
                    return self.send_json(400, {'error': 'ebook_id obrigatório'})
                modo_mentor = data.get('modoMentor')
                res = answer_voice_query(q, ebook_id, modo_mentor=modo_mentor)
                return self.send_json(200, res)
            except ValueError as ve:
                return self.send_json(404, {'error': str(ve)})
            except Exception as e:
                return self.send_json(500, {'error': str(e)[:500]})

        if self.path in ('/voice/transcribe', '/api/voice/transcribe'):
            return self._handle_transcribe()

        if self.path != '/ask': return self.send_json(404, {'error': 'not found'})
        try:
            n=int(self.headers.get('Content-Length','0')); data=json.loads(self.rfile.read(n)); q=str(data.get('question','')).strip(); p=int(data.get('currentPage',1))
            ebook_id = str(data.get('ebook_id') or data.get('book_id') or data.get('bookId') or data.get('slug') or '').strip()
            is_voice = bool(data.get('is_voice') or data.get('isVoice') or data.get('modoMentor') is not None)
            modo_mentor = bool(data.get('modoMentor', False))
            if not q: return self.send_json(400,{'error':'Pergunta vazia'})
            if is_voice and ebook_id:
                from voice_session import answer_voice_query
                return self.send_json(200, answer_voice_query(q, ebook_id, modo_mentor=modo_mentor))
            self.send_json(200,answer(q,p,is_voice=is_voice,modo_mentor=modo_mentor))
        except Exception as e:
            self.send_json(500,{'error':str(e)[:500]})

if __name__=='__main__':
    print(f'Leitor IA API: {len(PAGES)} páginas, {len(CHAPTERS)} seções, porta 9130',flush=True)
    ThreadingHTTPServer(('127.0.0.1',9130),Handler).serve_forever()
