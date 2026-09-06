import { createHash } from 'node:crypto';
import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const MAX_JSON_BYTES = 65_536;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_DEPTH = 32;

/** Canonical JSON for security bindings; unsupported JS values fail, never silently coerce. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const emit = (text: string): string => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_JSON_BYTES) throw new TypeError('Canonical JSON exceeds byte limit');
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new TypeError('Canonical JSON exceeds structural limit');
    if (item === null) return emit('null');
    if (typeof item === 'string') {
      if (item.length > MAX_JSON_BYTES) throw new TypeError('Canonical JSON exceeds byte limit');
      return emit(JSON.stringify(item));
    }
    if (typeof item === 'boolean') return emit(item ? 'true' : 'false');
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) throw new TypeError('Unsupported JSON number');
      return emit(JSON.stringify(item));
    }
    if (typeof item !== 'object') throw new TypeError('Unsupported JSON value');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Only plain JSON objects are accepted');
    if (Array.isArray(item) && prototype !== Array.prototype) throw new TypeError('Unsupported array prototype');
    if (ancestors.has(item)) throw new TypeError('Cyclic JSON is not accepted');
    ancestors.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== 'string')) throw new TypeError('Symbol keys are not accepted');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item)) {
        if (item.length > MAX_JSON_NODES || keys.length !== item.length + 1) throw new TypeError('Sparse or extended arrays are not accepted');
        const parts: string[] = [];
        emit('[');
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Array accessors and holes are not accepted');
          if (index > 0) emit(',');
          parts.push(visit(descriptor.value, depth + 1));
        }
        emit(']');
        return `[${parts.join(',')}]`;
      }
      const parts: string[] = [];
      emit('{');
      for (const key of (keys as string[]).sort()) {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Object accessors and hidden properties are not accepted');
        if (parts.length > 0) emit(',');
        parts.push(`${emit(JSON.stringify(key))}${emit(':')}${visit(descriptor.value, depth + 1)}`);
      }
      emit('}');
      return `{${parts.join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function argumentDigest(argumentsValue: unknown): string {
  return digest({ domain: 'sand.tool.arguments.v1', arguments: argumentsValue });
}

function isJson(value: unknown): value is JsonValue {
  try { canonicalJson(value); return true; } catch { return false; }
}

const identifier = z.string().min(1).max(256);
const toolName = z.string().regex(/^[a-z][a-z0-9._/-]{0,127}$/);
const sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted', 'secret']);
const environment = z.enum(['development', 'staging', 'production']);
const scopeSchema = z.enum(['once', 'session', 'project']);
const jsonValue = z.custom<JsonValue>(isJson, 'Expected bounded plain JSON');
const jsonObject = z.custom<JsonObject>((value) => value !== null && typeof value === 'object' && !Array.isArray(value) && isJson(value), 'Expected bounded plain JSON object');
const costSchema = z.object({
  amountMicrounits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.string().min(1).max(2048),
  observedAt: z.string().datetime(),
}).strict();

export const toolActionSchema = z.object({
  actionId: identifier,
  actorId: identifier,
  userId: identifier,
  tenantId: identifier,
  organizationId: identifier,
  projectId: identifier,
  sessionId: identifier,
  runId: identifier.nullable(),
  tool: toolName,
  operation: toolName,
  arguments: jsonObject,
  target: z.object({ kind: identifier, id: z.string().min(1).max(2048), revision: identifier.nullable() }).strict(),
  networkDestination: z.string().min(1).max(2048).nullable(),
  dataSensitivity: sensitivity,
  estimatedCost: costSchema.nullable(),
  environment,
  policyVersion: identifier,
}).strict();

const matchSchema = z.object({
  tool: toolName,
  operation: toolName,
  actionId: identifier.optional(),
  actorId: identifier.optional(),
  userId: identifier.optional(),
  projectId: identifier.optional(),
  sessionId: identifier.optional(),
  runId: identifier.nullable().optional(),
  targetKind: identifier.optional(),
  targetId: z.string().min(1).max(2048).optional(),
  targetRevision: identifier.nullable().optional(),
  networkDestination: z.string().min(1).max(2048).nullable().optional(),
  dataSensitivity: sensitivity.optional(),
  estimatedCost: costSchema.nullable().optional(),
  environment: environment.optional(),
  arguments: z.array(z.object({ path: z.array(z.string().min(1).max(256)).min(1).max(16), equals: jsonValue }).strict()).max(32).optional(),
}).strict();

export const policySetSchema = z.object({
  tenantId: identifier,
  organizationId: identifier,
  version: identifier,
  rules: z.array(z.object({ id: identifier, effect: z.enum(['allow', 'deny', 'ask']), match: matchSchema }).strict()).max(256),
}).strict().refine((policy) => new Set(policy.rules.map((rule) => rule.id)).size === policy.rules.length, 'Rule IDs must be unique');

const bindingSchema = z.object({
  schemaVersion: z.literal(1),
  scope: scopeSchema,
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: identifier,
  actorId: identifier,
  userId: identifier,
  tenantId: identifier,
  organizationId: identifier,
  projectId: identifier,
});

export const approvalReceiptSchema = bindingSchema.extend({
  id: identifier,
  issuedByUserId: identifier,
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  consumedAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
}).strict();

export type ToolAction = z.infer<typeof toolActionSchema>;
export type PolicySet = z.infer<typeof policySetSchema>;
export type PolicyRule = PolicySet['rules'][number];
export type ApprovalScope = z.infer<typeof scopeSchema>;
export type ApprovalBinding = z.infer<typeof bindingSchema>;
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type PolicyDecision = {
  decision: 'allow' | 'deny' | 'ask';
  reason: 'invalid_action' | 'invalid_policy' | 'invalid_clock' | 'context_mismatch' | 'no_matching_rule' | 'explicit_deny' | 'approval_required' | 'explicit_allow' | 'approved';
  matchedRuleIds: string[];
  approvalId?: string;
  requiresApprovalConsumption: boolean;
};

/** Computes a binding only. The caller must authenticate approval issuance and persist it. */
export function approvalBinding(actionInput: ToolAction, scopeInput: ApprovalScope): ApprovalBinding {
  canonicalJson(actionInput);
  const action = toolActionSchema.parse(actionInput);
  const scope = scopeSchema.parse(scopeInput);
  const boundAction = {
    ...action,
    actionId: scope === 'once' ? action.actionId : null,
    runId: scope === 'once' ? action.runId : null,
    sessionId: scope === 'project' ? null : action.sessionId,
  };
  return {
    schemaVersion: 1,
    scope,
    actionDigest: digest({ domain: 'sand.tool.approval.v1', scope, action: boundAction }),
    policyVersion: action.policyVersion,
    actorId: action.actorId,
    userId: action.userId,
    tenantId: action.tenantId,
    organizationId: action.organizationId,
    projectId: action.projectId,
  };
}

