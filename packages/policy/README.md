# Policy engine

Pure, bounded TypeScript evaluation for tool actions; `src/index.ts` is intended for Electron main/backend, not renderer. This package does not execute tools, authenticate users, persist policy/approvals, consume one-time grants, reserve budget or append audit records.

Exports: `ToolPolicyEngine`, `ToolAction`, `PolicySet`, `PolicyRule`, `PolicyDecision`, `ApprovalScope`, `ApprovalBinding`, `ApprovalReceipt`, `approvalBinding`, `canonicalJson`, `argumentDigest` and strict Zod schemas for actions, policies and receipts.

```ts
const result = new ToolPolicyEngine().evaluate({ action, policy, previousApprovals, now: Date.now() });
if (result.decision !== 'allow') throw new Error(result.reason);
// Before executing: persist audit intent and atomically reserve quota/check revocation.
// If requiresApprovalConsumption: consume approvalId with an unused-row conditional update.
// A failed consume MUST deny execution. Persist operation receipt + audit outcome afterwards.
```

Rules require exact `tool` and `operation`. Other provided selectors and argument constraints also compare exactly. Omitted selectors impose no extra restriction; policy ownership always binds tenant and organization. There is no glob/regex/eval/substring rule DSL. A literal `*` is not a wildcard; it is rejected for tool/operation. Argument paths are arrays of literal own-property segments, never prototype traversal or expressions. JSON input must be plain data, with no accessors, hidden properties, symbols, functions, dates, non-finite numbers, negative zero, cycles or sparse arrays. Canonicalization sorts object keys and preserves array ordering, bounded to 64 KiB, depth 32 and 10,000 nodes.

Precedence: any matching `deny` wins; then `ask`; then `allow`; no match denies. An approval only satisfies a matching `ask`; it cannot authorize an unknown tool or override `deny`. Rule IDs are unique and policy version must match the action.

Approval bindings include all sensitive action fields: tool, arguments, target/revision, network destination, classification, estimated cost with source/time, environment, policy version, identity and project. `once` also binds action/run/session; `session` can cover identical actions across calls/runs within the same session; `project` can cover identical actions across sessions in the same project for the same actor/user. Every receipt requires expiry and must be unrevoked/unconsumed. Future-issued and expired receipts are rejected. Policy changes must create a new policy version; reusing a version for changed rules violates the integration contract.

**Trust requirement:** load policies and previous approvals from a server-owned trusted store, with verified membership and issuer authority. Pass `now` from the trusted executor clock, not the request. `approvalBinding` only calculates a digest; it does not grant consent or sign a receipt. Client/model-supplied receipts are untrusted and must never be passed as verified approvals. Revalidate policy, grants and budget at the executor. A returned `allow` is not evidence that any side effect occurred.

Integration is pending until callers enforce the result, persist policy/approval/audit, perform atomic one-time consumption and test concurrent revocation/execution. This package has no migration because it has no storage. Integration needs an ADR/migration in its owning control-plane slice. Unit tests use synthetic JSON only; no external providers or mocks in production paths. Unit tests do not satisfy security acceptance SEC-POLICY-01/02 end-to-end or transaction guarantees.

Telemetry belongs to the caller: record decision/reason, matched rule IDs, policy version and action digest in a redacted audit intent; never stringify the complete action/arguments. Emit bounded decision counts and evaluation latency with no user/content labels. This pure evaluator intentionally does not open a logger, network connection or telemetry exporter.

Validation on the development Windows workspace (working tree, not a signed release): `node node_modules/vitest/vitest.mjs run packages/policy/src/index.test.ts` passed **52 tests**; scoped strict `tsc --noEmit` passed; `node node_modules/eslint/bin/eslint.js packages/policy` passed. Real provider, database concurrency, Electron and executor integration tests are outside this package's unit evidence and must be reported by their owning slices.