import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProductRuntime } from '../src/core/app-runtime.js';
import { createATKMCPProtocolServer } from '../src/mcp/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('ATK MCP server', () => {
  it('lists the shared registry and calls read-only tools through MCP', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'atk-mcp-'));
    const runtime = new ProductRuntime({ dataRoot, sessionId: 'mcp-test' });
    await runtime.initialize();
    const server = createATKMCPProtocolServer(runtime);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => { await client.close(); await server.close(); await runtime.dispose(); });

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'search_atk_commands')).toBe(true);
    const result = await client.callTool({
      name: 'search_atk_commands',
      arguments: { query: '卫星', limit: 2 },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('search_atk_commands');
  });
});
