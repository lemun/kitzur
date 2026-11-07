import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';

test('doctor CLI reports missing and bad config as safe machine-readable errors',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'kitzur-doctor-cli-'));const output:string[]=[];const errors:string[]=[];
  const io:CliIO={stdout:s=>void output.push(s),stderr:s=>void errors.push(s),env:{},cwd:dir,onSignal:()=>{}};
  for(const file of ['missing.json','bad.json']){
    if(file==='bad.json')writeFileSync(join(dir,file),'{"upstream":{"headers":{"Authorization":"SECRET_VALUE"},} BROKEN');
    output.length=0;errors.length=0;
    assert.equal(await main(['doctor','--config',file,'--json'],io),2);
    assert.equal(JSON.parse(output.join('')).checks[0].code,'config.load');
    assert.doesNotMatch(output.join('')+errors.join(''),/SECRET_VALUE|BROKEN/);
  }
  assert.equal(await main(['doctor','--timeout-ms','Infinity'],io),2);
  assert.equal(await main(['doctor','--upstream','http://127.0.0.1:1','--json'],io),0,'--upstream URL config option does not imply network probe');
});
test('doctor CLI forwards --model and limits profile checks to the exact model', async () => {
  const dir=mkdtempSync(join(tmpdir(),'kitzur-doctor-model-cli-'));let output='';
  const io:CliIO={stdout:s=>{output+=s;},stderr:()=>{},env:{},cwd:dir,onSignal:()=>{}};
  writeFileSync(join(dir,'config.json'), JSON.stringify({ models: { alpha: { tokenizer: { mode: 'estimate' } }, beta: {} } }));
  assert.equal(await main(['doctor','--config','config.json','--model','alpha','--json'],io),0);
  const checks=JSON.parse(output).checks as Array<{code:string}>;
  assert.ok(checks.some(c=>c.code==='model.alpha.budget'));
  assert.ok(!checks.some(c=>c.code.startsWith('model.beta.')));
  output='';
  assert.equal(await main(['doctor','--config','config.json','--model','missing','--json'],io),0);
  assert.ok((JSON.parse(output).checks as Array<{code:string}>).some(c=>c.code==='model.missing.profile'));
});
test('report CLI empty/malformed/unreadable exit codes and JSON shape',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'kitzur-report-cli-'));let output='';
  const io:CliIO={stdout:s=>{output+=s;},stderr:()=>{},env:{},cwd:dir,onSignal:()=>{}};
  writeFileSync(join(dir,'empty.jsonl'),'');
  assert.equal(await main(['report','empty.jsonl','--json'],io),0);
  assert.equal(JSON.parse(output).requests,0);
  output='';writeFileSync(join(dir,'bad.jsonl'),'{SECRET_VALUE');
  assert.equal(await main(['report','bad.jsonl','--json'],io),1);
  assert.doesNotMatch(output,/SECRET_VALUE/);assert.equal(JSON.parse(output).coverage.malformed,1);
  assert.equal(await main(['report','absent.jsonl'],io),1);
  assert.equal(await main(['report'],io),2);
});
test('report CLI names the unreadable path and cause',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'kitzur-report-unreadable-'));let errors='';
  const io:CliIO={stdout:()=>{},stderr:s=>{errors+=s;},env:{},cwd:dir,onSignal:()=>{}};
  assert.equal(await main(['report','nonexist.jsonl'],io),1);
  assert.equal(errors,'kitzur: report could not read nonexist.jsonl: no such file; pass the file written by stats.path (see kitzur doctor)\n');
  errors='';mkdirSync(join(dir,'stats'));
  assert.equal(await main(['report','stats'],io),1);
  assert.match(errors,/^kitzur: report could not read stats: it is a directory;/);
});
test('tls-probe CLI explains bad origins without echoing credentials',async()=>{
  let errors='';
  const io:CliIO={stdout:()=>{},stderr:s=>{errors+=s;},env:{},cwd:tmpdir(),onSignal:()=>{}};
  const cases:Array<[string,RegExp]>=[
    ['notaurl',/tls-probe needs an origin such as https:\/\/gateway\.example\.com/],
    ['ftp://x',/tls-probe only inspects https origins, not ftp/],
    ['http://gw',/tls-probe only inspects https origins, not http\b/],
    ['https://alice:SECRET_VALUE@gw',/tls-probe origin must not contain credentials; remove the user:password@ part/],
    ['http://alice:SECRET_VALUE@gw',/tls-probe only inspects https origins, not http\b/],
  ];
  for(const [origin,message] of cases){
    errors='';
    assert.equal(await main(['tls-probe',origin],io),2,origin);
    assert.match(errors,message);
    assert.doesNotMatch(errors,/alice|SECRET_VALUE/);
  }
});
