import { z } from 'zod';
export const inferenceProviders = [
  'ollama',
  'openrouter',
  'openai',
  'anthropic',
  'gemini',
] as const;
const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const studioNodeSchema = z
  .object({
    id: nodeId,
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['agent', 'review', 'output']),
    instructions: z.string().max(8000).default(''),
    provider: z.enum(inferenceProviders).default('ollama'),
    toolProtocol: z.enum(['native', 'json']).optional(),
    tools: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/))
      .max(12)
      .optional(),
    model: z.string().max(200).default(''),
    dependsOn: z.array(nodeId).max(11),
    maxOutputTokens: z.number().int().min(32).max(4096).default(512),
  })
  .strict();
export const definitionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000),
    revision: z.number().int().nonnegative(),
    nodes: z.array(studioNodeSchema).min(1).max(12),
    concurrency: z.number().int().min(1).max(4).default(2),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (ids.size !== graph.nodes.length)
      ctx.addIssue({ code: 'custom', message: 'Mỗi bước cần ID riêng.' });
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const dep of graph.nodes.find((n) => n.id === id)?.dependsOn ?? [])
        if (!ids.has(dep) || !visit(dep)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    for (const n of graph.nodes) {
      if (new Set(n.dependsOn).size !== n.dependsOn.length || !visit(n.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Luồng có vòng lặp, ID lặp hoặc thiếu bước đầu vào.',
        });
      if (n.kind !== 'agent' && !n.dependsOn.length)
        ctx.addIssue({ code: 'custom', message: 'Bước duyệt/xuất cần ít nhất một bước đầu vào.' });
    }
  });
export type StudioNode = z.infer<typeof studioNodeSchema>;
export type Definition = z.infer<typeof definitionSchema>;
export type NodeState = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
export type StudioStatus =
  | 'running'
  | 'paused'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface InferenceResult {
  text: string;
  requestedModel: string;
  reportedModel: string | null;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  costUsd: number | null;
  costSource: string | null;
  observedAt: string;
  truncated: boolean;
}
export interface NodeExecution {
  id: string;
  state: NodeState;
  output: string | null;
  error: string | null;
  attempt: number;
  result: InferenceResult | null;
}
export interface StudioEvent {
  sequence: number;
  at: string;
  type: string;
  nodeId: string | null;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}
export interface StudioRun {
  id: string;
  definition: Definition;
  input: string;
  status: StudioStatus;
  allowCloud: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: NodeExecution[];
  events: StudioEvent[];
}
export class StudioError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function validateForRun(definition: Definition) {
  if (!definition.nodes.some((n) => n.kind === 'output'))
    throw new StudioError('OUTPUT_REQUIRED', 'Thêm bước xuất kết quả trước khi chạy.');
  for (const n of definition.nodes)
    if (n.kind === 'agent' && (!n.model.trim() || !n.instructions.trim()))
      throw new StudioError('AGENT_CONFIGURATION', 'Mỗi agent cần model và chỉ dẫn.');
}
export function createTemplate(): Definition {
  return {
    id: crypto.randomUUID(),
    name: 'Phân tích đa góc nhìn',
    description: 'Hai chuyên gia đọc tài liệu, một người tổng hợp, bạn duyệt rồi xuất báo cáo.',
    revision: 0,
    concurrency: 2,
    nodes: [
      {
        id: 'analyst',
        name: 'Chuyên gia phân tích',
        kind: 'agent',
        instructions:
          'Phân tích dữ liệu được cung cấp. Nêu các luận điểm có căn cứ, điều chưa biết và câu hỏi cần làm rõ. Không bịa nguồn hoặc con số.',
        provider: 'ollama',
        model: '',
        dependsOn: [],
        maxOutputTokens: 512,
      },
      {
        id: 'critic',
        name: 'Chuyên gia phản biện',
        kind: 'agent',
        instructions:
          'Đọc độc lập dữ liệu được cung cấp. Tìm giả định, rủi ro, mâu thuẫn và dữ kiện còn thiếu. Không bịa dữ liệu.',
        provider: 'ollama',
        model: '',
        dependsOn: [],
        maxOutputTokens: 512,
      },
      {
        id: 'synthesis',
        name: 'Biên tập báo cáo',
        kind: 'agent',
        instructions:
          'Tổng hợp hai góc nhìn thành báo cáo ngắn bằng ngôn ngữ của người dùng: kết luận, căn cứ, rủi ro và bước tiếp theo. Phân biệt dữ kiện và suy luận. Không tự thêm nguồn.',
        provider: 'ollama',
        model: '',
        dependsOn: ['analyst', 'critic'],
        maxOutputTokens: 768,
      },
      {
        id: 'review',
        name: 'Bạn kiểm tra và duyệt',
        kind: 'review',
        instructions: 'Kiểm tra nội dung và nguồn trước khi duyệt.',
        provider: 'ollama',
        model: '',
        dependsOn: ['synthesis'],
        maxOutputTokens: 512,
      },
      {
        id: 'report',
        name: 'Báo cáo cuối',
        kind: 'output',
        instructions: '',
        provider: 'ollama',
        model: '',
        dependsOn: ['review'],
        maxOutputTokens: 512,
      },
    ],
  };
}
