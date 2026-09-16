import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { ToolPolicyEngine, type PolicySet } from '../../policy/src/index.js';
import { ProviderError } from '../../providers/src/types.js';
import type { AgentRunner } from './inference.js';
import {
  definitionSchema,
  validateForRun,
  StudioError,
  type Definition,
  type StudioRun,
  type NodeExecution,
  type StudioEvent,
  type StudioNode,
  type StudioStatus,
} from './schema.js';

const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const policyVersion = 'studio-local-v1';
const now = () => new Date().toISOString();
// Do not send recognizable credential material to any model, or retain it in outputs.
export function secretLike(text: string) {
  return /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})|(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*["']?[a-zA-Z0-9_+/-]{16,})/i.test(
    text,
  );
}
export class StudioRuntime {
  private db: DatabaseSync;
  private active = new Map<string, Map<string, AbortController>>();
  private closed = false;
  constructor(
    file: string,
    private runner: AgentRunner,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1)
      throw new StudioError('SCHEMA_TOO_NEW', 'Database được tạo bởi phiên bản SAND mới hơn.');
    if (version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE definitions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE runs(id TEXT PRIMARY KEY,operation_key TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,definition TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,allow_cloud INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE steps(run_id TEXT REFERENCES runs(id),node_id TEXT,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,output TEXT,result TEXT,error TEXT,PRIMARY KEY(run_id,node_id));
      CREATE TABLE events(run_id TEXT REFERENCES runs(id),sequence INTEGER NOT NULL,body TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      PRAGMA user_version=1;
      COMMIT;
    `);
    for (const row of this.db
      .prepare("SELECT id FROM runs WHERE status IN ('running','paused','waiting')")
      .all()) {
      const id = String(row.id);
      this.tx(() => {
        const interrupted = this.db
          .prepare(
            "UPDATE steps SET state='interrupted',error='PROCESS_INTERRUPTED' WHERE run_id=? AND state='running'",
          )
          .run(id).changes;
        if (interrupted || this.status(id) === 'running') {
          this.setStatus(id, 'interrupted');
          this.event(id, 'run.interrupted', null, {
            reason: 'desktop_reopened',
            providerOutcome: 'unknown for interrupted calls',
            requiresUserResume: true,
          });
        }
      });
    }
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private event(
    runId: string,
    type: string,
    nodeId: string | null,
    details: Record<string, unknown> = {},
  ) {
    const last = this.db
      .prepare('SELECT sequence,hash FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 1')
      .get(runId);
    const sequence = Number(last?.sequence ?? 0) + 1,
      previousHash = String(last?.hash ?? '');
    const body = JSON.stringify({
      sequence,
      at: now(),
      type,
      nodeId,
      details: { ...details, policyVersion, actor: 'local-user' },
    });
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(runId, sequence, body, previousHash, hash(previousHash + '\n' + body));
  }
  private status(id: string): StudioStatus {
    const row = this.db.prepare('SELECT status FROM runs WHERE id=?').get(id);
    if (!row) throw new StudioError('RUN_NOT_FOUND', 'Không tìm thấy lần chạy.');
    return String(row.status) as StudioStatus;
  }
  private setStatus(id: string, status: StudioStatus) {
    this.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run(status, now(), id);
  }
  definitions(): Definition[] {
    return this.db
      .prepare('SELECT body FROM definitions ORDER BY updated_at DESC LIMIT 100')
      .all()
      .map((row) => JSON.parse(String(row.body)) as Definition);
  }
  save(raw: unknown): Definition {
    const definition = definitionSchema.parse(raw);
    if (secretLike(JSON.stringify(definition)))
      throw new StudioError('SECRET_DETECTED', 'Không đặt credential trong chỉ dẫn workflow.');
    return this.tx(() => {
      const current = this.db
        .prepare('SELECT revision FROM definitions WHERE id=?')
        .get(definition.id);
      if (Number(current?.revision ?? 0) !== definition.revision)
        throw new StudioError('REVISION_CONFLICT', 'Workflow đã thay đổi. Tải lại trước khi lưu.');
      const next = { ...definition, revision: definition.revision + 1 };
      this.db
        .prepare(
          'INSERT INTO definitions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at',
        )
        .run(next.id, next.revision, JSON.stringify(next), now());
      return next;
    });
  }
  list() {
    return this.db
      .prepare('SELECT id,definition,status,created_at FROM runs ORDER BY created_at DESC LIMIT 50')
      .all()
      .map((row) => ({
        id: String(row.id),
        name: (JSON.parse(String(row.definition)) as Definition).name,
        status: String(row.status),
        createdAt: String(row.created_at),
      }));
  }
  get(id: string): StudioRun {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new StudioError('RUN_NOT_FOUND', 'Không tìm thấy lần chạy.');
    const nodes = this.db
      .prepare('SELECT * FROM steps WHERE run_id=? ORDER BY rowid')
      .all(id)
      .map((step) => ({
        id: String(step.node_id),
        state: String(step.state),
        output: step.output === null ? null : String(step.output),
        error: step.error === null ? null : String(step.error),
        attempt: Number(step.attempt),
        result: step.result === null ? null : JSON.parse(String(step.result)),
      })) as NodeExecution[];
    const events = this.db
      .prepare('SELECT * FROM events WHERE run_id=? ORDER BY sequence')
      .all(id)
      .map((event) => ({
        ...JSON.parse(String(event.body)),
        previousHash: String(event.previous_hash),
        hash: String(event.hash),
      })) as StudioEvent[];
    return {
      id,
      definition: JSON.parse(String(row.definition)) as Definition,
      input: String(row.input),
      status: String(row.status) as StudioStatus,
      allowCloud: Boolean(row.allow_cloud),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      nodes,
      events,
    };
  }
  verify(id: string) {
    let previous = '',
      sequence = 0;
    this.status(id);
    for (const row of this.db
      .prepare('SELECT * FROM events WHERE run_id=? ORDER BY sequence')
      .all(id)) {
      sequence++;
      if (
        row.previous_hash !== previous ||
        Number(row.sequence) !== sequence ||
        row.hash !== hash(previous + '\n' + String(row.body))
      )
        return { valid: false, checked: sequence };
      previous = String(row.hash);
    }
    return { valid: true, checked: sequence, headHash: previous };
  }
  private admit(excluding?: string) {
    const executing = new Set(
      this.db
        .prepare("SELECT id FROM runs WHERE status='running'")
        .all()
        .map((row) => String(row.id)),
    );
    for (const [id, calls] of this.active) if (calls.size) executing.add(id);
    if (excluding) executing.delete(excluding);
    if (executing.size >= 3)
      throw new StudioError(
        'CONCURRENCY_LIMIT',
        'Tối đa 3 workflow hoạt động. Đợi các request đang chạy/hủy kết thúc.',
      );
  }
  start(raw: unknown, input: string, allowCloud: boolean, key: string) {
    const definition = definitionSchema.parse(raw);
    validateForRun(definition);
    if (!input.trim() || input.length > 16000)
      throw new StudioError('INPUT_LIMIT', 'Nhập dữ liệu từ 1 đến 16.000 ký tự.');
    if (secretLike(input) || secretLike(JSON.stringify(definition)))
      throw new StudioError(
        'SECRET_DETECTED',
        'Phát hiện chuỗi có dạng credential. Xóa secret khỏi đầu vào/chỉ dẫn.',
      );
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key))
      throw new StudioError('IDEMPOTENCY_REQUIRED', 'Cần operation ID hợp lệ.');
    const fingerprint = hash({ definition, input, allowCloud });
    const prior = this.db.prepare('SELECT id,fingerprint FROM runs WHERE operation_key=?').get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new StudioError(
          'IDEMPOTENCY_CONFLICT',
          'Operation ID đã được dùng với dữ liệu khác.',
        );
      return this.get(String(prior.id));
    }
    this.admit();
    const id = randomUUID();
    this.tx(() => {
      this.db
        .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          key,
          fingerprint,
          JSON.stringify(definition),
          input,
          'running',
          allowCloud ? 1 : 0,
          now(),
          now(),
        );
      for (const node of definition.nodes)
        this.db
          .prepare("INSERT INTO steps(run_id,node_id,state) VALUES(?,?,'pending')")
          .run(id, node.id);
      this.event(id, 'run.accepted', null, {
        definitionHash: hash(definition),
        inputHash: hash(input),
        cloudConsent: allowCloud,
        revision: definition.revision,
      });
    });
    this.pump(id);
    return this.get(id);
  }
  private evaluate(run: StudioRun, node: StudioNode) {
    const cloud = node.provider !== 'ollama';
    const policy: PolicySet = {
      tenantId: 'desktop-local',
      organizationId: 'desktop-local',
      version: policyVersion,
      rules: [
        {
          id: cloud ? 'cloud-consent' : 'local-inference',
          effect: cloud && !run.allowCloud ? 'deny' : 'allow',
          match: { tool: 'model', operation: 'text', projectId: run.definition.id },
        },
      ],
    };
    return new ToolPolicyEngine().evaluate({
      policy,
      now: Date.now(),
      action: {
        actionId: run.id + '/' + node.id,
        actorId: 'local-user',
        userId: 'local-user',
        tenantId: 'desktop-local',
        organizationId: 'desktop-local',
        projectId: run.definition.id,
        sessionId: 'desktop',
        runId: run.id,
        tool: 'model',
        operation: 'text',
        arguments: { provider: node.provider, model: node.model, inputHash: hash(run.input) },
        target: { kind: 'model', id: node.model, revision: null },
        networkDestination: cloud
          ? {
              openai: 'api.openai.com',
              openrouter: 'openrouter.ai',
              anthropic: 'api.anthropic.com',
              gemini: 'generativelanguage.googleapis.com',
            }[node.provider as 'openai' | 'openrouter' | 'anthropic' | 'gemini']
          : null,
        dataSensitivity: 'internal',
        estimatedCost: null,
        environment: 'development',
        policyVersion,
      },
    });
  }
  private pump(id: string) {
    if (this.closed || this.status(id) !== 'running') return;
    const run = this.get(id),
      states = new Map(run.nodes.map((n) => [n.id, n]));
    let inFlight = this.active.get(id);
    if (!inFlight) {
      inFlight = new Map();
      this.active.set(id, inFlight);
    }
    for (const node of run.definition.nodes) {
      if (this.status(id) !== 'running' || inFlight.size >= run.definition.concurrency) break;
      const step = states.get(node.id)!;
      if (
        step.state !== 'pending' ||
        !node.dependsOn.every((dep) => states.get(dep)?.state === 'completed')
      )
        continue;
      const dependencyText = node.dependsOn.map((dep) => ({
        step: run.definition.nodes.find((n) => n.id === dep)!.name,
        output: states.get(dep)!.output,
      }));
      if (node.kind === 'review') {
        this.tx(() => {
          this.db
            .prepare("UPDATE steps SET state='waiting',output=? WHERE run_id=? AND node_id=?")
            .run(dependencyText.map((d) => d.output ?? '').join('\n\n'), id, node.id);
          this.event(id, 'review.requested', node.id, {
            reason: 'human_review_node',
            inputHash: hash(dependencyText),
          });
        });
        states.get(node.id)!.state = 'waiting';
        continue;
      }
      if (node.kind === 'output') {
        this.tx(() => {
          this.db
            .prepare("UPDATE steps SET state='completed',output=? WHERE run_id=? AND node_id=?")
            .run(dependencyText.map((d) => d.output ?? '').join('\n\n'), id, node.id);
          this.event(id, 'artifact.ready', node.id, { outputHash: hash(dependencyText) });
        });
        states.get(node.id)!.state = 'completed';
        states.get(node.id)!.output = dependencyText.map((d) => d.output ?? '').join('\n\n');
        continue;
      }
      const decision = this.evaluate(run, node);
      const context = JSON.stringify({
        sourceDocument: run.input,
        upstreamOutputs: dependencyText,
      });
      if (decision.decision !== 'allow' || context.length + node.instructions.length > 30000) {
        this.tx(() => {
          this.db
            .prepare("UPDATE steps SET state='failed',error=? WHERE run_id=? AND node_id=?")
            .run(
              decision.decision !== 'allow' ? 'CLOUD_CONSENT_REQUIRED' : 'CONTEXT_LIMIT',
              id,
              node.id,
            );
          this.setStatus(id, 'failed');
          this.event(id, 'policy.denied', node.id, {
            decision: decision.decision,
            reason: decision.decision !== 'allow' ? decision.reason : 'context_limit',
          });
        });
        for (const c of inFlight.values()) c.abort();
        break;
      }
      const controller = new AbortController();
      inFlight.set(node.id, controller);
      this.tx(() => {
        this.db
          .prepare(
            "UPDATE steps SET state='running',attempt=attempt+1,error=NULL WHERE run_id=? AND node_id=?",
          )
          .run(id, node.id);
        this.event(id, 'agent.started', node.id, {
          provider: node.provider,
          model: node.model,
          decision: decision.decision,
          reason: decision.reason,
          inputHash: hash(context),
        });
      });
      void this.execute(id, node, context, controller);
    }
    const updated = this.get(id);
    if (updated.status === 'running' && !inFlight.size) {
      const done = updated.nodes.every((n) => n.state === 'completed');
      if (done)
        this.tx(() => {
          this.setStatus(id, 'completed');
          this.event(id, 'run.completed', null, { reason: 'all_nodes_completed' });
        });
      else if (updated.nodes.some((n) => n.state === 'waiting'))
        this.tx(() => {
          this.setStatus(id, 'waiting');
          this.event(id, 'run.waiting', null, { reason: 'human_review_required' });
        });
      else if (updated.nodes.some((n) => n.state === 'pending'))
        queueMicrotask(() => this.pump(id));
    }
  }
  private async execute(
    id: string,
    node: StudioNode,
    context: string,
    controller: AbortController,
  ) {
    try {
      const result = await this.runner.run(node, context, controller.signal, {
        runId: id,
        nodeId: node.id,
        event: (type, details) => {
          if (!this.closed) this.tx(() => this.event(id, type, node.id, details));
        },
      });
      if (this.closed) return;
      if (!['running', 'paused'].includes(this.status(id)) || controller.signal.aborted) return;
      if (secretLike(result.text))
        throw new StudioError('SECRET_IN_OUTPUT', 'Provider trả về nội dung có dạng secret.');
      this.tx(() => {
        this.db
          .prepare(
            "UPDATE steps SET state='completed',output=?,result=? WHERE run_id=? AND node_id=?",
          )
          .run(result.text, JSON.stringify(result), id, node.id);
        this.event(id, 'agent.completed', node.id, {
          provider: result.provider,
          requestedModel: result.requestedModel,
          reportedModel: result.reportedModel,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          costSource: result.costSource,
          observedAt: result.observedAt,
          outputHash: hash(result.text),
          truncated: result.truncated,
        });
      });
    } catch (error) {
      if (
        !this.closed &&
        ['running', 'paused'].includes(this.status(id)) &&
        error instanceof StudioError &&
        error.code === 'AWAITING_TOOL_APPROVAL'
      ) {
        this.tx(() => {
          this.db
            .prepare(
              "UPDATE steps SET state='waiting',error='AWAITING_TOOL_APPROVAL' WHERE run_id=? AND node_id=?",
            )
            .run(id, node.id);
          this.event(id, 'agent.waiting_for_tool', node.id, { reason: 'argument_bound_approval' });
        });
      } else if (!this.closed && ['running', 'paused'].includes(this.status(id))) {
        const code =
          error instanceof ProviderError || error instanceof StudioError
            ? error.code
            : 'INFERENCE_FAILED';
        this.tx(() => {
          this.db
            .prepare("UPDATE steps SET state='failed',error=? WHERE run_id=? AND node_id=?")
            .run(code, id, node.id);
          this.setStatus(id, 'failed');
          this.event(id, 'agent.failed', node.id, {
            code,
            provider: node.provider,
            model: node.model,
          });
        });
        for (const c of this.active.get(id)?.values() ?? []) c.abort();
      }
    } finally {
      this.active.get(id)?.delete(node.id);
      if (!this.closed) this.pump(id);
    }
  }
  command(id: string, action: 'pause' | 'resume' | 'cancel') {
    const status = this.status(id);
    if (action === 'cancel' && status !== 'completed' && status !== 'cancelled') {
      this.tx(() => {
        this.setStatus(id, 'cancelled');
        this.db
          .prepare(
            "UPDATE steps SET state='interrupted',error='USER_CANCELLED' WHERE run_id=? AND state='running'",
          )
          .run(id);
        this.event(id, 'run.cancelled', null, { reason: 'user_requested' });
      });
      for (const c of this.active.get(id)?.values() ?? []) c.abort();
    } else if (action === 'pause' && status === 'running')
      this.tx(() => {
        this.setStatus(id, 'paused');
        this.event(id, 'run.paused', null, {
          reason: 'user_requested',
          inFlight: 'allowed_to_finish',
        });
      });
    else if (action === 'resume' && ['paused', 'interrupted', 'failed'].includes(status)) {
      if (this.active.get(id)?.size)
        throw new StudioError(
          'REQUEST_DRAINING',
          'Đợi các request đang hủy kết thúc rồi tiếp tục.',
        );
      this.admit(id);
      this.tx(() => {
        this.db
          .prepare(
            "UPDATE steps SET state='pending',error=NULL WHERE run_id=? AND state IN ('failed','interrupted','running')",
          )
          .run(id);
        this.setStatus(id, 'running');
        this.event(id, 'run.resumed', null, {
          reason: 'user_confirmed_retry',
          possibleDuplicateProviderBilling: status !== 'paused',
        });
      });
      this.pump(id);
    }
    return this.get(id);
  }
  review(id: string, nodeId: string, approve: boolean) {
    const run = this.get(id),
      step = run.nodes.find((n) => n.id === nodeId),
      node = run.definition.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'review')
      throw new StudioError('REVIEW_NOT_FOUND', 'Không tìm thấy bước duyệt.');
    if (step?.state === 'completed' && approve) return run;
    if (step?.state !== 'waiting' || !['running', 'waiting', 'paused'].includes(run.status))
      throw new StudioError('REVIEW_NOT_PENDING', 'Yêu cầu duyệt không còn hiệu lực.');
    if (approve && run.status === 'waiting') this.admit(id);
    this.tx(() => {
      this.db
        .prepare('UPDATE steps SET state=?,error=? WHERE run_id=? AND node_id=?')
        .run(approve ? 'completed' : 'failed', approve ? null : 'REVIEW_REJECTED', id, nodeId);
      this.event(id, approve ? 'review.approved' : 'review.rejected', nodeId, {
        reason: 'explicit_user_decision',
        inputHash: hash(step.output),
      });
      if (!approve) this.setStatus(id, 'cancelled');
      else if (run.status === 'waiting') this.setStatus(id, 'running');
    });
    if (!approve) for (const c of this.active.get(id)?.values() ?? []) c.abort();
    else this.pump(id);
    return this.get(id);
  }
  continueTool(id: string, nodeId: string, approvalId: string, approve: boolean) {
    const run = this.get(id),
      step = run.nodes.find((n) => n.id === nodeId);
    if (
      !step ||
      step.state !== 'waiting' ||
      step.error !== 'AWAITING_TOOL_APPROVAL' ||
      !['running', 'waiting', 'paused'].includes(run.status)
    )
      throw new StudioError('APPROVAL_NOT_PENDING', 'Run không còn chờ tool này.');
    if (run.status === 'waiting' && approve) this.admit(id);
    this.tx(() => {
      this.event(id, approve ? 'tool.approved' : 'tool.denied', nodeId, {
        approvalId,
        reason: 'explicit_user_decision',
      });
      this.db
        .prepare('UPDATE steps SET state=?,error=? WHERE run_id=? AND node_id=?')
        .run(approve ? 'pending' : 'failed', approve ? null : 'TOOL_DENIED', id, nodeId);
      if (!approve) this.setStatus(id, 'cancelled');
      else if (run.status === 'waiting') this.setStatus(id, 'running');
    });
    if (!approve) for (const c of this.active.get(id)?.values() ?? []) c.abort();
    else this.pump(id);
    return this.get(id);
  }
  artifact(id: string) {
    const run = this.get(id);
    const output = run.definition.nodes
      .filter((n) => n.kind === 'output')
      .map((n) => run.nodes.find((s) => s.id === n.id)!);
    if (run.status !== 'completed' || output.some((n) => n.state !== 'completed'))
      throw new StudioError('ARTIFACT_NOT_READY', 'Báo cáo chưa hoàn tất hoặc chưa được duyệt.');
    const audit = this.verify(id);
    if (!audit.valid)
      throw new StudioError('AUDIT_INVALID', 'Audit không hợp lệ; không xuất báo cáo.');
    return (
      '# ' +
      run.definition.name +
      '\n\n' +
      output.map((n) => n.output).join('\n\n') +
      '\n\n---\n' +
      [
        'Run: ' + run.id,
        'Workflow revision: ' + run.definition.revision,
        'Created: ' + run.createdAt,
        'Policy: ' + policyVersion,
        'Input SHA-256: ' + hash(run.input),
        'Definition SHA-256: ' + hash(run.definition),
        'Audit head: ' + audit.headHash + ' (' + audit.checked + ' events; no external anchor)',
        ...run.events
          .filter((e) => e.type === 'tool.completed')
          .map(
            (e) =>
              '- Tool: ' +
              e.details.tool +
              '; approval: ' +
              e.details.approvalId +
              '; output SHA-256: ' +
              e.details.outputHash +
              (e.details.source
                ? '; source: ' + e.details.source + '; observed: ' + e.details.observedAt
                : ''),
          ),
        ...run.nodes
          .filter((n) => n.result)
          .map((n) => {
            const r = n.result!;
            return (
              '- ' +
              n.id +
              ': ' +
              r.provider +
              ' / ' +
              r.requestedModel +
              '; reported model: ' +
              (r.reportedModel ?? 'unknown') +
              '; input/output tokens: ' +
              (r.inputTokens ?? 'unknown') +
              '/' +
              (r.outputTokens ?? 'unknown') +
              '; duration: ' +
              r.durationMs +
              ' ms; observed: ' +
              r.observedAt +
              '; cost USD: ' +
              (r.costUsd ?? 'unknown') +
              '; cost source: ' +
              (r.costSource ?? 'not provided') +
              (r.truncated ? ' [output limit reached]' : '')
            );
          }),
      ].join('\n') +
      '\n'
    );
  }
  backup(file: string) {
    if (
      [...this.active.values()].some((calls) => calls.size) ||
      this.db.prepare("SELECT id FROM runs WHERE status='running' LIMIT 1").get()
    )
      throw new StudioError('BACKUP_BUSY', 'Đợi model/tool hoàn tất trước khi tạo backup.');
    this.db.prepare('VACUUM INTO ?').run(file);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const tasks of this.active.values()) for (const c of tasks.values()) c.abort();
    this.db.close();
  }
}
