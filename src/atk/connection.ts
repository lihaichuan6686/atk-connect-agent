/**
 * ATK 连接管理器
 *
 * 通过 spawn Python sidecar 子进程，桥接 ATK 官方 ATKConnectModule。
 * 通信协议：JSON-RPC over stdio（每行一个 JSON 请求/响应）。
 *
 * 这是过渡方案（阶段5会替换为 C++ Node-API 原生插件）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import type { ATKCommandResult, ATKConnectionState } from '../types.js';
import { diagnostic, diagnosticError } from '../core/logging.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// sidecar 脚本路径（native/atk_sidecar.py）
const SIDECAR_SCRIPT = resolve(__dirname, '..', '..', 'native', 'atk_sidecar.py');

// JSON-RPC 请求/响应类型
interface RPCRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface RPCResponse {
  id: number | null;
  result?: unknown;
  error?: { message: string };
}

export interface ATKBatchCommand {
  command: string;
  param: string;
}

export interface ATKBatchResult {
  success: boolean;
  succeeded: number;
  failed: number;
  completed: number;
  total: number;
  durationMs: number;
  results: Array<{ index: number; command: string; param: string; success: boolean; response: string }>;
}

export interface ATKConnectionOptions {
  host: string;
  port: number;
  /** Python 解释器路径 */
  pythonExe: string;
  /** ATK Python 模块路径（ATKConnectModule 所在目录） */
  pythonModulePath: string;
}

