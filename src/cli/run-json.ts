import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createProvider, AIClient } from '../provider/provider.js';
import { Agent } from '../agent/agent.js';
import { buildSystemPrompt } from '../system/prompt.js';
import { getAgentDataRoot } from '../core/app-runtime.js';
import { ATKAgentError, exitCodeFor } from '../core/errors.js';
import type { ProductEvent } from '../core/contracts.js';
import { createDaemonToolClient } from '../daemon/tools.js';
import { SessionStore } from '../core/session-store.js';
import { VERSION } from '../version.js';

export interface JsonRunOptions {
  session?: string;
  timeout?: string;
  keepAtkAlive?: boolean;
  allowNewAtk?: boolean;
}

export async function runJsonMode(prompt: string, options: JsonRunOptions): Promise<void> {
  const config = loadConfig();
  if (config.llm.provider !== 'ollama' && !config.llm.apiKey) {
    emitFallback('run.failed', { error: { code: 'CONFIGURATION_ERROR', message: '未配置 AI_API_KEY' } });
    process.exitCode = 2;
    return;
  }

  const sessionId = options.session ?? `run-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const timeoutMs = parseTimeout(options.timeout ?? '600000');
  const session = new SessionStore(getAgentDataRoot(), sessionId, VERSION);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let terminal = false;
  let initialized = false;

  const emit = async (type: ProductEvent['type'], payload: Record<string, unknown>): Promise<void> => {
    const event = await session.appendEvent(runId, type, payload);
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const daemon = await createDaemonToolClient(config, sessionId, {
      allowNewATK: options.allowNewAtk === true,
      context: { caller: 'agent', sessionId, runId, signal: controller.signal, recordToolEvent: false },
    });
    initialized = true;
    await emit('run.started', { mode: 'agent', prompt, timeoutMs });
    const provider = createProvider(config.llm);
    const agent = new Agent(new AIClient(provider), {
      systemPrompt: buildSystemPrompt(),
      model: config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model,
      temperature: 0.1,
      maxTokens: 4096,
      maxSteps: 15,
      tools: daemon.tools,
    });

    let finalContent = '';
    const toolStatus = new Map<string, boolean>();
    for await (const event of agent.run(prompt, { signal: controller.signal })) {
      if (event.type === 'tool_call') {
        await emit('tool.started', { tool: event.toolName, input: event.args });
      } else if (event.type === 'tool_result') {
        toolStatus.set(event.toolName, event.success);
        await emit('tool.finished', {
          tool: event.toolName,
          success: event.success,
          result: parseResult(event.result),
        });
      } else if (event.type === 'text') {
        finalContent += event.content;
      } else if (event.type === 'done') {
        finalContent = event.content || finalContent;
        const failedTools = [...toolStatus].filter(([, success]) => !success).map(([name]) => name);
        if (failedTools.length > 0) {
          await emit('run.failed', {
            success: false,
            content: finalContent,
            error: { code: 'CONNECT_COMMAND_FAILED', message: `任务结束时仍有失败工具: ${failedTools.join(', ')}` },
          });
          await session.recordRun(runId, 'failed');
          process.exitCode = 4;
        } else {
          await emit('run.finished', { success: true, content: finalContent });
          await session.recordRun(runId, 'completed');
        }
        terminal = true;
      } else if (event.type === 'cancelled') {
        const timedOut = controller.signal.aborted;
        await emit('run.cancelled', {
          success: false,
          error: { code: timedOut ? 'TIMEOUT' : 'CANCELLED', message: timedOut ? `任务超过 ${timeoutMs}ms` : event.message },
        });
        process.exitCode = 6;
        await session.recordRun(runId, timedOut ? 'timeout' : 'cancelled');
        terminal = true;
      } else if (event.type === 'error') {
        const code = event.message.includes('最大步数') ? 'AGENT_LOOP_LIMIT' : 'INTERNAL_ERROR';
        await emit('run.failed', { success: false, error: { code, message: event.message } });
        process.exitCode = code === 'AGENT_LOOP_LIMIT' ? 5 : 1;
        await session.recordRun(runId, 'failed');
        terminal = true;
      }
    }
    if (!terminal) {
      await emit('run.failed', {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Agent 未产生终态事件' },
      });
      process.exitCode = 1;
      await session.recordRun(runId, 'failed');
    }
  } catch (cause) {
    const error = cause instanceof ATKAgentError
      ? cause
      : new ATKAgentError('INTERNAL_ERROR', cause instanceof Error ? cause.message : String(cause));
    if (!terminal) {
      if (initialized) await emit('run.failed', { success: false, error: { code: error.code, message: error.message } });
      else emitFallback('run.failed', { sessionId, error: { code: error.code, message: error.message } });
    }
    process.exitCode = exitCodeFor(error);
    if (initialized) await session.recordRun(runId, 'failed');
  } finally {
    clearTimeout(timeout);
    // Client exit never tears down the Session daemon, sidecar, or ATK.
    // Explicit `daemon stop --close-atk` / `session close` owns that lifecycle.
  }
}

function parseTimeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error('--timeout 必须是正整数毫秒数');
  return value;
}

function parseResult(raw: string): unknown {
  const value = raw.startsWith('Error: ') ? raw.slice(7) : raw;
  try { return JSON.parse(value); } catch { return raw; }
}

function emitFallback(type: ProductEvent['type'], payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: '1.0', sequence: 1, timestamp: new Date().toISOString(),
    runId: `run-${randomUUID()}`, type, payload,
  })}\n`);
}
