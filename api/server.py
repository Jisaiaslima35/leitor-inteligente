#!/usr/bin/env python3
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

def answer(question, current_page):
    sources=retrieve(question,current_page)
    context='\n\n'.join(f'[FONTE: {s["title"]}, PDF página {s["page"]}]\n{s["text"]}' for s in sources)
    system='''Você é o Professor IA do livro O Poder do Hábito, de Charles Duhigg. Responda em português do Brasil, de forma didática e fiel ao livro. Use SOMENTE o contexto fornecido para explicar conteúdo da obra. Se a pergunta mencionar uma página ou capítulo, responda especificamente sobre ele. Não substitua a resposta por dicas genéricas sobre deixa/rotina/recompensa. Cite no fim as páginas PDF usadas. Se o contexto não contiver a resposta, diga claramente que não encontrou naquele conteúdo. Sobre metadados básicos, saiba: título O Poder do Hábito; autor Charles Duhigg; tradução Rafael Mantovani; edição brasileira Objetiva, 2012.'''
    payload=json.dumps({'model':'hermes-agent','messages':[{'role':'system','content':system},{'role':'user','content':f'Pergunta do leitor: {question}\nPágina atual no leitor: {current_page}\n\nCONTEXTO DO LIVRO:\n{context}'}],'temperature':0.2,'max_tokens':900}).encode()
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
    def do_POST(self):
        if self.path!='/ask': return self.send_json(404,{'error':'not found'})
        try:
            n=int(self.headers.get('Content-Length','0')); data=json.loads(self.rfile.read(n)); q=str(data.get('question','')).strip(); p=int(data.get('currentPage',1))
            if not q: return self.send_json(400,{'error':'Pergunta vazia'})
            self.send_json(200,answer(q,p))
        except Exception as e:
            self.send_json(500,{'error':str(e)[:500]})

if __name__=='__main__':
    print(f'Leitor IA API: {len(PAGES)} páginas, {len(CHAPTERS)} seções, porta 9130',flush=True)
    ThreadingHTTPServer(('127.0.0.1',9130),Handler).serve_forever()
