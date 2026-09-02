import type { AppConfig } from '../config.js';
import type { AITool, ATKConnectionState, ToolExecutionContext } from '../types.js';
import { ProductRuntime, getAgentDataRoot } from '../core/app-runtime.js';
import { ATKAgentError } from '../core/errors.js';
import { daemonRequest, daemonStatus, ensureDaemon } from './client.js';
import type { DaemonExecuteResult } from './protocol.js';

export interface DaemonToolClient {
  sessionId: string;
  dataRoot: string;
  tools: AITool[];
  getATKState(): Promise<ATKConnectionState>;
}

export async function createDaemonToolClient(
  config: AppConfig,
  sessionId: string,
  options: { allowNewATK?: boolean; context?: ToolExecutionContext } = {},
): Promise<DaemonToolClient> {
  const dataRoot = getAgentDataRoot();
  await ensureDaemon(dataRoot, sessionId);
  // This runtime is only a local immutable tool catalogue. It is deliberately
  // not initialized and never owns an ATK connection or Session lock.
  const catalogue = new ProductRuntime({ config, sessionId, dataRoot });
  const tools = catalogue.registry.list().map((tool): AITool => ({
    ...tool,
    execute: async (input, callContext) => {
      if (tool.name === 'cancel_operation') return JSON.stringify(await daemonRequest(dataRoot, sessionId, 'cancel'));
      if (tool.name === 'wait_until_idle') return JSON.stringify(await daemonRequest(dataRoot, sessionId, 'wait', {
        timeoutMs: Number(input.timeout_ms ?? 60_000), recover: input.recover === true,
      }));
      const signal = callContext?.signal ?? options.context?.signal;
      if (signal?.aborted) throw new ATKAgentError('CANCELLED', '客户端已取消工具调用');
      const request = daemonRequest<DaemonExecuteResult>(dataRoot, sessionId, 'execute', {
        tool: tool.name,
        input,
        allowNewATK: options.allowNewATK === true,
        operationTimeoutMs: 24 * 60 * 60 * 1000,
        context: { ...options.context, ...callContext, signal: undefined },
      }, 24 * 60 * 60 * 1000);
      const result = signal ? await raceWithCancellation(request, signal, async () => {
        await daemonRequest(dataRoot, sessionId, 'cancel').catch(() => undefined);
      }) : await request;
      return result.envelope.success ? JSON.stringify(result.envelope) : `Error: ${JSON.stringify(result.envelope)}`;
    },
  }));
  return {
    sessionId,
    dataRoot,
    tools,
    getATKState: async () => {
      try { return (await daemonStatus(dataRoot, sessionId))?.connected ? 'connected' : 'disconnected'; }
      catch { return 'error'; }
    },
  };
}

function raceWithCancellation<T>(promise: Promise<T>, signal: AbortSignal, onCancel: () => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void onCancel();
      reject(new ATKAgentError('CANCELLED', '客户端已取消等待；已请求 daemon 切断 CONNECT bridge，但未确认 ATK 内部计算终止'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (cause) => { signal.removeEventListener('abort', abort); reject(cause); },
    );
  });
}
