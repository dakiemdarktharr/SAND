# Pre-implementation threat model, batch 01

Created before application code. This is a prospective design, not a validated finding report. The fuller reusable model is docs/security/threat-model.md.

Assets: user repository bytes/history, OS credentials, tenant records, accepted runs, workflow identities, event/audit integrity, provider budget, signed release trust.

Actors: developer controlling their own repo; remote website/MCP/repo author controlling untrusted text; compromised renderer with no intended Node authority; tenant member with no access to other tenants. A host administrator already controlling the process is outside renderer sandbox guarantees.

Boundaries: untrusted text → renderer; renderer → narrow authenticated IPC → main filesystem broker; main → authenticated API; API identity → transaction-local tenant; DB outbox → Temporal; workflow → external provider; future run worker → egress/secrets; build pipeline → signed updater.

| Threat hypothesis | Required enforcement / evidence before exposing capability |
|---|---|
| Malicious repository, prompt injection from issues/source/web/MCP | no repo auto-run; content never confers authority; adversarial policy tests |
| Secret exfiltration | no renderer credential API; deny secret paths; constrained egress; safe audit metadata |
| Dependency confusion / supply-chain | exact pins + lockfile, source review, SBOM, signed artifacts, no repo install hooks on open |
| Malicious MCP server | tool manifest/schema diff, audience-bound OAuth, output untrusted; MCP not enabled in batch 01 |
| OAuth interception / replay | system browser, PKCE S256, state/nonce, exact redirect, expiry/rotation; identity release gate |
| GitHub webhook forgery | constant-time HMAC and delivery idempotency; integration not exposed until tested |
| SSRF | no arbitrary fetch IPC, provider fixed origins, redirects blocked, local model explicit loopback |
| Path traversal / symlink attack | canonical confinement, no .git/secrets, lstat checks, conflict-safe writes; OS race test gate |
| Command injection | no generic exec bridge; git argv allowlist + no external diff/hooks; PTY later requires explicit policy |
| Renderer compromise | sandbox, context isolation, CSP, sender+frame validation, navigation/window deny |
| Worker escape | no untrusted code execution until microVM/container isolation and quota tests |
| Cross-tenant access | authenticated context, FORCE RLS and composite FK, runtime role guard + negative tests |
| Audit tampering | append-only DB triggers, chain verification, external signed/WORM checkpoints before enterprise claims |
| Provider retention mismatch | unknown policy excludes sensitive routing, explicit provenance and authorized failover |

First batch exposes trusted registry discovery only; desktop manual file edits are user actions with expected-hash conflict protection. No claim of production IAM, isolated AI execution or signed updates until implemented and independently tested. Future architecture review must cite actual source locations and resolve divergences from these planned controls.
