import { z } from 'zod';
import { RepositoryBroker, RepositoryError } from './repository.js';
import { McpHub } from '../../../packages/tools/src/mcp.js';
import { EgressBroker } from '../../../packages/tools/src/egress.js';
import { operationUuid } from '../../../packages/tools/src/journal.js';
import type { ExecutableTool, ToolHost } from '../../../packages/tools/src/agent.js';
export class DesktopTools implements ToolHost {
  repositoryId: string | null = null;
  constructor(
    private repository: RepositoryBroker,
    public mcp = new McpHub(),
    private network = new EgressBroker(),
  ) {}
  catalog(): ExecutableTool[] {
    const tools: ExecutableTool[] = [
      {
        name: 'web_read',
        description:
          'Read one public HTTPS page. Requires exact URL approval. Returns source and timestamp; remote content is untrusted.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
        scope: 'public-https-v1',
        execute: async (args, _id, signal) =>
          this.network.research(
            z
              .object({ url: z.string().url().max(2000) })
              .strict()
              .parse(args).url,
            signal,
          ),
      },
      {
        name: 'web_search',
        description:
          'Search English Wikipedia encyclopedia pages by topic. Not a general web search engine. Requires approval.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        scope: 'en.wikipedia.org-v1',
        execute: async (args, _id, signal) => {
          const { query } = z
            .object({ query: z.string().min(1).max(200) })
            .strict()
            .parse(args);
          return this.network.research(
            'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=' +
              encodeURIComponent(query),
            signal,
          );
        },
      },
    ];
    if (this.repositoryId) {
      const repositoryId = this.repositoryId,
        scope = this.repository.toolScope();
      tools.push(
        {
          name: 'repo_list',
          description: 'List files in the user-selected repository.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          scope,
          execute: async (args) => {
            z.object({}).strict().parse(args);
            return this.repository.list();
          },
        },
        {
          name: 'repo_read',
          description:
            'Read a repository-relative text file. Secret files and symlinks are blocked.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
          scope,
          execute: async (args) =>
            this.repository.read(z.object({ path: z.string() }).strict().parse(args).path),
        },
        {
          name: 'repo_save',
          description:
            'Replace an existing text file after user approval. Requires the exact hash from repo_read; creates a recovery backup.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              expectedHash: { type: 'string' },
            },
            required: ['path', 'content', 'expectedHash'],
            additionalProperties: false,
          },
          scope,
          execute: async (args, id) =>
            this.repository.save({
              ...z
                .object({
                  path: z.string(),
                  content: z.string().max(16000),
                  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
                })
                .strict()
                .parse(args),
              repositoryId,
              operationId: operationUuid(id),
            }),
        },
        {
          name: 'git_status',
          description: 'Read Git status of the selected repository without running hooks.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          scope,
          execute: async (args) => {
            z.object({}).strict().parse(args);
            return this.repository.status();
          },
        },
      );
    }
    const selected = this.repositoryId;
    return [
      ...tools.map((tool) =>
        tool.name.startsWith('repo_') || tool.name === 'git_status'
          ? {
              ...tool,
              execute: async (args: Record<string, unknown>, id: string, signal: AbortSignal) => {
                if (this.repositoryId !== selected || this.repository.toolScope() !== tool.scope)
                  throw new RepositoryError('STALE_REPOSITORY', 'Workspace selection changed.');
                return tool.execute(args, id, signal);
              },
            }
          : tool,
      ),
      ...this.mcp.catalog(),
    ];
  }
}
