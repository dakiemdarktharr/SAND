import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, RunEvent } from '../control-plane/src/types.js';
import { projectId, blockedProjectId } from './database.js';

async function start(directory: string, token: string) {
  const child = spawn(process.execPath, ['--import','tsx',fileURLToPath(new URL('./server.ts', import.meta.url))], {
    windowsHide:true, stdio:['ignore','pipe','pipe','ipc'],
    env:{...process.env, SAND_DEMO_DIRECTORY:directory, SAND_DEMO_TOKEN:token},
  });
  child.stderr?.on('data', () => { /* Child diagnostics deliberately excluded from evidence and token-safe errors. */ });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const ready = await new Promise<{address:string; pid:number; migrations:string[]; outboxCount:number; deliveredOutbox:number}>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Local demo server timed out; check Node 24, dependencies and disk access.')); }, 45_000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Could not start local demo server.')); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Local demo server stopped before readiness; check disk access and lock ownership.')); });
    child.on('message', message => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
        clearTimeout(timeout);
        resolve(message as unknown as {address:string; pid:number; migrations:string[]; outboxCount:number; deliveredOutbox:number});
      }
    });
  });
  return {...ready, stop:async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Demo server exited unexpectedly.');
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {child.send('stop'); assert.equal(await exited, 0, 'Server must shut down cleanly');}
    finally {clearTimeout(timeout);}
  }};
}

export async function runDemo() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local demo is disabled in production.');
  const started = performance.now();
  await mkdir('.runtime', {recursive:true});
  const directory = await mkdtemp(path.resolve('.runtime/resume-demo-'));
  const token = randomBytes(32).toString('hex');
  const records: Record<string, unknown>[] = [];
  const emit = (event: string, data: Record<string, unknown>) => {
    const record = {event, at:new Date().toISOString(), ...data};
    records.push(record); console.log(JSON.stringify(record));
  };
  emit('demo.started', {mode:'local-development', database:'disk-backed PGlite', directory, providerRequests:0});
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(directory, token);
    const firstPid = server.pid;
    const versions = server.migrations;
    async function request<T>(route: string, status = 200, body?: unknown, key?: string): Promise<T> {
      assert(server);
      const response = await fetch(new URL(route, server.address), {method:body === undefined ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(10_000), headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json', ...(key ? {'Idempotency-Key':key} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      assert.equal(response.status, status, route + ': unexpected HTTP status');
      return await response.json() as T;
    }
    const projects = await request<{projects:{id:string}[]}>('/v1/projects');
    assert.equal(projects.projects.length, 1); assert.equal(projects.projects[0]?.id, projectId);
    emit('project.registered', {projectId, reason:'explicit local-development bootstrap', migrations:versions});
    const denied = await request<{error:{code:string}}>('/v1/runs', 403, {projectId:blockedProjectId, kind:'registry.refresh'}, 'demo-denied-request');
    assert.equal(denied.error.code, 'POLICY_DENIED');
    assert.deepEqual((await request<{runs:Run[]}>('/v1/runs')).runs, []);
    emit('policy.rejected', {code:denied.error.code, createdRuns:0});
    const input = {projectId, kind:'registry.refresh'};
    const accepted = await request<{run:Run; replayed:boolean}>('/v1/runs', 202, input, 'demo-accepted-request');
    const duplicate = await request<typeof accepted>('/v1/runs', 202, input, 'demo-accepted-request');
    assert.equal(accepted.replayed, false); assert.equal(duplicate.replayed, true);
    assert.equal(accepted.run.id, duplicate.run.id);
    emit('run.persisted', {runId:accepted.run.id, status:accepted.run.status, duplicateSuppressed:duplicate.replayed});
    const route = '/v1/runs/' + accepted.run.id;
    const initial = await request<{events:RunEvent[]; lastSequence:number}>(route + '/events');
    assert.equal(initial.events.length, 1);
    await request(route + '/cancel', 200, {}, 'demo-cancel-request');
    await request(route + '/cancel', 200, {}, 'demo-cancel-request');
    const before = await request<{events:RunEvent[]; lastSequence:number}>(route + '/events');
    const auditBefore = await request<{valid:boolean; checked:number; headHash:string}>('/v1/audit/verify');
    await server.stop(); server = undefined;
    const restartStarted = performance.now();
    server = await start(directory, token);
    const restartReadyMs = Math.round(performance.now() - restartStarted);
    assert.notEqual(server.pid, firstPid);
    assert.deepEqual(server.migrations, []);
    assert.equal(server.outboxCount, 2); assert.equal(server.deliveredOutbox, 0);
    const after = await request<typeof before>(route + '/events');
    assert.deepEqual(after, before);
    const tail = await request<typeof before>(route + '/events?after=' + initial.lastSequence);
    assert.deepEqual(tail.events.map(event => event.sequence), [2]);
    const replayed = await request<typeof accepted>('/v1/runs', 202, input, 'demo-accepted-request');
    assert.equal(replayed.replayed, true); assert.equal(replayed.run.id, accepted.run.id);
    const restored = await request<{run:Run}>(route);
    assert.equal(restored.run.status, 'cancellation_requested');
    assert.equal((await request<{runs:Run[]}>('/v1/runs')).runs.length, 1);
    const audit = await request<typeof auditBefore>('/v1/audit/verify');
    assert.deepEqual(audit, auditBefore); assert.equal(audit.valid, true); assert.equal(audit.checked, 3);
    const response = await fetch(new URL('/v1/audit/export', server.address), {headers:{Authorization:'Bearer '+token}, signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status, 200);
    const jsonl = await response.text();
    assert(!jsonl.includes(token));
    const entries = jsonl.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => entry.body.reason), ['no_matching_rule','explicit_allow','user_requested_cancellation']);
    await writeFile(path.join(directory, 'audit.jsonl'), jsonl);
    await writeFile(path.join(directory, 'events.json'), JSON.stringify(after,null,2)+'\n');
    for (const entry of entries) emit('audit.entry', entry);
    emit('replay.verified', {firstPid, restoredPid:server.pid, events:after.events.length, cursor:initial.lastSequence, replayedSequences:tail.events.map(event => event.sequence), stableEventIds:true, restartReadyMs});
    const outboxCount = server.outboxCount;
    await server.stop(); server = undefined;
    const result = {at:new Date().toISOString(),mode:'local-development',result:'passed',projectCount:1,runCount:1,outboxCount,eventCount:after.events.length,auditEntries:audit.checked,auditValid:audit.valid,policyDenied:true,idempotencyAcrossRestart:true,restoredStatus:restored.run.status,providerRequests:0,modelInference:'not performed',restartMode:'graceful process exit and disk reopen',restartReadyMs,totalMs:Math.round(performance.now()-started),node:process.version,platform:process.platform,arch:process.arch,directory};
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(result,null,2)+'\n');
    emit('demo.completed', result);
    await writeFile(path.join(directory, 'transcript.jsonl'), records.map(record => JSON.stringify(record)).join('\n')+'\n');
    return result;
  } finally {await server?.stop();}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDemo().catch(error => {console.error(JSON.stringify({event:'demo.failed', message:error instanceof Error ? error.message : 'Unknown demo failure'})); process.exitCode=1;});
}
