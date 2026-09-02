import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { ProductRuntime, getAgentDataRoot } from '../core/app-runtime.js';
import { ATKAgentError, exitCodeFor } from '../core/errors.js';
import { EVENT_SCHEMA_VERSION } from '../core/contracts.js';
import { atkCatalogStats } from '../atk/catalog/catalog.js';
import { VERSION } from '../version.js';
import { startATKMCPServer } from '../mcp/server.js';
import { SessionStore } from '../core/session-store.js';
import { terminateManagedATK } from '../atk/process.js';
import { daemonRequest, daemonStatus, ensureDaemon } from '../daemon/client.js';
import type { DaemonExecuteResult } from '../daemon/protocol.js';

interface ToolCallOptions {
  jsonArgs?: string;
  input?: string;
  session?: string;
  timeout?: string;
  keepAtkAlive?: boolean;
  dryRun?: boolean;
  allowDestructive?: boolean;
  allowNewAtk?: boolean;
}

export function registerProductCommands(program: Command): void {
  program.command('mcp')
    .description('以标准 MCP stdio Server 运行 ATK 工具')
    .option('--transport <transport>', '传输方式（当前支持 stdio）', 'stdio')
    .option('--session <id>', '持久会话 ID')
    .option('--keep-atk-alive', 'MCP 退出后保留由本次启动的 ATK')
    .action(async (options: { transport: string; session?: string; keepAtkAlive?: boolean }) => {
      if (options.transport !== 'stdio') {
        process.stderr.write('当前只支持 MCP stdio transport\n');
        process.exitCode = 2;
        return;
      }
      await startATKMCPServer({ sessionId: options.session, keepATKAlive: options.keepAtkAlive });
    });

  const tool = program.command('tool').description('确定性工具直调（不经过 LLM）');

  tool.command('list')
    .description('列出所有可直接调用的工具及其 schema')
    .option('--json', '输出 JSON', true)
    .action(async () => {
      const runtime = new ProductRuntime();
      try {
        process.stdout.write(`${JSON.stringify({
          schemaVersion: EVENT_SCHEMA_VERSION,
          agentVersion: VERSION,
          tools: runtime.registry.describe(),
        }, null, 2)}\n`);
      } finally {
        await runtime.dispose();
      }
    });

  tool.command('call <name>')
    .description('直接执行指定工具')
    .option('--json-args <json>', 'JSON 参数对象', '{}')
    .option('--input <path>', '从 JSON 文件读取参数')
    .option('--session <id>', '持久会话 ID')
    .option('--timeout <ms>', '超时毫秒数', '30000')
    .option('--keep-atk-alive', '任务结束后保留由本次启动的 ATK')
    .option('--dry-run', '只规划操作，不修改 ATK')
    .option('--allow-destructive', '显式允许破坏性工具')
    .option('--allow-new-atk', 'Session 未绑定且没有 ATK 时，显式允许创建新实例')
    .action(async (name: string, options: ToolCallOptions) => {
      const sessionId = options.session ?? `tool-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      let runtime: ProductRuntime | null = null;
      try {
        const input = await loadInput(options);
        const timeoutMs = parsePositiveInt(options.timeout ?? '30000', 'timeout');
        if (options.session) {
          await ensureDaemon(getAgentDataRoot(), sessionId);
          const remote = await daemonRequest<DaemonExecuteResult>(getAgentDataRoot(), sessionId, 'execute', {
            tool: name, input, dryRun: options.dryRun,
            allowDestructive: options.allowDestructive,
            allowNewATK: options.allowNewAtk,
            operationTimeoutMs: 24 * 60 * 60 * 1000,
          }, timeoutMs);
          process.stdout.write(`${JSON.stringify(remote.envelope)}\n`);
          if (!remote.envelope.success && remote.envelope.error) {
            process.exitCode = exitCodeFor(new ATKAgentError(remote.envelope.error.code, remote.envelope.error.message));
          }
          return;
        }
        runtime = new ProductRuntime({ sessionId, allowNewATK: options.allowNewAtk });
        await runtime.initialize();
        await runtime.session.appendEvent(runId, 'run.started', { mode: 'tool', tool: name, input });
        await runtime.session.appendEvent(runId, 'tool.started', { tool: name, input });
        const result = await runtime.executeTool(name, input, {
          caller: 'cli', sessionId, runId, timeoutMs, dryRun: options.dryRun,
          allowDestructive: options.allowDestructive,
        });
        await runtime.session.appendEvent(
          runId,
          result.success ? 'run.finished' : result.executionStatus === 'cancelled' ? 'run.cancelled' : 'run.failed',
          { result },
        );
        await runtime.session.recordRun(runId, result.success ? 'completed' : result.executionStatus);
        await runtime.session.updateRuntimeState({
          currentScenario: runtime.manager.currentScenario,
          atk: { startedByAgent: runtime.manager.wasStartedByAgent(), pid: runtime.manager.getManagedPid() },
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (!result.success && result.error) {
          process.exitCode = exitCodeFor(new ATKAgentError(result.error.code, result.error.message));
        }
      } catch (cause) {
        const error = cause instanceof ATKAgentError
          ? cause
          : new ATKAgentError('INVALID_INPUT', cause instanceof Error ? cause.message : String(cause));
        process.stdout.write(`${JSON.stringify({
          schemaVersion: EVENT_SCHEMA_VERSION,
          success: false,
          executionStatus: 'failed',
          tool: name,
          error: { code: error.code, message: error.message },
        })}\n`);
        process.exitCode = exitCodeFor(error);
      } finally {
        if (runtime) await runtime.dispose({ keepATKAlive: options.keepAtkAlive });
      }
    });

  program.command('capabilities')
    .description('输出 Agent、工具和官方 CONNECT 覆盖能力')
    .option('--json', '输出 JSON', true)
    .action(async () => {
      const runtime = new ProductRuntime();
      try {
        process.stdout.write(`${JSON.stringify({
          schemaVersion: EVENT_SCHEMA_VERSION,
          agentVersion: VERSION,
          interfaces: { tui: true, classic: true, toolCli: true, jsonl: true, mcpStdio: true },
          officialConnect: {
            files: atkCatalogStats.files,
            entries: atkCatalogStats.entries,
            commandEntries: atkCatalogStats.commandEntries,
            uniqueCommands: atkCatalogStats.uniqueCommands,
            categories: atkCatalogStats.categories,
            commands: atkCatalogStats.commands,
          },
          tools: runtime.registry.describe(),
        }, null, 2)}\n`);
      } finally {
        await runtime.dispose();
      }
    });

  program.command('health')
    .description('机器可读的本地配置和 ATK 健康检查')
    .option('--json', '输出 JSON', true)
    .option('--connect', '实际连接或启动 ATK 进行探测')
    .option('--no-llm', '不调用模型 API', true)
    .action(async (options: { connect?: boolean }) => {
      const config = loadConfig();
      const runtime = new ProductRuntime({ config });
      let atkVersion: string | null = null;
      let objectCount: number | null = null;
      let error: string | null = null;
      try {
        if (options.connect) {
          const version = await runtime.executeTool('execute_atk_connect_command', {
            command: 'GetATKVersion', parameters: '/',
          }, { caller: 'cli', timeoutMs: 60_000 });
          if (version.success) atkVersion = extractResponse(version.data);
          else error = version.error?.message ?? 'ATK 探测失败';
          if (!error) {
            const objects = await runtime.executeTool('execute_atk_connect_command', {
              command: 'AllInstanceNames', parameters: '/',
            }, { caller: 'cli', timeoutMs: 30_000 });
            if (objects.success) {
              const response = extractResponse(objects.data);
              objectCount = (response.match(/\*?\/[^\s,;]+/g) ?? []).length;
            }
          }
        }
        const healthy = !error
          && Boolean(config.atk.pythonModulePath)
          && Boolean(config.atk.pythonExe)
          && existsSync(config.atk.pythonModulePath)
          && existsSync(config.atk.pythonExe);
        process.stdout.write(`${JSON.stringify({
          schemaVersion: EVENT_SCHEMA_VERSION,
          healthy,
          agentVersion: VERSION,
          llm: {
            provider: config.llm.provider,
            configured: config.llm.provider === 'ollama' || Boolean(config.llm.apiKey),
            reachable: null,
            checked: false,
          },
          sidecar: {
            pythonConfigured: Boolean(config.atk.pythonExe),
            pythonExists: existsSync(config.atk.pythonExe),
            moduleConfigured: Boolean(config.atk.pythonModulePath),
            moduleExists: existsSync(config.atk.pythonModulePath),
          },
          atk: {
            executableConfigured: Boolean(config.atk.exePath),
            executableExists: existsSync(config.atk.exePath),
            connected: runtime.manager.isConnected(),
            checked: Boolean(options.connect),
            version: atkVersion,
            objectCount,
            error,
          },
          dataRoot: getAgentDataRoot(),
        }, null, 2)}\n`);
        if (!healthy) process.exitCode = error ? 3 : 2;
      } finally {
        await runtime.dispose();
      }
    });

  const session = program.command('session').description('管理持久 ATK Agent 会话');
  session.command('list')
    .description('列出当前任务目录中的会话')
    .action(async () => {
      const root = getAgentDataRoot();
      const sessionsDir = resolve(root, 'sessions');
      let ids: string[] = [];
      try { ids = await readdir(sessionsDir); } catch { /* 尚无会话 */ }
      const manifests = [];
      for (const id of ids) {
        try {
          const store = new SessionStore(root, id, VERSION);
          const manifest = await store.readManifest();
          if (manifest) manifests.push(manifest);
        } catch { /* 跳过非法或损坏目录 */ }
      }
      manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      process.stdout.write(`${JSON.stringify({ schemaVersion: EVENT_SCHEMA_VERSION, sessions: manifests }, null, 2)}\n`);
    });

  session.command('status <id>')
    .description('读取指定会话 manifest')
    .action(async (id: string) => {
      const store = new SessionStore(getAgentDataRoot(), id, VERSION);
      const manifest = await store.readManifest();
      if (!manifest) {
        process.stdout.write(`${JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: `会话不存在: ${id}` } })}\n`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    });

  session.command('resume <id>')
    .description('重新激活会话并返回恢复信息；后续 tool/run 命令继续使用同一 --session')
    .action(async (id: string) => {
      const store = new SessionStore(getAgentDataRoot(), id, VERSION);
      const manifest = await store.readManifest();
      if (!manifest) {
        process.stdout.write(`${JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: `会话不存在: ${id}` } })}\n`);
        process.exitCode = 2;
        return;
      }
      await store.writeManifest({ ...manifest, status: 'active' });
      process.stdout.write(`${JSON.stringify({
        success: true,
        sessionId: id,
        currentScenario: manifest.currentScenario ?? null,
        atk: manifest.atk ?? null,
        next: `在后续命令中添加 --session ${id}`,
      }, null, 2)}\n`);
    });

  session.command('close <id>')
    .description('关闭会话；默认结束该会话启动并记录的 ATK 进程')
    .option('--keep-atk-alive', '只关闭会话记录，不结束 ATK')
    .action(async (id: string, options: { keepAtkAlive?: boolean }) => {
      const store = new SessionStore(getAgentDataRoot(), id, VERSION);
      const manifest = await store.readManifest();
      if (!manifest) {
        process.stdout.write(`${JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: `会话不存在: ${id}` } })}\n`);
        process.exitCode = 2;
        return;
      }
      let stoppedPid: number | null = null;
      const daemon = await daemonStatus(getAgentDataRoot(), id);
      if (daemon) {
        await daemonRequest(getAgentDataRoot(), id, 'stop', { keepATKAlive: options.keepAtkAlive === true });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && await daemonStatus(getAgentDataRoot(), id)) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (!options.keepAtkAlive && manifest.atk?.startedByAgent) stoppedPid = manifest.atk.pid;
      } else if (!options.keepAtkAlive && manifest.atk?.startedByAgent && manifest.atk.pid) {
        await terminateManagedATK(manifest.atk.pid);
        stoppedPid = manifest.atk.pid;
      }
      await store.close('closed');
      process.stdout.write(`${JSON.stringify({ success: true, sessionId: id, stoppedPid })}\n`);
    });

  session.command('detach <id>')
    .description('断开 Session 与 ATK 的连接和绑定，但保留 ATK 进程')
    .action(async (id: string) => {
      await ensureDaemon(getAgentDataRoot(), id);
      const result = await daemonRequest(getAgentDataRoot(), id, 'detach');
      process.stdout.write(`${JSON.stringify({ success: true, sessionId: id, result })}\n`);
    });
}

async function loadInput(options: ToolCallOptions): Promise<Record<string, unknown>> {
  if (options.input && options.jsonArgs && options.jsonArgs !== '{}') {
    throw new Error('--input 和 --json-args 不能同时使用');
  }
  const raw = options.input ? await readFile(options.input, 'utf8') : options.jsonArgs ?? '{}';
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工具参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function extractResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const response = (data as { response?: unknown }).response;
  return typeof response === 'string' ? response.trim() : '';
}
