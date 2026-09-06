# Durable registry workflow — batch 01

API admission is persisted in PostgreSQL. The dispatcher claims a tenant-scoped outbox lease, starts the deterministic workflow ID, then acknowledges delivery. If start succeeds and acknowledgement is lost, an AlreadyStarted result is reconciled by workflow type. Cancellation is a separate durable outbox intent.

The Temporal workflow contains no credentials or arbitrary code: begin → discover catalog in activity → persist model snapshots/event → finish. Model payloads are stored in DB, not workflow history. Activity heartbeats allow cooperative cancellation and bounded retry. No provider available yields a failed run, not fake completed output.

The worker process executes trusted infrastructure code only. It is not an isolated agent runtime and cannot run repository scripts. Production startup fails until runtime/identity/mTLS configuration exists. Kubernetes/microVM scheduling, hierarchical cancellation above runs, hard termination, quota reservation, step/attempt entities, operator DLQ/recovery and general side-effect reconciliation remain future work.

Run locally after migrations and API provisioning: set DATABASE_URL to non-owner runtime PostgreSQL connection, SAND_TENANT_ID, SAND_ACTOR_ID, TEMPORAL_ADDRESS=127.0.0.1:7233 and optional provider environment; run npm run worker. Never put secrets in renderer config or command arguments.

Tests using a real Temporal dev server are gated by SAND_TEMPORAL_TESTS=1. They must fail on download/start/network errors once enabled. Normal skipped output is not crash-recovery evidence. A test-only PostgreSQL WASM database, if used, is labeled PGlite and does not prove PostgreSQL TCP/HA deployment.
