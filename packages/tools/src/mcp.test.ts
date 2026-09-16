import { it, expect } from 'vitest';
import { McpHub } from './mcp';
it('connects a real stdio MCP subprocess, discovers its manifest and executes the real utility', async () => {
  const hub = new McpHub();
  try {
    const connected = await hub.connect({
      id: 'utility',
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', 'services/mcp-utility/main.ts'],
    });
    expect(connected.tools).toHaveLength(1);
    expect(connected.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    const output = await hub
      .catalog()[0]!
      .execute({ text: 'hello real MCP' }, 'test-operation', new AbortController().signal);
    expect(JSON.stringify(output)).toContain('words');
    expect(JSON.stringify(output)).toContain('3');
  } finally {
    await hub.close();
  }
}, 30000);

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EgressBroker } from './egress';
import { z } from 'zod';
it.each([true, false])(
  'real Streamable HTTP protocol with JSON response=%s (explicit loopback test transport)',
  async (enableJsonResponse) => {
    const server = new McpServer({ name: 'integration-fixture', version: '1' });
    server.registerTool(
      'sum',
      { inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse,
    });
    await server.connect(transport);
    const http = createServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const origin = 'http://127.0.0.1:' + address.port;
    // Private-address exceptions exist only in this test class, never in production config.
    class TestNetwork extends EgressBroker {
      override async fetch(input: string | URL | Request, init: RequestInit = {}) {
        if (new URL(String(input)).origin !== origin) throw new Error('fixture boundary');
        return fetch(input, init);
      }
    }
    const hub = new McpHub(new TestNetwork());
    try {
      await hub.connect({ id: 'remote', transport: 'http', url: origin + '/mcp' });
      const output = await hub
        .catalog()[0]!
        .execute({ a: 13, b: 29 }, 'operation', new AbortController().signal);
      expect(JSON.stringify(output)).toContain('42');
    } finally {
      await hub.close();
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);
