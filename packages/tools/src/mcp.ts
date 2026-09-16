import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { ExecutableTool } from './agent.js';
import { digest } from './journal.js';
import { EgressBroker } from './egress.js';
import { StudioError } from '../../studio/src/schema.js';
import { secretLike } from '../../studio/src/runtime.js';
export const mcpConfiguration = z.discriminatedUnion('transport', [
  z
    .object({
      id: z.string().regex(/^[a-z0-9_-]{1,30}$/),
      transport: z.literal('stdio'),
      command: z.string().min(1).max(1000),
      args: z.array(z.string().max(1000)).max(20),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^[a-z0-9_-]{1,30}$/),
      transport: z.literal('http'),
      url: z.string().url().max(2000),
    })
    .strict(),
]);
export type McpConfiguration = z.infer<typeof mcpConfiguration>;
/** A stdio server has OS-user authority. Native consent is mandatory before connect(). */
export class McpHub {
  private clients = new Map<string, Client>();
  private tools = new Map<string, ExecutableTool[]>();
  constructor(private network = new EgressBroker()) {}
  async connect(raw: unknown) {
    const config = mcpConfiguration.parse(raw);
    if (secretLike(JSON.stringify(config)))
      throw new StudioError('SECRET_DETECTED', 'Không đặt token trong cấu hình MCP.');
    if (this.clients.has(config.id))
      throw new StudioError('MCP_ALREADY_CONNECTED', 'Ngắt kết nối trước khi đổi manifest.');
    const client = new Client({ name: 'sand', version: '0.1.0' }, { capabilities: {} });
    const env = Object.fromEntries(
      ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    );
    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            env,
            stderr: 'ignore',
            maxBufferSize: 1_000_000,
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            fetch: (url, init) => this.network.fetch(url, init, [new URL(config.url).origin]),
            reconnectionOptions: {
              maxRetries: 0,
              maxReconnectionDelay: 1000,
              initialReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          });
    try {
      await client.connect(transport, { timeout: 15000 });
      const result = await client.listTools({}, { timeout: 15000 });
      if (
        result.nextCursor ||
        result.tools.length > 50 ||
        JSON.stringify(result).length > 64000 ||
        secretLike(JSON.stringify(result))
      )
        throw new StudioError(
          'MCP_MANIFEST_LIMIT',
          'Manifest cần nhỏ hơn 50 tools/64 KB và không chứa secret.',
        );
      const manifest = digest({ config, tools: result.tools });
      const tools: ExecutableTool[] = result.tools.map((t) => ({
        name: 'mcp_' + digest({ server: config.id, name: t.name }).slice(0, 24),
        description: ('MCP ' + config.id + ' / ' + t.name + ': ' + (t.description ?? '')).slice(
          0,
          2000,
        ),
        parameters: t.inputSchema as Record<string, unknown>,
        scope: manifest,
        execute: async (args, _id, signal) => {
          const fresh = await client.listTools({}, { timeout: 15000, signal });
          if (fresh.nextCursor || digest({ config, tools: fresh.tools }) !== manifest)
            throw new StudioError(
              'MCP_MANIFEST_CHANGED',
              'Server đã thay đổi tool/schema. Kết nối và duyệt lại.',
            );
          const output = await client.callTool({ name: t.name, arguments: args }, undefined, {
            signal,
            timeout: 30000,
          });
          if (output.isError)
            throw new StudioError('MCP_TOOL_ERROR', 'MCP server báo lỗi; không coi là thành công.');
          return output;
        },
      }));
      this.clients.set(config.id, client);
      this.tools.set(config.id, tools);
      return {
        id: config.id,
        transport: config.transport,
        manifestHash: manifest,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        connectedAt: new Date().toISOString(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  catalog() {
    return [...this.tools.values()].flat();
  }
  async disconnect(id: string) {
    await this.clients.get(id)?.close();
    this.clients.delete(id);
    this.tools.delete(id);
  }
  async close() {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
    this.tools.clear();
  }
}
