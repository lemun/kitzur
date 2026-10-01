"""Regenerate sanitized scenario goldens using the independent Python reference.
Run with a venv containing tokenizers==0.23.2 and jinja2 after fetching the tokenizer.
"""
import functools, gzip, hashlib, json, os, pathlib, subprocess, sys, tempfile
from tokenizers import Tokenizer
ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'test/fixtures'
SIM = ROOT / 'bench/reference/sim'
TOK = ROOT / 'bench/.cache/Qwen3.6-27B-tokenizer.json'
sys.path.insert(0, str(SIM))
import scenario as sc
sc._tok = Tokenizer.from_file(str(TOK))
# Cache segments between added tokens: tokenizers splits them before NFC/BPE.
import re
special = json.loads(TOK.read_text())['added_tokens']
split = re.compile('('+'|'.join(re.escape(x['content']) for x in sorted(special,key=lambda x:-len(x['content'])))+')')
@functools.lru_cache(maxsize=8192)
def segment(s): return len(sc._tok.encode(s, add_special_tokens=False).ids)
def count(s): return sum(segment(x) for x in split.split(s) if x)
sc.count_text = count
sc.count_tokens = lambda b: count(sc.render(b))
def load(n):
 p=FIX/n; return json.loads(gzip.decompress(p.read_bytes()) if p.suffix=='.gz' else p.read_bytes())
def put(n,x):
 p=FIX/n; data=json.dumps(x,ensure_ascii=True,separators=(',',':')).encode()
 p.write_bytes(gzip.compress(data,mtime=0) if p.suffix=='.gz' else data)
def sha(s):return hashlib.sha256(s.encode()).hexdigest()
def env(e):
 for k in ['SIM_CAP_BYTES','SIM_CHATTY','SIM_HUGE_AT','SIM_HUGE_CHARS']:os.environ.pop(k,None)
 os.environ.update({k:v for k,v in e.items() if v is not None})
def histories(n):
 h=[{'role':'system','content':sc.system_prompt()},{'role':'user','content':sc.GOAL_TEXT}]
 for i in range(n):
  yield {'model':'local-model','messages':h,'tools':sc.tools(),'max_tokens':32000,'stream':True,'stream_options':{'include_usage':True}}
  m=sc.assistant_message(i);h.append(m)
  for c in m['tool_calls']:h.append({'role':'tool','tool_call_id':c['id'],'content':sc.tool_output(i)})
  if i in sc.USER_INJECT:h.append({'role':'user','content':sc.USER_INJECT[i]})
g=load('bench/scenario.json.gz');env({})
s=sc.system_prompt(); g['system_prompt'].update(sha256=sha(s),pylen=len(s),head=s[:300],tail=s[-200:])
for v in g['variants'].values():
 env(v['env'])
 for r in v['steps']:
  i=r['step'];s=sc.tool_output(i);m=sc.assistant_message(i)
  r.update(kind=sc._kind(i),tool_output_sha256=sha(s),tool_output_pylen=len(s),tool_output_utf8=len(s.encode()),tool_output_head=s[:len(r['tool_output_head'])],tool_output_tail=s[-len(r['tool_output_tail']):],assistant_json_sha256=sha(json.dumps(m)),assistant_content=m['content'],tool_name=m['tool_calls'][0]['function']['name'],arguments=m['tool_calls'][0]['function']['arguments'])
  if 'completion_tokens' in r:r.update(completion_tokens=count((m['content'] or '')+json.dumps(m['tool_calls'])),tool_output_tokens=count(s))
put('bench/scenario.json.gz',g);print('scenario',flush=True)
g=load('bench/render.json.gz')
for v in g['variants'].values():
 env(v['env'])
 for r,b in zip(v['steps'],histories(len(v['steps']))):
  s=sc.render(b);d=json.dumps(b);base={k:v for k,v in b.items() if k!='stream_options'}
  r.update(render_sha256=sha(s),render_pylen=len(s),est_usage=sc.est_tokens(b),body_dumps_default_sha256=sha(d),body_dumps_default_len=len(d),est_nousage=sc.est_tokens(base),est_nostream=sc.est_tokens(dict(base,stream=False)))
for e in g['edge']:e.update(render=sc.render(e['body']),est=sc.est_tokens(e['body']))
put('bench/render.json.gz',g);print('render',flush=True)
c=load('bench/counts.json.gz')
for v in c.values():
 env(v['env']);v['per_step']=[];v['per_step_est']=[]
 for b in histories(v['steps']):v['per_step'].append(sc.count_tokens(b));v['per_step_est'].append(sc.est_tokens(b))
put('bench/counts.json.gz',c);print('counts',flush=True)
# Template generator uses the Python renderer and Jinja template as separate oracles.
with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
 json.dump(g,f);f.flush()
 subprocess.run([sys.executable,str(ROOT/'scripts/tokenizer/gen_template_goldens.py'),'--sim',str(SIM),'--tokenizer',str(TOK),'--render-golden',f.name],check=True)
# Re-encode text vectors through the independent Rust/Python tokenizer.
p=FIX/'tokenizer-fixture.jsonl.gz'; rows=[json.loads(x) for x in gzip.decompress(p.read_bytes()).decode().strip().split('\n')]
for r in rows:r['ids']=sc._tok.encode(r['text'],add_special_tokens=False).ids
p.write_bytes(gzip.compress(('\n'.join(json.dumps(r,ensure_ascii=True) for r in rows)+'\n').encode(),mtime=0))
h=load('sim-history.json.gz');rows=load('estimate-corpus.json.gz')
for r in rows:r['tokens']=count(r.get('text',h['system'] if r.get('step')==-1 else h['steps'][r.get('step',0)]['output']))
put('estimate-corpus.json.gz',rows)
# baseline.py executes as a program; preserve its independent algorithm.
g=load('bench/baseline.json.gz')
for name in g:
 env({'SIM_CAP_BYTES':None if name=='uncapped' else '50000' if name=='cap50000' else '51200'})
 argv=[sys.executable,str(SIM/'baseline.py')]
 if name.endswith('s3000'):argv+=['--summary-tokens','3000']
 e=dict(os.environ,KITZUR_BENCH_TOKENIZER=str(TOK))
 g[name]=subprocess.check_output(argv,env=e,text=True)
put('bench/baseline.json.gz',g);print('baseline and tokenizer goldens',flush=True)
