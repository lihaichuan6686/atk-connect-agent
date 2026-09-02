import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ProductRuntime, getAgentDataRoot } from '../core/app-runtime.js';
import { VERSION } from '../version.js';
import { daemonRequest, ensureDaemon } from '../daemon/client.js';
import type { DaemonExecuteResult } from '../daemon/protocol.js';

export async function startATKMCPServer(options: { sessionId?: string; keepATKAlive?: boolean } = {}): Promise<void> {
  const sessionId = options.sessionId ?? `mcp-${randomUUID()}`;
  const dataRoot = getAgentDataRoot();
  await ensureDaemon(dataRoot, sessionId);
  const runtime = new ProductRuntime({ sessionId, dataRoot });

  const server = createATKMCPProtocolServer(runtime, { dataRoot, sessionId });
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      process.stdin.once('end', finish);
      process.stdin.once('close', finish);
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    });
  } finally {
    await server.close().catch(() => undefined);
    // MCP 客户端退出不关闭 daemon、sidecar 或 ATK；显式使用 session/daemon close。
  }
}

export function createATKMCPProtocolServer(
  runtime: ProductRuntime,
  remote?: { dataRoot: string; sessionId: string },
): Server {
  const sessionId = runtime.session.sessionId;
  const server = new Server(
    { name: 'atk-agent', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
    tools: runtime.registry.describe().map((tool) => ({
      name: tool.name,
      title: readableTitle(tool.name),
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: {
        readOnlyHint: tool.metadata.readOnly,
        destructiveHint: tool.metadata.destructive,
        idempotentHint: tool.metadata.idempotent,
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const runId = `run-${randomUUID()}`;
      const name = request.params.name;
      const input = request.params.arguments ?? {};
      if (remote) {
        if (name === 'cancel_operation') {
          const cancelled = await daemonRequest(remote.dataRoot, remote.sessionId, 'cancel');
          return { content: [{ type: 'text', text: JSON.stringify(cancelled) }], structuredContent: cancelled as Record<string, unknown> };
        }
        if (name === 'wait_until_idle') {
          const timeoutMs = Number(input.timeout_ms ?? 60_000);
          const waited = await daemonRequest(remote.dataRoot, remote.sessionId, 'wait', { timeoutMs, recover: input.recover === true }, timeoutMs + 2000);
          return { content: [{ type: 'text', text: JSON.stringify(waited) }], structuredContent: waited as Record<string, unknown> };
        }
        const cancel = () => { void daemonRequest(remote.dataRoot, remote.sessionId, 'cancel').catch(() => undefined); };
        extra.signal?.addEventListener('abort', cancel, { once: true });
        try {
          const execution = await daemonRequest<DaemonExecuteResult>(remote.dataRoot, remote.sessionId, 'execute', {
            tool: name,
            input,
            allowDestructive: process.env.ATK_MCP_ALLOW_DESTRUCTIVE === '1',
            allowNewATK: process.env.ATK_MCP_ALLOW_NEW_ATK === '1',
            operationTimeoutMs: 24 * 60 * 60 * 1000,
          }, 24 * 60 * 60 * 1000);
          return {
            isError: !execution.envelope.success,
            content: [{ type: 'text', text: JSON.stringify(execution.envelope) }],
            structuredContent: execution.envelope as unknown as Record<string, unknown>,
          };
        } finally {
          extra.signal?.removeEventListener('abort', cancel);
        }
      }
      await runtime.session.appendEvent(runId, 'run.started', { mode: 'mcp', tool: name });
      await runtime.session.appendEvent(runId, 'tool.started', { tool: name, input });
      const result = await runtime.executeTool(name, input, {
        caller: 'mcp', sessionId, runId, signal: extra.signal,
        allowDestructive: process.env.ATK_MCP_ALLOW_DESTRUCTIVE === '1',
      });
      await runtime.session.appendEvent(
        runId,
        result.success ? 'run.finished' : result.executionStatus === 'cancelled' ? 'run.cancelled' : 'run.failed',
        { result },
      );
      await runtime.session.recordRun(runId, result.success ? 'completed' : result.executionStatus);
      return {
        isError: !result.success,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

function readableTitle(name: string): string {
  return name.split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ');
}
