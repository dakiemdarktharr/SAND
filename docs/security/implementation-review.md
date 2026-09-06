# Independent implementation review — batch 01

A fresh-context agent performed a read-only source review after the prospective threat model. This is not a complete security scan or production certification. All inspected code was still under development; fixes were followed by targeted tests and final combined verification.

## Material findings addressed

| Finding | Fix / evidence |
|---|---|
| Retried discovery could report fresh counters different from committed snapshot | Store.saveRegistry returns committed outcomes; workflow activities count that return. Database retry regression + real Temporal workflow tests. |
| Temporal terminal timeout/termination could leave nonterminal DB projection | WorkflowReconciler scans unfinished runs and records failure/cancellation without inferring success. Actual Temporal termination regression. |
| Role guard omitted ownership of some tenant tables | Guard covers all application tenant tables. PGlite ownership regression + native PostgreSQL runtime validation. |
| READ COMMITTED replay could return events beyond reported horizon | Events query caps sequence at captured next_sequence. HTTP/WS replay tests. |
| PostgreSQL init password appeared in psql argv | Init script reads environment inside psql with getenv. Compose remains untested locally without Docker. |
| Audit export loaded unbounded history | Paginated JSONL with explicit next-cursor/has-more headers; API continuation tests. |
| Desktop changing repository during save could cross-bind authority | Opaque repository grant identity and serialized grant/save, regression tests. |
| Git could discover ancestor repository outside selected subtree | Check discovered top-level against selected root before status/diff. |
| Two desktop instances could append conflicting local audit heads | Single-instance lock before ledger initialization. |
| Different fixed-principal workers could consume one another's activities | Queue namespace derives from tenant+actor, validated again by activity. |

Source modules: apps/desktop/src/{main,repository,local-audit}.ts; services/control-plane/src/{store,server}.ts; services/workflows/src/{activities,dispatcher,reconciler,contracts}.ts; packages/providers/src/{network,registry}.ts. Final verification counts and any remaining failures belong to the batch report, not this source review.

## Actual boundaries and unresolved gates

- Renderer has no Node or generic invoke/exec/fetch API. Main broker checks frame/origin and validates arguments. This is desktop capability confinement, not OS permission isolation from another hostile process under the same user.
- Registry activities are **trusted infrastructure workers**, with provider credentials in their environment. Future untrusted repository-code workers must not receive those credentials. The prospective threat model's no-worker-secret rule applies to those untrusted execution workers.
- Local development uses one configured identity per API process, transaction-local tenant plus FORCE RLS. Production OIDC/session membership and privileged-role membership validation are still required. A runtime role must not inherit or SET ROLE into a table owner/superuser.
- Local secret-path/content scanning is heuristic; no absolute secret-elimination claim. OS keychain/Vault, rotation, encrypted backup source copies and Windows ACL verification are not implemented.
- Hash chains have no externally anchored signatures/WORM checkpoint. DB owner or host administrator is outside their current tamper-evidence guarantee. Large-ledger verification still needs streaming.
- General policy/one-time consent persistence is incomplete; only registry admission is connected to the shared policy engine. Filesystem/Git and fixed-origin network brokers have narrower local policies.
- Provider broker pins classified public addresses and denies redirects. It does not provide OS-level egress isolation. Optional trusted OTLP exporter is a separate infrastructure network path.
- Agent inference/MCP/GitHub App/PTY/LSP/cloud microVM/quota/routing/failover/production operations and signing remain release gates. No fake implementation substitutes for them.
