// Run from the repository root: node --import tsx reports/audit-probes.mjs
// Uses temporary Git repositories and fake workers. No provider or GitHub calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../src/process.ts';
import { defineSortie } from '../src/types.ts';
import { contractSnapshot, executeRun } from '../src/runtime.ts';
import { EventStore } from '../src/store.ts';
import { createWorktree, worktreePaths, commitChanges, cherryPick, containsCommit } from '../src/git.ts';
import { Codex } from '@openai/codex-sdk';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { ScriptedAdapter } from '../src/adapters/scripted.ts';

const roots = [];
const observations = [];
const previousRouting = process.env.MUSTER_ROUTING_FILE;
async function fixture(overrides = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'muster-audit-'));
  roots.push(repo);
  const git = (...args) => command('git', args, { cwd: repo });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Audit');
  await git('config', 'user.email', 'audit@example.invalid');
  await writeFile(join(repo, '.gitignore'), '.muster/\n');
  await writeFile(join(repo, 'README.md'), 'fixture\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  await mkdir(join(repo, '.muster'));
  const routing = join(repo, '.muster/routing.json');
  await writeFile(routing, JSON.stringify({taskTypes: {
    implementation: [{provider:'scripted'}], verification: [{provider:'scripted'}]
  }}));
  process.env.MUSTER_ROUTING_FILE = routing;
  const sortie = defineSortie({name:'Audit fixture', contract:{summary:'Audit', criteria:[
    {id:'artifact', description:'Artifact exists', evidence:{kind:'command',command:'test -f implement.txt'}}
  ]}, roles:{implementer:{taskType:'implementation'},verifier:{taskType:'verification'}},
  limits:{maxConcurrency:2,maxTaskAttempts:2,maxRepairRounds:0},
  tasks:[{id:'implement',title:'Implement',prompt:'Create artifact'}],pullRequest:{enabled:false},...overrides});
  const sortiePath = join(repo, '.muster/sortie.ts');
  await writeFile(sortiePath, `export default ${JSON.stringify(sortie)};`);
  const snapshot = contractSnapshot(sortie);
  const store = new EventStore(repo);
  store.createRun({id:'audit',status:'queued',repo_root:repo,sortie_path:sortiePath,
    contract_hash:snapshot.hash,contract_json:snapshot.json,branch:'muster/audit',base_branch:'main'});
  store.close();
  return {repo,git,sortie,paths:worktreePaths(repo,'audit')};
}
async function run(f) {
  await executeRun(f.repo,'audit');
  const store = new EventStore(f.repo);
  const result = {run:store.getRun('audit'),tasks:store.tasks('audit'),checks:store.checks('audit')};
  store.close();
  return result;
}
try {
  {
    const f = await fixture({contract:{summary:'Empty',criteria:[]},tasks:[]});
    const r = await run(f);
    assert.equal(r.run.status,'succeeded');
    observations.push({id:'F04',probe:'Empty contract',observed:'Run succeeded with zero tasks and zero checks.'});
  }
  {
    const f = await fixture({contract:{summary:'Dirty check',criteria:[
      {id:'artifact',description:'Artifact exists',evidence:{kind:'command',command:'echo required > only-in-check.txt; test -f only-in-check.txt'}}
    ]}});
    const r = await run(f);
    assert.equal(r.run.status,'succeeded');
    const artifact = await command('git',['show','muster/audit:only-in-check.txt'],{cwd:f.repo,allowFailure:true});
    assert.notEqual(artifact.exitCode,0);
    observations.push({id:'F01',probe:'Check writes a required artifact',observed:'Run succeeded, but only-in-check.txt is absent from the accepted branch.'});
  }
  {
    const f = await fixture({tasks:[{id:'integration',title:'Collision',prompt:'Create artifact'}]});
    const r = await run(f);
    assert.equal(r.run.status,'failed');
    await assert.rejects(access(f.paths.integration));
    observations.push({id:'F04',probe:'Task named integration',observed:'Worker path collided with integration path; failure cleanup deleted the integration worktree.'});
  }
  {
    const f = await fixture();
    await createWorktree(f.repo,f.paths.integration,'muster/audit','main');
    await createWorktree(f.repo,f.paths.task('implement'),'muster-worker/audit/implement-a1','main');
    await writeFile(join(f.paths.task('implement'),'unfinished.txt'),'preserve me');
    const store = new EventStore(f.repo);
    store.ensureTask('audit','implement');
    store.updateTask('audit','implement',{status:'running',attempts:1,worktree:f.paths.task('implement'),branch:'muster-worker/audit/implement-a1'});
    store.close();
    const r = await run(f);
    assert.equal(r.run.status,'failed');
    await assert.rejects(access(join(f.paths.task('implement'),'unfinished.txt')));
    observations.push({id:'F02',probe:'Resume with an interrupted worker worktree',observed:'Attempt 2 failed creating the occupied path, exhausted retries, and deleted unfinished.txt.'});
  }
  {
    const f = await fixture();
    await createWorktree(f.repo,f.paths.integration,'muster/audit','main');
    await createWorktree(f.repo,f.paths.task('implement'),'worker','main');
    await writeFile(join(f.paths.task('implement'),'implement.txt'),'worker change');
    const sha = await commitChanges(f.paths.task('implement'),'worker');
    await writeFile(join(f.paths.integration,'other.txt'),'other task');
    await commitChanges(f.paths.integration,'other task');
    await cherryPick(f.paths.integration,sha);
    assert.equal(await containsCommit(f.paths.integration,sha),false);
    await assert.rejects(cherryPick(f.paths.integration,sha));
    observations.push({id:'F03',probe:'Recovery after cherry-pick before DB update',observed:'Applied worker commit was not an ancestor; recovery tried it again and failed on an empty cherry-pick.'});
  }
  {
    const original = Codex.prototype.startThread;
    Codex.prototype.startThread = function() { return {id:'fake',async runStreamed() {return {events:(async function*(){
      yield {type:'turn.failed',error:{message:'simulated provider failure'}};
    })()};}};};
    try {
      const result = await new CodexAdapter().run({runId:'audit',taskId:'fake',prompt:'x',cwd:process.cwd(),stateDir:tmpdir(),readOnly:false,signal:new AbortController().signal,onEvent(){}});
      assert.equal(result.finalText,'');
      observations.push({id:'F07',probe:'Codex streamed turn.failed',observed:'Adapter resolved successfully with empty finalText after a provider failure event.'});
    } finally {Codex.prototype.startThread = original;}
  }
  {
    const f = await fixture();
    await writeFile(join(f.repo,'later.txt'),'Changed after run creation');
    await f.git('add','later.txt');
    await f.git('commit','-m','Move base after run creation');
    const r = await run(f);
    assert.equal(r.run.status,'succeeded');
    assert.match((await f.git('show','muster/audit:later.txt')).stdout,/Changed after/);
    observations.push({id:'F08',probe:'Move base ref after recording run',observed:'Accepted branch included a commit added after run creation; no base SHA was pinned.'});
  }
  {
    const f = await fixture({tasks:[{id:'fast',title:'Fail',prompt:'fail'},{id:'slow',title:'Slow',prompt:'slow'}],limits:{maxConcurrency:2,maxTaskAttempts:1,maxRepairRounds:0}});
    const original = ScriptedAdapter.prototype.run;
    let slowFinished = false;
    let callbackError = '';
    ScriptedAdapter.prototype.run = async function(request) {
      if(request.taskId === 'fast') {
        await new Promise(resolve => setTimeout(resolve,50));
        throw new Error('Injected failure');
      }
      await new Promise(resolve => setTimeout(resolve,500));
      try {request.onEvent('audit.late',{});} catch(error) {callbackError = error.message;}
      slowFinished = true;
      return {finalText:'done'};
    };
    try {
      const r = await run(f);
      assert.equal(r.run.status,'failed');
      assert.equal(slowFinished,false);
      await new Promise(resolve => setTimeout(resolve,600));
      assert.match(callbackError,/not open|closed/i);
      observations.push({id:'F05',probe:'One concurrent task fails while another is active',observed:'executeRun returned failed before slow worker finished; its later event hit a closed database.'});
    } finally {ScriptedAdapter.prototype.run = original;}
  }
  console.log(JSON.stringify({date:'2026-09-11',observations},null,2));
} finally {
  if (previousRouting === undefined) delete process.env.MUSTER_ROUTING_FILE;
  else process.env.MUSTER_ROUTING_FILE = previousRouting;
  await Promise.all(roots.map(root => rm(root,{recursive:true,force:true})));
}
