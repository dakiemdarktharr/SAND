# Acceptance tests — planned before code

All results start **NOT RUN**; executable reports supersede this plan without changing the scope of a test. No credential → explicit skip, never fake pass.

| ID | Trigger | Expected observable result | Level |
|---|---|---|---|
| FS-01 | native select test repo; open file; edit; save; restart | exact bytes persisted, original hash conflicts preserved, dirty state correct | desktop E2E + real filesystem |
| FS-02 | ../, absolute/UNC, ADS, symlink/junction, .git, secret paths | rejected before sensitive read/write; UI actionable error | adversarial integration |
| FS-03 | concurrent save / retry same operation key | stale revision rejected; repeated effect deduplicated; no silent loss | filesystem integration |
| IPC-01 | forged sender frame or navigation; unknown method/payload | deny before broker operation, no generic invoke API | unit + desktop E2E |
| UI-01 | backend off, no provider, editor busy/error | unavailable with remediation; no invented metrics/models/run | desktop E2E |
| DB-01 | create same run key concurrently; key different payload | one run/event/outbox + stable response; mismatch 409 | PostgreSQL integration |
| DB-02 | failure before commit / after commit before dispatch | rollback all or retain accepted run/outbox | integration + crash |
| TEN-01 | query/mutate another tenant with valid ID | empty/404/deny; no event or snapshot leak | RLS integration with non-owner runtime role |
| WS-01 | disconnect, reconnect cursor, duplicate/reordered messages | no missing persisted sequence; idempotent client projection; gap refill | reducer + live WebSocket integration |
| WS-02 | stalled consumer, future cursor, expired auth | bounded buffers/snapshot instruction/error and close; reauth | live gateway integration |
| AUD-01 | alter/delete/reorder ledger row | immutable SQL trigger or verification failure | database integration |
| AUD-02 | secret-shaped error/request | only approved metadata/hash persists; no secret plaintext | adversarial regression |
| WF-01 | kill dispatcher after Temporal start before outbox ACK | one deterministic workflow; receipt reconciled | real Temporal integration |
| WF-02 | kill/restart worker during activity | same run resumes, stable event/effect key | Temporal crash recovery |
| CAN-01 | cancel queued/running run; repeat request | durable cancel intent; no new work; terminal ack only after stopped | integration + Temporal E2E |
| PRO-01 | configured real provider model discovery | real API source/observedAt; unknown capabilities/prices stay unknown | credential-gated contract |
| PRO-02 | no configuration, 429/503, malformed response | unavailable/mapped errors, Retry-After, no seeded fallback | unit transport fixture only |
| POL-01 | no match / deny+allow / changed arguments after approval | deny default; deny wins; stale approval invalid | unit/adversarial |
| PKG-01 | build desktop, launch, test isolated renderer | real packaged app opens; sandbox/Node/CSP assertions | Windows E2E |
| REL-01 | forged update, unsigned installer | rejected release/update; macOS and Windows signing verified | release staging (not batch 01) |

SLO/load/chaos/backup/cross-platform/agent isolation/failover benchmark tests are mandatory later release gates, not covered by unit test counts. Native filesystem race resistance against a concurrent hostile local process needs OS-specific validation; path string validation alone is insufficient.
