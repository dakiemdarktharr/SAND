import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

it('runs the offline CLI end to end: project → policy → persisted run → audit → new-process replay', async () => {
  const {stdout,stderr} = await promisify(execFile)(process.execPath, ['--import','tsx','services/local-demo/main.ts'], {windowsHide:true, timeout:90_000, maxBuffer:1_000_000, env:{...process.env,NODE_ENV:'development'}});
  expect(stderr).toBe('');
  const records = stdout.trim().split('\n').map(line => JSON.parse(line));
  const result = records.find(record => record.event === 'demo.completed');
  expect(result).toMatchObject({result:'passed', projectCount:1,runCount:1,outboxCount:2,eventCount:2,auditEntries:3,auditValid:true,policyDenied:true,idempotencyAcrossRestart:true,restoredStatus:'cancellation_requested',providerRequests:0});
  const replay = records.find(record => record.event === 'replay.verified');
  expect(replay.firstPid).not.toBe(replay.restoredPid);
  expect(replay.replayedSequences).toEqual([2]);
  const ledger = (await readFile(path.join(result.directory,'audit.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(ledger.map(row => row.body.action)).toEqual(['policy.denied','run.accepted','run.cancellation_requested']);
  expect(ledger.map(row => row.body.reason)).toEqual(['no_matching_rule','explicit_allow','user_requested_cancellation']);
  expect(ledger[1].body).toMatchObject({decision:'allow',matchedRuleIds:['demo-project-registry'],policyVersion:'local-demo-v1'});
  expect(ledger.every(row => Number.isFinite(Date.parse(row.body.at)))).toBe(true);
  expect(ledger[1].previousHash).toBe(ledger[0].hash);
  expect(ledger[2].previousHash).toBe(ledger[1].hash);
  expect((await readFile(path.join(result.directory,'summary.json'),'utf8'))).not.toContain('Bearer');
}, 100_000);
