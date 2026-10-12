import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
