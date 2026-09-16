import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { StudioError } from '../../studio/src/schema.js';
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface Approval {
  id: string;
  runId: string;
  nodeId: string;
  tool: string;
  arguments: Record<string, unknown>;
  argumentHash: string;
  manifestHash: string;
  state: string;
  createdAt: string;
  reason: string;
}
export class ToolJournal {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) throw new StudioError('SCHEMA_TOO_NEW', 'Tool database quá mới.');
    if (!version)
      this.db.exec(
        `BEGIN IMMEDIATE;CREATE TABLE calls(id TEXT PRIMARY KEY,run_id TEXT,node_id TEXT,tool TEXT,args TEXT,arg_hash TEXT,manifest_hash TEXT,state TEXT,created_at TEXT,result TEXT,reason TEXT);CREATE TABLE sessions(id TEXT PRIMARY KEY,body TEXT);CREATE INDEX calls_run ON calls(run_id);PRAGMA user_version=1;COMMIT;`,
      );
    this.db
      .prepare(
        "UPDATE calls SET state='unknown',reason='process_interrupted_after_intent' WHERE state='executing'",
      )
      .run();
  }
  load<T>(id: string): T | null {
    const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.body)) as T) : null;
  }
  save(id: string, body: unknown) {
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(id, JSON.stringify(body));
  }
  request(
    id: string,
    runId: string,
    nodeId: string,
    tool: string,
    args: Record<string, unknown>,
    manifestHash: string,
  ) {
    const existing = this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);
    const argumentHash = digest(args);
    if (existing) {
      if (existing.arg_hash !== argumentHash || existing.manifest_hash !== manifestHash)
        throw new StudioError(
          'TOOL_BINDING_CHANGED',
          'Tool/schema/resource đã thay đổi; approval cũ không còn hợp lệ.',
        );
      return;
    }
    const count = Number(
      this.db.prepare('SELECT count(*) n FROM calls WHERE run_id=?').get(runId)!.n,
    );
    if (count >= 24) throw new StudioError('TOOL_QUOTA', 'Tối đa 24 tool calls mỗi run.');
    this.db
      .prepare('INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        runId,
        nodeId,
        tool,
        JSON.stringify(args),
        argumentHash,
        manifestHash,
        'pending',
        new Date().toISOString(),
        null,
        'one_time_argument_bound_consent',
      );
  }
  list(runId: string): Approval[] {
    return this.db
      .prepare('SELECT * FROM calls WHERE run_id=? ORDER BY rowid')
      .all(runId)
      .map((r) => ({
        id: String(r.id),
        runId: String(r.run_id),
        nodeId: String(r.node_id),
        tool: String(r.tool),
        arguments: JSON.parse(String(r.args)),
        argumentHash: String(r.arg_hash),
        manifestHash: String(r.manifest_hash),
        state: String(r.state),
        createdAt: String(r.created_at),
        reason: String(r.reason),
      }));
  }
  decide(id: string, approve: boolean) {
    const row = this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);
    if (!row) throw new StudioError('APPROVAL_NOT_FOUND', 'Không tìm thấy approval.');
    const target = approve ? 'approved' : 'denied';
    if (row.state === target) return;
    if (row.state !== 'pending')
      throw new StudioError('APPROVAL_NOT_PENDING', 'Approval không còn pending.');
    this.db
      .prepare('UPDATE calls SET state=?,reason=? WHERE id=?')
      .run(target, 'explicit_local_user_decision', id);
  }
  state(id: string) {
    return String(
      this.db.prepare('SELECT state FROM calls WHERE id=?').get(id)?.state ?? 'missing',
    );
  }
  result(id: string): string {
    return String(this.db.prepare('SELECT result FROM calls WHERE id=?').get(id)?.result ?? '');
  }
  begin(id: string) {
    if (
      this.db.prepare("UPDATE calls SET state='executing' WHERE id=? AND state='approved'").run(id)
        .changes !== 1
    )
      throw new StudioError('APPROVAL_REQUIRED', 'Cần duyệt từng lần gọi.');
  }
  finish(id: string, result: string) {
    this.db
      .prepare(
        "UPDATE calls SET state='completed',result=?,reason='result_persisted' WHERE id=? AND state='executing'",
      )
      .run(result, id);
  }
  fail(id: string) {
    this.db
      .prepare(
        "UPDATE calls SET state='unknown',reason='call_outcome_requires_reconciliation' WHERE id=? AND state='executing'",
      )
      .run(id);
  }
  backup(file: string) {
    if (this.db.prepare("SELECT id FROM calls WHERE state='executing' LIMIT 1").get())
      throw new StudioError('BACKUP_BUSY', 'Tool đang thực thi.');
    this.db.prepare('VACUUM INTO ?').run(file);
  }
  close() {
    this.db.close();
  }
}
export const operationUuid = (id: string) => {
  const hex = digest(id);
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-4' +
    hex.slice(13, 16) +
    '-a' +
    hex.slice(17, 20) +
    '-' +
    hex.slice(20, 32)
  );
};
export const newOperation = () => randomUUID();
