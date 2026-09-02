/**
 * ATK 管理器 — 整合进程管理和连接
 *
 * 对外提供统一接口：启动 ATK → 连接 → 发送命令 → 关闭
 */

import { ATKProcess, terminateManagedATK } from './process.js';
import { ATKConnection, type ATKBatchCommand, type ATKBatchResult, type ATKConnectionOptions } from './connection.js';
import type { ATKCommandResult, ATKConnectionState } from '../types.js';
import type { ATKConfig } from '../config.js';
import type { CommandTraceEntry } from '../core/contracts.js';
import { diagnostic } from '../core/logging.js';
import { ATKAgentError } from '../core/errors.js';
import type { ATKInstanceBinding } from '../core/session-store.js';
import { bindingFromInstance, listATKInstances, verifyInstanceBinding } from './instances.js';

export interface ATKManagerOptions {
  allowNewATK?: boolean;
  binding?: ATKInstanceBinding;
}

export class ATKManager {
  private process: ATKProcess;
  private connection: ATKConnection;
  private startedByUs = false;
  private startupWait: number;
  private ensurePromise: Promise<void> | null = null;
  /** 当前场景名（跟踪状态） */
  currentScenario: string | null = null;
  private commandTrace: CommandTraceEntry[] = [];
  private allowNewATK: boolean;
  private binding?: ATKInstanceBinding;
  private readonly config: ATKConfig;

  constructor(config: ATKConfig, options: ATKManagerOptions = {}) {
    this.config = config;
    this.process = new ATKProcess(config.exePath);
    this.startupWait = config.startupWait;

    const connOptions: ATKConnectionOptions = {
      host: config.host,
      port: config.port,
      pythonExe: config.pythonExe,
      pythonModulePath: config.pythonModulePath,
    };
    this.connection = new ATKConnection(connOptions);
    this.allowNewATK = options.allowNewATK ?? false;
    this.binding = options.binding;
  }

  /**
   * 启动 ATK.exe（如果路径已配置）
   */
  async startATK(waitSeconds?: number): Promise<boolean> {
    if (!this.process.isConfigured()) {
      diagnostic('[ATK Manager] 未配置 ATK_EXE_PATH，跳过自动启动（请手动打开 ATK）');
      return false;
    }

    await this.process.start(waitSeconds ?? this.startupWait);
    this.startedByUs = true;
    return true;
  }

  /**
   * 连接到 ATK
   */
  async connect(maxRetries = 15): Promise<boolean> {
    return this.connection.connect(maxRetries);
  }

