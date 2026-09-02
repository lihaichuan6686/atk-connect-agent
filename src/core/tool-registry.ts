import type { AITool, ToolExecutionContext, ToolMetadata } from '../types.js';
import type { ArtifactRecord, CommandTraceEntry, ToolExecutionEnvelope, VerificationStatus } from './contracts.js';
import { EVENT_SCHEMA_VERSION } from './contracts.js';
import { ATKAgentError, toATKAgentError } from './errors.js';
import { runWithToolExecutionContext } from './execution-context.js';

export interface CommandTraceProvider {
  traceCursor(): number;
  traceSince(cursor: number): CommandTraceEntry[];
}

export interface ToolRunOptions extends ToolExecutionContext {
  timeoutMs?: number;
}

const READ_ONLY_NAMES = new Set([
  'get_current_time', 'calculate', 'get_orbit_params',
  'list_atk_command_categories', 'search_atk_commands', 'get_atk_command_help',
  'get_satellite_position',
]);
const LOCAL_CONCURRENT_NAMES = new Set([
  'get_current_time', 'calculate', 'get_orbit_params',
  'list_atk_command_categories', 'search_atk_commands', 'get_atk_command_help',
]);

export class ToolRegistry {
  private readonly tools = new Map<string, AITool>();
  private serialTail: Promise<void> = Promise.resolve();

  constructor(
    tools: AITool[],
    private readonly traceProvider?: CommandTraceProvider,
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`重复工具名称: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  list(): AITool[] {
    return [...this.tools.values()];
  }

  get(name: string): AITool | undefined {
    return this.tools.get(name);
  }

  metadata(name: string): Required<ToolMetadata> | undefined {
    const tool = this.tools.get(name);
    return tool ? this.metadataFor(tool) : undefined;
  }

  describe(): Array<{
    name: string;
    description: string;
    parameters: AITool['parameters'];
    metadata: Required<ToolMetadata>;
  }> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      metadata: this.metadataFor(tool),
    }));
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    options: ToolRunOptions = {},
  ): Promise<ToolExecutionEnvelope> {
    const started = Date.now();
    const cursor = this.traceProvider?.traceCursor() ?? 0;
    const tool = this.tools.get(name);
    if (!tool) {
      return this.failureEnvelope(
        name,
        started,
        cursor,
        new ATKAgentError('TOOL_NOT_FOUND', `未知工具: ${name}`),
      );
    }

    const metadata = this.metadataFor(tool);
    const timeoutMs = options.timeoutMs ?? metadata.defaultTimeoutMs;
    if (options.dryRun && !metadata.readOnly) {
      return {
        schemaVersion: EVENT_SCHEMA_VERSION,
        success: true,
        executionStatus: 'dry_run',
        verificationStatus: 'not_requested',
        tool: name,
        data: { plannedTool: name, input, metadata },
        rawCommands: [],
        artifacts: [],
        warnings: ['dry-run 未修改 ATK；当前返回工具级计划，尚未展开为 CONNECT 命令'],
        durationMs: Date.now() - started,
      };
    }
    if (metadata.destructive && !options.allowDestructive) {
      return this.failureEnvelope(
        name,
        started,
        cursor,
        new ATKAgentError(
          'INVALID_INPUT',
          `工具 ${name} 是破坏性操作，需要调用方显式授权 allowDestructive`,
        ),
      );
    }
    const timeoutController = new AbortController();
    const signal = combineSignals(options.signal, timeoutController.signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const release = metadata.concurrencySafe ? undefined : await this.acquireSerial();

    try {
      const context = { ...options, signal };
      const execution = Promise.resolve(runWithToolExecutionContext(
        context,
        () => tool.execute(input, context),
      ));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timeoutController.abort();
          reject(new ATKAgentError('TIMEOUT', `工具 ${name} 执行超过 ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      });
      const raw = await Promise.race([execution, timeoutPromise]);
      const data = parseToolOutput(raw);
      const verificationStatus = inferVerification(metadata, data);
      const artifacts = extractArrayField<ArtifactRecord>(data, 'artifacts');
      const warnings = extractArrayField<string>(data, 'warnings');
      return {
        schemaVersion: EVENT_SCHEMA_VERSION,
        success: true,
        executionStatus: 'executed',
        verificationStatus,
        tool: name,
        data,
        rawCommands: this.traceProvider?.traceSince(cursor) ?? [],
        artifacts,
        warnings: [
          ...warnings,
          ...(verificationStatus === 'unverified' ? ['操作已执行，但尚未进行状态读回验证'] : []),
        ],
        durationMs: Date.now() - started,
      };
    } catch (cause) {
      return this.failureEnvelope(name, started, cursor, toATKAgentError(cause));
    } finally {
      if (timeout) clearTimeout(timeout);
      release?.();
    }
  }

  private failureEnvelope(
    name: string,
    started: number,
    cursor: number,
    error: ATKAgentError,
  ): ToolExecutionEnvelope {
    const executionStatus = error.code === 'TIMEOUT'
      ? 'timeout'
      : error.code === 'CANCELLED' ? 'cancelled' : 'failed';
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      success: false,
      executionStatus,
      verificationStatus: error.code === 'VERIFICATION_FAILED' ? 'failed' : 'not_requested',
      tool: name,
      data: null,
      rawCommands: this.traceProvider?.traceSince(cursor) ?? [],
      artifacts: [],
      warnings: [],
      durationMs: Date.now() - started,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }

  private metadataFor(tool: AITool): Required<ToolMetadata> {
    const readOnly = tool.metadata?.readOnly ?? READ_ONLY_NAMES.has(tool.name);
    return {
      readOnly,
      idempotent: tool.metadata?.idempotent ?? readOnly,
      destructive: tool.metadata?.destructive ?? false,
      concurrencySafe: tool.metadata?.concurrencySafe ?? LOCAL_CONCURRENT_NAMES.has(tool.name),
      defaultTimeoutMs: tool.metadata?.defaultTimeoutMs ?? 30_000,
      category: tool.metadata?.category ?? (tool.name.startsWith('get_') ? 'query' : 'atk'),
    };
  }

  private async acquireSerial(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.serialTail;
    this.serialTail = next;
    await previous;
    return release;
  }
}

function parseToolOutput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function inferVerification(metadata: Required<ToolMetadata>, data: unknown): VerificationStatus {
  if (metadata.readOnly) return 'not_requested';
  if (data && typeof data === 'object' && 'verification' in data) {
    const verification = (data as { verification?: unknown }).verification;
    if (verification === true || verification === 'verified') return 'verified';
    if (verification === false || verification === 'failed') return 'failed';
  }
  return 'unverified';
}

function extractArrayField<T>(data: unknown, key: string): T[] {
  if (!data || typeof data !== 'object') return [];
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as T[] : [];
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) abort();
  else {
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}
