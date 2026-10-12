import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ROOT } from '../helpers.js';
import { loadConfig } from '../../src/config/load.js';
const manager = await import(pathToFileURL(join(ROOT, 'deploy/windows/manage.mjs')).href);
const template = JSON.parse(readFileSync(join(ROOT, 'deploy/windows/opencode.template.json'), 'utf8'));
const profile = {gatewayBaseURL:'https://localhost/llm/v1', modelId:'example', tokenizerSha256:'a'.repeat(64), provenance:{model:'fixture', revision:'r1', source:'test', approval:'test', license:'MIT'}, config:{preset:'32k'}};

test('Windows generated client follows effective preset and profile API path without mutating template', () => {
  for (const preset of ['32k','64k','100k','128k']) {
    const cfg = loadConfig({preset, env:{}}).config;
    const result = manager.generatedClientConfig(profile, cfg, template);
    assert.deepEqual(result.provider.kitzur.models.example.limit, {context:cfg.budget.window, output:cfg.budget.defaultMaxTokens});
    assert.equal(result.provider.kitzur.options.baseURL,'http://127.0.0.1:8270/llm/v1');
    assert.equal(result.model,'kitzur/example');
  }
  assert.equal(template.provider.kitzur.models.REPLACE_WITH_GATEWAY_MODEL_ID.limit.context,100000);
  const cfg=loadConfig({preset:'32k', env:{}}).config;
  cfg.client.outputLimit=6000;
  assert.equal(manager.generatedClientConfig(profile,cfg,template).provider.kitzur.models.example.limit.output,6000);
  cfg.client.compactionPointTokens=10000;
  assert.throws(() => manager.generatedClientConfig(profile,cfg,template),/custom compaction/);
  cfg.client.compactionPointTokens=null; cfg.client.outputLimit=40000;
  assert.throws(() => manager.generatedClientConfig(profile,cfg,template),/incompatible/);
});

test('Windows profiles validate template, provenance, policy and credential-free endpoint', () => {
  assert.equal(manager.profileTemplate(profile),'qwen3');
  assert.equal(manager.profileTemplate({...profile,tokenizerTemplate:'chatml'}),'chatml');
  assert.throws(() => manager.profileTemplate({...profile,tokenizerTemplate:'arbitrary'}));
  assert.equal(manager.validateProfile(profile).origin,'https://localhost');
  for (const bad of [{...profile,gatewayBaseURL:'https://secret@localhost/v1'}, {...profile,config:{upstream:{headers:{Authorization:'secret'}}}}, {...profile,provenance:{approval:'test'}}, {...profile,extra:'secret'}]) {
    assert.throws(() => manager.validateProfile(bad));
  }
});

test('Windows diagnostics allow only finite counters and recognized budget modes', () => {
  const s={name:'kitzur',version:'0.1.0',config:{upstream:'secret',window:32000,server:{budgetMode:'strict_total'}},counter:{mode:'exact',id:'secret'},counters:{requests:4,chat_requests:3,retries:1,usage_mismatch:Infinity,credential:'secret'},actions:{compact:2,secret:3},guard:{'engine:secret':2,'engine:bad':Infinity,'secret':1,'bad':NaN},warnings:[{message:'secret'}]};
  const d=manager.diagnostics(s);
  assert.equal(d.budgetMode,'strict_total');
  assert.equal(manager.diagnostics({...s,budget:{mode:'prompt_only'}}).budgetMode,'prompt_only');
  assert.equal(d.guard.engineExceptions,2);
  assert.equal(d.counters.usage_mismatch,undefined);
  assert.ok(!JSON.stringify(d).includes('secret'));
  assert.deepEqual(manager.diagnostics(null).limits,{});
});

test('Windows manifest validates spaces, listed bytes, completeness and path aliases', () => {
  const dir=mkdtempSync(join(tmpdir(),'kitzur manifest spaces '));
  try {
    mkdirSync(join(dir,'deploy/windows'),{recursive:true});
    writeFileSync(join(dir,'deploy/windows/manage.mjs'),'fixture');
    const digest=createHash('sha256').update('fixture').digest('hex');
    const line=(rel:string)=>`${digest}  ./${rel}\n`;
    const valid=line('deploy/windows/manage.mjs');
    writeFileSync(join(dir,'SHA256SUMS'),valid);
    assert.deepEqual(manager.verifiedManifest(dir),['deploy/windows/manage.mjs']);
    for (const bad of ['',line('../outside'),line('C:/outside'),line('a\\b'),line('file:stream'),line('a/./b'),line('a//b'),line('a./b'),line('nul.txt'),valid+line('DEPLOY/windows/manage.mjs')]) {
      writeFileSync(join(dir,'SHA256SUMS'),bad);
      assert.throws(() => manager.verifiedManifest(dir),bad);
    }
    writeFileSync(join(dir,'SHA256SUMS'),valid);
    writeFileSync(join(dir,'deploy/windows/manage.mjs'),'changed');
    assert.throws(() => manager.verifiedManifest(dir),/checksum/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Windows manifest rejects a symlinked/junction parent even within bundle', () => {
  const dir=mkdtempSync(join(tmpdir(),'kitzur manifest link '));
  try {
    mkdirSync(join(dir,'real/windows'),{recursive:true});
    writeFileSync(join(dir,'real/windows/manage.mjs'),'fixture');
    symlinkSync(join(dir,'real'),join(dir,'deploy'),process.platform==='win32'?'junction':'dir');
    const digest=createHash('sha256').update('fixture').digest('hex');
    writeFileSync(join(dir,'SHA256SUMS'),`${digest}  ./deploy/windows/manage.mjs\n`);
    assert.throws(() => manager.verifiedManifest(dir),/links/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
