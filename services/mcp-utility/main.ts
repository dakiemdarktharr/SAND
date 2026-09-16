import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// Real deterministic utility: no model, credentials or sample results.
const server = new McpServer({ name: 'sand-text-utility', version: '0.1.0' });
server.registerTool(
  'text_statistics',
  {
    description: 'Compute word, line and character counts from supplied text.',
    inputSchema: { text: z.string().max(16000) },
  },
  async ({ text }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          characters: text.length,
          words: text.trim() ? text.trim().split(/\s+/).length : 0,
          lines: text.split('\n').length,
        }),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