function matches(rule: PolicyRule, action: ToolAction): boolean {
  const fields: Record<string, unknown> = {
    ...action,
    targetKind: action.target.kind,
    targetId: action.target.id,
    targetRevision: action.target.revision,
  };
  for (const [key, expected] of Object.entries(rule.match)) {
    if (key !== 'arguments' && canonicalJson(fields[key]) !== canonicalJson(expected)) return false;
  }
  for (const constraint of rule.match.arguments ?? []) {
    let value: unknown = action.arguments;
    for (const segment of constraint.path) {
      if (value === null || typeof value !== 'object') return false;
      const property = Object.getOwnPropertyDescriptor(value, segment);
      if (!property || !property.enumerable || !('value' in property)) return false;
      value = property.value;
    }
    if (canonicalJson(value) !== canonicalJson(constraint.equals)) return false;
  }
  return true;
}

function validReceipt(input: unknown, action: ToolAction, now: number): ApprovalReceipt | null {
  try {
    canonicalJson(input);
    const result = approvalReceiptSchema.safeParse(input);
    if (!result.success) return null;
    const receipt = result.data;
    if (receipt.issuedAt > now || receipt.expiresAt <= now || receipt.expiresAt <= receipt.issuedAt || receipt.consumedAt !== null || receipt.revokedAt !== null) return null;
    const expected = approvalBinding(action, receipt.scope);
    for (const [key, value] of Object.entries(expected)) {
      if (receipt[key as keyof ApprovalBinding] !== value) return null;
    }
    return receipt;
  } catch { return null; }
}

/** Pure evaluator. Previous approvals MUST come from the trusted server store, never client JSON. */
export class ToolPolicyEngine {
  evaluate(input: { action: ToolAction; policy: PolicySet; previousApprovals?: readonly ApprovalReceipt[]; now: number }): PolicyDecision {
    const answer = (decision: PolicyDecision['decision'], reason: PolicyDecision['reason'], matchedRuleIds: string[] = []): PolicyDecision => ({ decision, reason, matchedRuleIds, requiresApprovalConsumption: false });
    if (!Number.isSafeInteger(input.now) || input.now < 0) return answer('deny', 'invalid_clock');
    let action: ToolAction;
    let policy: PolicySet;
    try { canonicalJson(input.action); action = toolActionSchema.parse(input.action); } catch { return answer('deny', 'invalid_action'); }
    try { canonicalJson(input.policy); policy = policySetSchema.parse(input.policy); } catch { return answer('deny', 'invalid_policy'); }
    if (action.tenantId !== policy.tenantId || action.organizationId !== policy.organizationId || action.policyVersion !== policy.version) return answer('deny', 'context_mismatch');
    const matched = policy.rules.filter((rule) => matches(rule, action));
    const ids = matched.map((rule) => rule.id);
    if (matched.length === 0) return answer('deny', 'no_matching_rule');
    if (matched.some((rule) => rule.effect === 'deny')) return answer('deny', 'explicit_deny', ids);
    if (matched.some((rule) => rule.effect === 'ask')) {
      for (const receiptInput of (input.previousApprovals ?? []).slice(0, 256)) {
        const receipt = validReceipt(receiptInput, action, input.now);
        if (receipt) return { decision: 'allow', reason: 'approved', matchedRuleIds: ids, approvalId: receipt.id, requiresApprovalConsumption: receipt.scope === 'once' };
      }
      return answer('ask', 'approval_required', ids);
    }
    return answer('allow', 'explicit_allow', ids);
  }
}
