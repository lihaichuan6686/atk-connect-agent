import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProductRuntime, getAgentDataRoot } from '../core/app-runtime.js';
import { ATKAgentError, toATKAgentError } from '../core/errors.js';
import { daemonEndpoint, type DaemonRequest, type DaemonResponse, type DaemonStatus } from './protocol.js';
import type { SessionOperationState } from '../core/session-store.js';
import { bindingFromInstance, listATKInstances } from '../atk/instances.js';
import { getResourceSnapshot } from '../atk/resources.js';
import type { ToolExecutionContext } from '../types.js';

export async function runSessionDaemon(sessionId: string): Promise<void> {
  const dataRoot = getAgentDataRoot();
  const endpoint = daemonEndpoint(dataRoot, sessionId);
  const runtime = new ProductRuntime({ sessionId, dataRoot });
  await runtime.initialize();
  const startedAt = new Date().toISOString();
  let operation: SessionOperationState = { status: 'idle', operationId: null };
  let stopping = false;
  let keepATKAliveOnStop = true;

  const setOperation = async (next: SessionOperationState) => {
    operation = next;
    await runtime.session.updateOperation(next);
  };
  await setOperation({ status: 'idle', operationId: null });
  runtime.manager.setProgressHandler((progress) => {
    const completed = Number(progress.completed ?? 0);
    const total = Number(progress.total ?? 0);
    const nextProgress = {
      completed, total,
      succeeded: Number(progress.succeeded ?? 0),
      failed: Number(progress.failed ?? 0),
      percent: total > 0 ? completed / total * 100 : 0,
    };
    operation = { ...operation, progress: nextProgress };
    void Promise.all([
      runtime.session.updateOperation(operation),
      runtime.session.appendEvent(operation.operationId ?? 'daemon', 'tool.progress', {
        tool: operation.tool, ...nextProgress,
      }),
      getResourceSnapshot(runtime.manager.getManagedPid()).then((snapshot) => {
        operation = { ...operation, resourceSnapshot: snapshot as unknown as Record<string, unknown> };
        return runtime.session.updateOperation(operation);
      }),
    ]).catch(() => undefined);
  });
  await writeFile(resolve(runtime.session.sessionDir, 'daemon.json'), JSON.stringify({
    pid: process.pid, endpoint, startedAt,
  }, null, 2), 'utf8');

  const status = (): DaemonStatus => ({
    sessionId,
    daemonPid: process.pid,
    sidecarPid: runtime.manager.getSidecarPid(),
    connected: runtime.manager.isConnected(),
    instance: runtime.manager.getBinding(),
    operation,
    startedAt,
  });

  const server = createServer((socket) => handleSocket(socket, async (request) => {
    switch (request.method) {
      case 'ping':
      case 'status': return status();
      case 'execute': {
        const tool = String(request.params?.tool ?? '');
        const input = asRecord(request.params?.input);
        if (tool === 'cancel_operation') {
          if (operation.status !== 'busy') return controlEnvelope(tool, { requested: false, operation });
          operation = { ...operation, status: 'cancelling', cancelRequested: true, atkTerminationConfirmed: false };
          await runtime.session.updateOperation(operation);
          runtime.manager.forceInterrupt();
          return controlEnvelope(tool, {
            requested: true, operation,
            bridgeInterrupted: true,
            atkTerminationConfirmed: false,
            atkCalculationTerminationConfirmed: false,
            meaning: 'CONNECT bridge 已切断；ATK 内部计算是否终止无法确认，Session 保持 failed 直到 recover 探测成功',
          });
        }
        if (tool === 'wait_until_idle') {
          const timeoutMs = numberOr(input.timeout_ms, 60_000);
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline && (operation.status === 'busy' || operation.status === 'cancelling')) await delay(200);
          return controlEnvelope(tool, status());
        }
        if (operation.status !== 'idle') {
          throw new ATKAgentError('OPERATION_BUSY', `Session 正处于 ${operation.status} 状态`, operation);
        }
        const operationId = randomUUID();
        await setOperation({ status: 'busy', operationId, tool, startedAt: new Date().toISOString(), cancelRequested: false });
        runtime.setAllowNewATK(request.params?.allowNewATK === true);
        try {
          const clientContext = request.params?.context && typeof request.params.context === 'object'
            ? request.params.context as Record<string, unknown> : {};
          const envelope = await runtime.executeTool(tool, input, {
            caller: safeCaller(clientContext.caller),
            sessionId,
            runId: typeof clientContext.runId === 'string' ? clientContext.runId : `run-${operationId}`,
            timeoutMs: numberOr(request.params?.operationTimeoutMs, 24 * 60 * 60 * 1000),
            dryRun: request.params?.dryRun === true,
            allowDestructive: request.params?.allowDestructive === true,
          });
          await runtime.session.updateRuntimeState({
            currentScenario: runtime.manager.currentScenario,
            atk: runtime.manager.getBinding(),
          });
          // A syntactically valid CONNECT command can be rejected with NACK
          // without leaving ATK busy or damaging the long-lived connection.
          // Treat that as an ordinary completed operation, not a poisoned
          // Session that requires manual recovery.
          const safeRefusal = ['TOOL_NOT_FOUND', 'INVALID_INPUT', 'RESOURCE_LIMIT', 'CONNECT_COMMAND_FAILED']
            .includes(envelope.error?.code ?? '');
          const finalState: SessionOperationState = envelope.success || safeRefusal
            ? { status: 'idle', operationId: null, atkTerminationConfirmed: true }
            : { status: 'failed', operationId, tool, atkTerminationConfirmed: operation.cancelRequested ? false : null };
          await setOperation(finalState);
          return { envelope, operation: finalState };
        } catch (cause) {
          await setOperation({ status: 'failed', operationId, tool, atkTerminationConfirmed: false });
          throw cause;
        }
      }
      case 'attach': {
        if (operation.status === 'busy' || operation.status === 'cancelling') throw new ATKAgentError('OPERATION_BUSY', '运行中不能切换实例');
        const pid = Number(request.params?.pid);
        const instances = await listATKInstances();
        const selected = instances.find((entry) => entry.pid === pid);
        if (!selected) throw new ATKAgentError('ATTACH_FAILED', `ATK PID ${pid} 不存在`, { instances });
        if (!selected.connectPorts.includes(runtime.config.atk.port)) {
          throw new ATKAgentError('ATTACH_FAILED', `PID ${pid} 未监听 CONNECT 端口 ${runtime.config.atk.port}`);
        }
        await runtime.manager.detach();
        const binding = bindingFromInstance(selected, false, runtime.config.atk.port);
        runtime.manager.setBinding(binding);
        await runtime.session.bindInstance(binding);
        await setOperation({ status: 'idle', operationId: null, atkTerminationConfirmed: true });
        return { binding };
      }
      case 'detach':
        if (operation.status === 'busy' || operation.status === 'cancelling') throw new ATKAgentError('OPERATION_BUSY', '运行中不能 detach');
        await runtime.manager.detach();
        await runtime.session.bindInstance(undefined);
        return { detached: true };
      case 'cancel':
        if (operation.status !== 'busy') return { requested: false, operation };
        operation = { ...operation, status: 'cancelling', cancelRequested: true, atkTerminationConfirmed: false };
        await runtime.session.updateOperation(operation);
        runtime.manager.forceInterrupt();
        return {
          requested: true, operation,
          bridgeInterrupted: true,
          atkTerminationConfirmed: false,
          atkCalculationTerminationConfirmed: false,
          meaning: 'CONNECT bridge 已切断；ATK 内部计算是否终止无法确认，Session 保持 failed 直到 recover 探测成功',
        };
      case 'wait': {
        const timeoutMs = numberOr(request.params?.timeoutMs, 60_000);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && (operation.status === 'busy' || operation.status === 'cancelling')) {
          await delay(200);
        }
        if (operation.status === 'failed' && request.params?.recover === true && runtime.manager.getBinding()) {
          try {
            await runtime.manager.ensureConnected();
            const probe = await runtime.manager.sendCommand('GetATKVersion', '/', { timeoutMs: 5000 });
            if (probe.success) await setOperation({ status: 'idle', operationId: null, atkTerminationConfirmed: true });
          } catch { /* 保持 failed，调用者可稍后重试 */ }
        }
        return status();
      }
      case 'stop':
        stopping = true;
        keepATKAliveOnStop = request.params?.keepATKAlive !== false;
        setImmediate(() => server.close());
        return { stopping: true };
    }
  }));

  if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolveListen);
  });
  await new Promise<void>((resolveClose) => server.once('close', resolveClose));
  await unlink(resolve(runtime.session.sessionDir, 'daemon.json')).catch(() => undefined);
  await runtime.dispose({ keepATKAlive: !stopping || keepATKAliveOnStop });
}

  function safeCaller(value: unknown): ToolExecutionContext['caller'] {
    return typeof value === 'string' && ['agent', 'cli', 'mcp', 'tui', 'test'].includes(value)
      ? value as ToolExecutionContext['caller'] : 'cli';
  }

  function handleSocket(socket: Socket, handler: (request: DaemonRequest) => Promise<unknown>): void {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    socket.pause();
    let request: DaemonRequest;
    try { request = JSON.parse(buffer.slice(0, newline)) as DaemonRequest; }
    catch (cause) {
      socket.end(`${JSON.stringify({ id: '', success: false, error: { code: 'INVALID_INPUT', message: String(cause) } })}\n`);
      return;
    }
    void handler(request).then((result) => {
      const response: DaemonResponse = { id: request.id, success: true, result };
      socket.end(`${JSON.stringify(response)}\n`);
    }).catch((cause) => {
      const error = toATKAgentError(cause);
      const response: DaemonResponse = { id: request.id, success: false, error: { code: error.code, message: error.message, details: error.details } };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function controlEnvelope(tool: string, data: unknown): { envelope: Record<string, unknown>; operation?: unknown } {
  return {
    envelope: {
      schemaVersion: '1.0', success: true, executionStatus: 'executed', verificationStatus: 'not_requested',
      tool, data, rawCommands: [], artifacts: [], warnings: [], durationMs: 0,
    },
  };
}