export class ATKConnection {
  private options: ATKConnectionOptions;
  private sidecar: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (response: RPCResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  private conId = -1;
  private state: ATKConnectionState = 'disconnected';
  private sidecarReady = false;
  private progressHandler?: (progress: Record<string, unknown>) => void;

  constructor(options: ATKConnectionOptions) {
    this.options = options;
  }

  /**
   * 启动 Python sidecar 子进程
   */
  async startSidecar(): Promise<void> {
    if (this.sidecar) return;

    // 验证 sidecar 脚本存在
    if (!existsSync(SIDECAR_SCRIPT)) {
      throw new Error(`Sidecar 脚本不存在: ${SIDECAR_SCRIPT}`);
    }

    // 验证 ATK Python 模块路径
    if (!this.options.pythonModulePath || !existsSync(this.options.pythonModulePath)) {
      throw new Error(
        `ATK Python 模块路径无效: ${this.options.pythonModulePath}\n` +
        `请在 .env 中设置 ATK_PYTHON_PATH 为 ATKConnectModule 所在目录`,
      );
    }

    diagnostic(`[ATK Connection] 启动 Python sidecar...`);
    diagnostic(`[ATK Connection] Python: ${this.options.pythonExe}`);
    diagnostic(`[ATK Connection] ATK 模块: ${this.options.pythonModulePath}`);

    this.sidecarReady = false;
    this.sidecar = spawn(this.options.pythonExe, [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ATK_PYTHON_PATH: this.options.pythonModulePath,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    // 设置 readline 读取 stdout
    this.rl = readline.createInterface({
      input: this.sidecar.stdout!,
      crlfDelay: Infinity,
    });

    // 处理 sidecar 响应
    this.rl.on('line', (line: string) => {
      this.handleSidecarOutput(line);
    });

    // stderr 转发为日志
    const stderr_rl = readline.createInterface({
      input: this.sidecar.stderr!,
      crlfDelay: Infinity,
    });
    stderr_rl.on('line', (line: string) => {
      if (line.includes('[sidecar]')) {
        diagnostic(`  ${line}`);
      }
    });

    // sidecar 异常退出
    this.sidecar.on('error', (err) => {
      diagnosticError(`[ATK Connection] Sidecar 错误: ${err.message}`);
      this.state = 'error';
      this.rejectAllPending(err);
    });

    this.sidecar.on('exit', (code) => {
      diagnostic(`[ATK Connection] Sidecar 退出 (code=${code})`);
      this.state = 'disconnected';
      this.sidecarReady = false;
      this.sidecar = null;
      this.rejectAllPending(new Error(`Sidecar 进程退出 (code=${code})`));
    });

    // 等待 ready 信号
    await this.waitForReady();
  }

  /**
   * 等待 sidecar 发送 ready 信号
   */
  private async waitForReady(): Promise<void> {
    if (this.sidecarReady) return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('response', checkReady);
        reject(new Error('等待 Sidecar 启动超时'));
      }, 10000);

      const checkReady = (response: RPCResponse) => {
        if (response.result && (response.result as { status?: string }).status === 'ready') {
          clearTimeout(timeout);
          this.off('response', checkReady);
          diagnostic(`[ATK Connection] Sidecar 就绪`);
          resolve();
        }
      };

      this.on('response', checkReady);
    });
  }

  /**
   * 连接到 ATK（调用 sidecar 的 open 方法）
   */
  async connect(maxRetries = 15): Promise<boolean> {
    if (!this.sidecar) {
      await this.startSidecar();
    }

    this.state = 'connecting';

    const response = await this.call('open', {
      host: this.options.host,
      port: this.options.port,
      maxRetries,
    });

    if (response.error) {
      this.state = 'error';
      throw new Error(`ATK 连接失败: ${response.error.message}`);
    }

    const result = response.result as { conId: number; success: boolean };
    if (!result.success) {
      this.state = 'error';
      return false;
    }

    this.conId = result.conId;
    this.state = 'connected';
    diagnostic(`[ATK Connection] ATK 连接成功, conId=${this.conId}`);
    return true;
  }

  /**
   * 发送 ATK 命令
   * @param command 命令名称（如 New, SetState, Animate）
   * @param param 参数字符串（如 "/ Scenario Test"）
   */
  async sendCommand(
    command: string,
    param = '',
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ATKCommandResult> {
    if (this.state !== 'connected' || this.conId < 0) {
      return {
        success: false,
        response: '未连接到 ATK',
        command,
        param,
      };
    }

    const response = await this.call('connect', {
      conId: this.conId,
      command,
      param,
    }, options);

    if (response.error) {
      return {
        success: false,
        response: `ERROR: ${response.error.message}`,
        command,
        param,
      };
    }

    const result = response.result as { response: string; success: boolean };
    return {
      success: result.success,
      response: result.response,
      command,
      param,
    };
  }

  async sendBatch(
    commands: ATKBatchCommand[],
    options: { timeoutMs?: number; signal?: AbortSignal; stopOnError?: boolean } = {},
  ): Promise<ATKBatchResult> {
    if (!this.isConnected()) throw new Error('未连接到 ATK');
    const response = await this.call('batch_connect', {
      conId: this.conId,
      commands,
      stopOnError: options.stopOnError ?? true,
    }, options);
    if (response.error) throw new Error(response.error.message);
    return response.result as ATKBatchResult;
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    if (this.conId >= 0) {
      try {
        await this.call('close', { conId: this.conId });
      } catch {
        // 忽略关闭错误
      }
      this.conId = -1;
    }

    this.state = 'disconnected';
    this.sidecarReady = false;

    if (this.sidecar) {
      this.sidecar.kill();
      this.sidecar = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * 获取当前连接状态
   */
  getState(): ATKConnectionState {
    return this.state;
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.state === 'connected' && this.conId > 0;
  }

  /**
   * 获取连接 ID
   */
  getConId(): number {
    return this.conId;
  }

  getSidecarPid(): number | null {
    return this.sidecar?.pid ?? null;
  }

  setProgressHandler(handler: ((progress: Record<string, unknown>) => void) | undefined): void {
    this.progressHandler = handler;
  }

  /**
   * Break the blocking Python bridge. This cancels the client-side CONNECT call,
   * but cannot claim the ATK calculation itself has stopped.
   */
  forceInterrupt(): void {
    this.rejectAllPending(new Error('CONNECT bridge interrupted'));
    this.sidecar?.kill();
    this.sidecar = null;
    this.conId = -1;
    this.state = 'error';
  }

  // ============================================================
  // JSON-RPC 内部实现
  // ============================================================

  private eventHandlers = new Map<string, ((response: RPCResponse) => void)[]>();

  private on(event: string, handler: (response: RPCResponse) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  private off(event: string, handler: (response: RPCResponse) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  private emit(event: string, response: RPCResponse): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const h of handlers) h(response);
    }
  }

  /**
   * 处理 sidecar stdout 输出
   */
  private handleSidecarOutput(line: string): void {
    let response: RPCResponse;
    try {
      response = JSON.parse(line);
    } catch {
      // 非 JSON 输出，忽略
      return;
    }

    // 触发 response 事件（供 waitForReady 使用）
    if (response.result && (response.result as { status?: string }).status === 'ready') {
      this.sidecarReady = true;
    }
    this.emit('response', response);
    if (response.id === null && response.result && typeof response.result === 'object'
      && (response.result as { type?: unknown }).type === 'progress') {
      this.progressHandler?.(response.result as Record<string, unknown>);
    }

    // 匹配 pending 请求
    if (response.id !== null && response.id !== undefined) {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    }
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private call(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<RPCResponse> {
    return new Promise((resolve, reject) => {
      if (!this.sidecar || !this.sidecar.stdin) {
        reject(new Error('Sidecar 未启动'));
        return;
      }

      const id = ++this.requestId;
      const request: RPCRequest = { id, method, params };
      if (options.signal?.aborted) {
        reject(new Error(`请求已取消: ${method}`));
        return;
      }

      // 超时处理（30秒）
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, options.timeoutMs ?? 30000);

      const onAbort = () => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`请求已取消: ${method}`));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingRequests.set(id, {
        resolve, reject, timeout, signal: options.signal, onAbort: options.signal ? onAbort : undefined,
      });

      const line = JSON.stringify(request) + '\n';
      this.sidecar.stdin.write(line);
    });
  }

  /**
   * 拒绝所有 pending 请求
   */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
