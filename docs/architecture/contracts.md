# API và event contracts — v1

`/v1` REST JSON, server validation, structured errors `{error:{code,message,requestId?}}`. Server không trả credential, connection string hoặc raw exception. Idempotency-Key bắt buộc cho mutation, bounded printable key, scope actor/tenant/operation + payload SHA256; cùng key khác payload → 409. Tenant/actor từ server identity.

Batch 01: `GET /health/live`, `/health/ready`; `GET /v1/capabilities`; `GET /v1/projects`; `GET /v1/runs`; `POST /v1/runs` body `{projectId,kind:"registry.refresh"}` → 202 persisted run; `GET /v1/runs/:id`; `GET /v1/runs/:id/events?after=0&limit=100`; `GET /v1/runs/:id/snapshot`; `POST /v1/runs/:id/cancel`; `GET /v1/models`; `GET /v1/audit/verify`; `GET /v1/audit/export` JSONL. WebSocket `/v1/runs/:id/stream?after=sequence` with messages event/batch, client `{type:"ack",sequence}` and bounded backlog; contract schema generated from implemented route schemas.

Run: UUID, tenantId, projectId, kind, status (queued/running/cancellation_requested/completed/failed/cancelled), createdAt, updatedAt, errorCode nullable. No arbitrary prompts or scripts in initial workflow.

Event: `{id,runId,sequence,schemaVersion:1,type,at,payload}`. Sequence strictly increases within run; gaps/reorder require replay; duplicate ignored by ID/sequence, incompatible schema fails visibly. Created event/run/audit/outbox persist atomically. Snapshot includes run, lastSequence, current projection; does not silently discard audit history.

Model: provider, modelId, displayName, source, observedAt; capabilities/pricing unknown unless source supplied; pricing includes currency + source + observedAt; health is unknown until measured. Never convert unknown cost to zero. Provider status: available/unconfigured/unreachable/error; inference support separate from discovery support.

Desktop bridge: explicit repository dialog/list/read/write/search/gitStatus/gitDiff plus control-plane status/projects/runs/create/events/cancel/models/audit methods. Main validates every IPC sender + payload. Renderer never controls raw URL, arbitrary shell or secret APIs. File save includes expected content hash + request key; conflict returns error and keeps editor dirty. API bearer credentials remain main-only.

Future contracts task/step/attempt/tool/effect/approval/worker/quota/OAuth versioned independently and added with migration. General agent run submission is unavailable until actual runtime exists.
