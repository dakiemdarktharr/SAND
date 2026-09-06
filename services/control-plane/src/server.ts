import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { metrics, trace } from '@opentelemetry/api';
import { DomainError, type Principal } from './types.js';
import type { Store } from './store.js';

export interface ServerOptions {
  store: Store; principal: Principal; token: string; logger?: boolean;
  stream?: { pollMs?: number; maxBacklog?: number; maxInFlight?: number; ackTimeoutMs?: number; heartbeatMs?: number; maxBufferBytes?: number };
}
const uuidSchema = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: uuidSchema } } as const;
const idempotencyHeaders = { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', pattern: '^[!-~]{8,128}$' } } } as const;
const meter = metrics.getMeter('sand.control-plane', '0.1.0');
const replayed = meter.createCounter('sand.websocket.events.sent');
const reconnects = meter.createCounter('sand.websocket.connections');
const denied = meter.createCounter('sand.api.authentication.denied');

export async function buildServer(options: ServerOptions) {
  if (options.token.length < 32) throw new Error('SAND_API_TOKEN must contain at least 32 characters.');
  const app = Fastify({ logger: options.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], serializers: { err: () => ({ type: 'RedactedError', message: 'Internal error', stack: '', code: 'INTERNAL_ERROR' }), req: req => ({ method: req.method, route: req.routeOptions?.url }), res: res => ({ statusCode: res.statusCode }) } } : false, bodyLimit: 16_384, logController: new LogController({ disableRequestLogging: true }) });
  await app.register(swagger, { openapi: { info: { title: 'SAND control plane', version: '1.0.0', description: 'Local development preview. Production startup is disabled until OIDC is implemented.' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }] } });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute', errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Retry after the rate-limit window.' } }) });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (request.url === '/health/live' || request.url === '/health/ready') return;
    const supplied = request.headers.authorization;
    const expected = `Bearer ${options.token}`;
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) || request.headers.origin) {
      denied.add(1);
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Configure the local development API token in the desktop main process.', requestId: request.id } });
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    // Log route names and status only. URLs, payloads, headers and raw exceptions are excluded.
    request.log.info({ requestId: request.id, route: request.routeOptions.url, statusCode: reply.statusCode, elapsedMs: reply.elapsedTime }, 'request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    const domain = error instanceof DomainError;
    const validation = Boolean((error as { validation?: unknown }).validation);
    const status = domain ? error.statusCode : validation ? 400 : 503;
    const code = domain ? error.code : validation ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE';
    request.log.warn({ requestId: request.id, code }, 'request failed');
    void reply.status(status).send({ error: { code, message: domain ? error.message : validation ? 'The request does not match the API schema.' : 'The service could not complete this operation. Check control-plane and database availability.', requestId: request.id } });
  });
  app.get('/health/live', { schema: { security: [], summary: 'Process liveness' } }, async () => ({ status: 'alive' }));
  app.get('/health/ready', { schema: { security: [], summary: 'Database, role and tenant readiness' } }, async (_req, reply) => {
    try {
      if (await options.store.readiness(options.principal)) return { status: 'ready' };
    } catch { /* Metadata-only unavailable response; no connection strings. */ }
    return reply.status(503).send({ status: 'unavailable', reason: 'Database role, schema or tenant bootstrap is not ready.' });
  });
  app.get('/v1/openapi.json', { schema: { summary: 'Generated API contract' } }, async () => app.swagger());
  app.get('/v1/capabilities', { schema: { summary: 'Implemented capability availability' } }, async () => ({ mode: 'local-development', capabilities: [
    { id: 'durable-run-admission', status: 'available' }, { id: 'event-replay', status: 'available' },
    { id: 'audit-verification', status: 'available' }, { id: 'registry-discovery', status: 'available', reason: 'Requires the Temporal dispatcher, worker and provider configuration. Discovery is separate from inference.' },
    ...['agent-execution', 'cloud-workers', 'oidc', 'github-app', 'mcp', 'cost-routing', 'production-release'].map(id => ({ id, status: 'unavailable', reason: 'Not implemented in this development slice.' })),
  ] }));
  app.get('/v1/projects', { schema: { summary: 'List tenant projects' } }, async () => ({ projects: await options.store.listProjects(options.principal) }));
  app.get('/v1/runs', { schema: { summary: 'List latest 100 tenant runs' } }, async () => ({ runs: await options.store.listRuns(options.principal) }));
  app.post<{ Body: { projectId: string; kind: 'registry.refresh' } }>('/v1/runs', { schema: { summary: 'Durably accept a registry refresh', headers: idempotencyHeaders, body: { type: 'object', required: ['projectId', 'kind'], additionalProperties: false, properties: { projectId: uuidSchema, kind: { const: 'registry.refresh' } } } } }, async (request, reply) => {
    const result = await options.store.createRun(options.principal, request.body, String(request.headers['idempotency-key']));
    return reply.status(202).send(result);
  });
  app.get<{ Params: { id: string } }>('/v1/runs/:id', { schema: { params: idParams, summary: 'Get run state' } }, async request => {
    const run = await options.store.getRun(options.principal, request.params.id);
    if (!run) throw new DomainError('RUN_NOT_FOUND', 404, 'Run not found.');
    return { run };
  });
  const cursorQuery = { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } };
  app.get<{ Params: { id: string }; Querystring: { after?: number; limit?: number } }>('/v1/runs/:id/events', { schema: { summary: 'Persisted replay and polling fallback', params: idParams, querystring: cursorQuery } }, async request => options.store.events(options.principal, request.params.id, request.query.after, request.query.limit));
  app.get<{ Params: { id: string } }>('/v1/runs/:id/snapshot', { schema: { summary: 'Current projection with replay cursor', params: idParams } }, async request => options.store.snapshot(options.principal, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/runs/:id/cancel', { schema: { summary: 'Record durable cancellation intent', params: idParams, headers: idempotencyHeaders } }, async request => ({ run: await options.store.requestCancellation(options.principal, request.params.id, String(request.headers['idempotency-key'])) }));
  app.get('/v1/models', { schema: { summary: 'Latest real provider discovery snapshot' } }, async () => options.store.listModels(options.principal));
  app.get('/v1/audit/verify', { schema: { summary: 'Verify tenant audit chain against stored head' } }, async () => options.store.verifyAudit(options.principal));
  app.get<{ Querystring: { after?: number; limit?: number } }>('/v1/audit/export', { schema: { summary: 'Paginated audit JSONL; continue using X-SAND-Next-Cursor', querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 } } } } }, async (request, reply) => {
    const page = await options.store.auditExport(options.principal, request.query.after, request.query.limit);
    reply.header('X-SAND-Has-More', String(page.nextCursor !== null));
    if (page.nextCursor !== null) reply.header('X-SAND-Next-Cursor', String(page.nextCursor));
    return reply.header('Content-Type', 'application/x-ndjson').send(page.entries.map(row => JSON.stringify(row)).join('\n') + (page.entries.length ? '\n' : ''));
  });

  app.get<{ Params: { id: string }; Querystring: { after?: number } }>('/v1/runs/:id/stream', { websocket: true, schema: { summary: 'Authenticated at-least-once persisted event replay', params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 } } } } }, (socket, request) => {
    const config = { pollMs: 250, maxBacklog: 1000, maxInFlight: 64, ackTimeoutMs: 15_000, heartbeatMs: 10_000, maxBufferBytes: 512_000, ...options.stream };
    let sent = request.query.after ?? 0;
    let acknowledged = sent;
    let lastAck = Date.now();
    let pong = true;
    let polling = false;
    let closed = false;
    reconnects.add(1);
    const close = (code: number, reason: string) => { if (!closed) socket.close(code, reason); };
    socket.on('message', bytes => {
      try {
        const msg: unknown = JSON.parse(bytes.toString());
        if (!msg || typeof msg !== 'object' || !('type' in msg) || msg.type !== 'ack' || !('sequence' in msg) || typeof msg.sequence !== 'number' || !Number.isSafeInteger(msg.sequence) || msg.sequence < acknowledged || msg.sequence > sent) return close(1008, 'invalid acknowledgement');
        if (msg.sequence > acknowledged) { acknowledged = msg.sequence; lastAck = Date.now(); }
      } catch { close(1008, 'invalid message'); }
    });
    socket.on('pong', () => { pong = true; });
    socket.on('error', () => { close(1011, 'transport failure'); });
    const poll = async () => {
      if (closed || polling || socket.readyState !== 1) return;
      if (socket.bufferedAmount > config.maxBufferBytes || (sent > acknowledged && Date.now() - lastAck > config.ackTimeoutMs)) return close(1013, 'slow consumer; reconnect from acknowledged cursor');
      if (sent - acknowledged >= config.maxInFlight) return;
      polling = true;
      try {
        const page = await options.store.events(options.principal, request.params.id, sent, config.maxInFlight - (sent - acknowledged));
        if (closed || socket.readyState !== 1) return;
        if (page.lastSequence - acknowledged > config.maxBacklog) {
          socket.send(JSON.stringify({ type: 'snapshot_required', snapshot: `/v1/runs/${request.params.id}/snapshot`, lastSequence: page.lastSequence }));
          return close(4009, 'snapshot required');
        }
        if (page.events.length) {
          const wasCaughtUp = sent === acknowledged;
          sent = page.events.at(-1)!.sequence;
          if (wasCaughtUp) lastAck = Date.now();
          socket.send(JSON.stringify({ type: 'batch', ...page }));
          replayed.add(page.events.length);
        }
      } catch (error) { close(error instanceof DomainError && error.statusCode === 404 ? 4004 : 1011, 'stream unavailable; use REST replay'); }
      finally { polling = false; }
    };
    const timer = setInterval(() => { void poll(); }, config.pollMs);
    const heartbeat = setInterval(() => { if (!pong) { socket.terminate(); return; } pong = false; if (socket.readyState === 1) socket.ping(); }, config.heartbeatMs);
    const expiry = setTimeout(() => close(4001, 'reconnect to reauthorize'), 15 * 60_000);
    socket.on('close', () => { closed = true; clearInterval(timer); clearInterval(heartbeat); clearTimeout(expiry); });
    void trace.getTracer('sand.websocket').startActiveSpan('stream.connect', span => { span.setAttribute('sand.cursor', acknowledged); span.end(); });
    void poll();
  });
  return app;
}