  /**
   * 确保 ATK 可用。先尝试连接已经运行的实例；连接失败后再自动启动 ATK。
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureConnectedOnce();
    try {
      await this.ensurePromise;
    } finally {
      this.ensurePromise = null;
    }
  }

  private async ensureConnectedOnce(): Promise<void> {
    if (this.isConnected()) return;
    if (this.binding) {
      await verifyInstanceBinding(this.binding, this.config.port);
      const connected = await this.connect(1).catch(() => false);
      if (!connected) {
        throw new ATKAgentError(
          'ATTACH_FAILED',
          `绑定的 ATK PID ${this.binding.pid} 存活，但 CONNECT 附着失败；禁止启动第二个实例`,
        );
      }
      await this.refreshScenarioName();
      return;
    }

    const instances = await listATKInstances();
    if (instances.length > 0) {
      throw new ATKAgentError(
        instances.length > 1 ? 'MULTIPLE_ATK_INSTANCES' : 'ATTACH_FAILED',
        instances.length > 1
          ? `检测到 ${instances.length} 个 ATK 实例，请先执行 instance list 和 instance attach --pid <PID>`
          : `检测到未绑定的 ATK PID ${instances[0].pid}，请显式执行 instance attach --pid ${instances[0].pid}`,
        { instances },
      );
    }
    if (!this.allowNewATK) {
      throw new ATKAgentError('ATTACH_FAILED', 'Session 未绑定 ATK；只有显式传入 --allow-new-atk 才能创建新实例');
    }
    if (!this.process.isConfigured()) throw new ATKAgentError('ATK_UNAVAILABLE', '未配置 ATK_EXE_PATH');
    await this.startATK();
    const connected = await this.connect(15).catch(() => false);
    if (!connected) throw new ATKAgentError('ATTACH_FAILED', '新 ATK 已启动，但 CONNECT 附着失败');
    const after = await listATKInstances();
    const listener = after.filter((entry) => entry.connectPorts.includes(this.config.port));
    if (listener.length !== 1) {
      throw new ATKAgentError('ATTACH_FAILED', '无法唯一确认新 ATK 与 CONNECT 端口的归属', { instances: after });
    }
    this.binding = bindingFromInstance(listener[0], true, this.config.port);
    await this.refreshScenarioName();
  }

  private async refreshScenarioName(): Promise<void> {
    const result = await this.connection.sendCommand('AllInstanceNames', '/', { timeoutMs: 5000 }).catch(() => null);
    if (!result?.success) return;
    const match = result.response.match(/\/?Scenario\/([^\s,;/]+)/i);
    this.currentScenario = match?.[1] ?? null;
  }

  /**
   * 发送 ATK 命令
   */
  async sendCommand(
    command: string,
    param = '',
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ATKCommandResult> {
    const started = Date.now();
    const result = await this.connection.sendCommand(command, param, options);
    this.commandTrace.push({
      timestamp: new Date().toISOString(),
      command,
      parameters: param,
      success: result.success,
      response: result.response,
      durationMs: Date.now() - started,
    });
    if (this.commandTrace.length > 10_000) this.commandTrace.splice(0, 1_000);
    return result;
  }

  async sendBatch(
    commands: ATKBatchCommand[],
    options: { timeoutMs?: number; signal?: AbortSignal; stopOnError?: boolean } = {},
  ): Promise<ATKBatchResult> {
    await this.ensureConnected();
    const startedAt = new Date().toISOString();
    const result = await this.connection.sendBatch(commands, options);
    const completedAt = new Date().toISOString();
    for (const entry of result.results) {
      this.commandTrace.push({
        timestamp: completedAt,
        startedAt,
        completedAt,
        command: entry.command,
        parameters: entry.param,
        success: entry.success,
        response: entry.response,
        durationMs: result.durationMs / Math.max(1, result.completed),
        atkPid: this.getManagedPid(),
        scenario: this.currentScenario,
        atkStillBusy: false,
      });
    }
    return result;
  }

  traceCursor(): number {
    return this.commandTrace.length;
  }

  traceSince(cursor: number): CommandTraceEntry[] {
    return this.commandTrace.slice(Math.max(0, cursor));
  }

  /**
   * 获取连接状态
   */
  getState(): ATKConnectionState {
    return this.connection.getState();
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.connection.isConnected();
  }

  /**
   * 关闭一切
   */
  async dispose(options: { keepATKAlive?: boolean } = {}): Promise<void> {
    await this.connection.close();
    const owned = this.binding?.startedByAgent === true;
    if (owned && !options.keepATKAlive && this.binding?.pid) {
      await verifyInstanceBinding(this.binding, this.config.port);
      await terminateManagedATK(this.binding.pid);
      this.process.release();
    } else if (this.startedByUs) {
      if (options.keepATKAlive) this.process.release();
      else await this.process.stop();
    }
  }

  wasStartedByAgent(): boolean {
    return this.binding?.startedByAgent ?? this.startedByUs;
  }

  getManagedPid(): number | null {
    return this.binding?.pid ?? this.process.getPid();
  }

  getBinding(): ATKInstanceBinding | undefined {
    return this.binding;
  }

  getSidecarPid(): number | null {
    return this.connection.getSidecarPid();
  }

  forceInterrupt(): void {
    this.connection.forceInterrupt();
  }

  setProgressHandler(handler: ((progress: Record<string, unknown>) => void) | undefined): void {
    this.connection.setProgressHandler(handler);
  }

  setBinding(binding: ATKInstanceBinding | undefined): void {
    if (this.isConnected()) throw new Error('连接已建立时不能更换 ATK 绑定');
    this.binding = binding;
  }

  setAllowNewATK(allow: boolean): void {
    this.allowNewATK = allow;
  }

  async detach(): Promise<void> {
    await this.connection.close();
    this.process.release();
    this.startedByUs = false;
    this.binding = undefined;
    this.currentScenario = null;
  }
}
