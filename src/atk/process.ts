/**
 * ATK.exe 进程管理
 *
 * 从 Python atk_connector.py 的 ATKProcess 移植。
 * 负责 spawn/kill ATK.exe 进程。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { diagnostic } from '../core/logging.js';

export class ATKProcess {
  private exePath: string;
  private process: ChildProcess | null = null;
  private managedPid: number | null = null;

  constructor(exePath: string) {
    this.exePath = exePath;
  }

  isConfigured(): boolean {
    return this.exePath.trim().length > 0;
  }

  /**
   * 启动 ATK.exe
   * @param waitSeconds 等待 ATK 启动的秒数
   * @returns 是否启动成功
   */
  async start(waitSeconds = 8): Promise<boolean> {
    if (!this.isConfigured()) {
      throw new Error('未配置 ATK_EXE_PATH');
    }
    const absPath = resolve(this.exePath);
    if (!existsSync(absPath)) {
      throw new Error(`ATK 可执行文件不存在: ${absPath}`);
    }

    try {
      // Windows: 隐藏窗口启动
      const options: Parameters<typeof spawn>[2] = {
        cwd: resolve(absPath, '..'),
        // 使用独立进程组，确保 --keep-atk-alive 后 ATK 不会随 CLI 父进程退出。
        // 仍保存精确 PID，因此正常退出和 session close 都能安全管理它。
        detached: true,
        windowsHide: false, // ATK 需要显示 GUI
        stdio: 'ignore',
      };

      this.process = spawn(absPath, [], options);
      const launcherPid = this.process.pid ?? null;
      this.managedPid = launcherPid;
      diagnostic(`[ATK Process] ATK 启动器已启动，PID: ${launcherPid}`);

      // 等待 ATK 启动完成
      await sleep(waitSeconds * 1000);
      if (process.platform === 'win32' && launcherPid) {
        const children = await findATKChildren(launcherPid);
        if (children.length > 0) this.managedPid = children[0];
      }
      diagnostic(`[ATK Process] 受管 ATK PID: ${this.managedPid}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`启动 ATK 失败: ${message}`);
    }
  }

  /**
   * 关闭 ATK 进程
   */
  async stop(): Promise<void> {
    if (!this.process) return;
    const managedProcess = this.process;
    const pid = this.managedPid ?? managedProcess.pid;

    try {
      // Windows: 用 taskkill 强制关闭进程树
      if (process.platform === 'win32') {
        if (pid) {
          await waitForChild(spawn('taskkill', ['/PID', String(pid), '/F', '/T'], {
            windowsHide: true, stdio: 'ignore',
          }));
          await waitUntilExited(pid, 5000);
        }
      } else {
        managedProcess.kill('SIGTERM');
        await waitForExit(managedProcess, 5000);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      diagnostic(`[ATK Process] 关闭失败: ${message}`);
      throw cause;
    }

    this.process = null;
    this.managedPid = null;
    diagnostic('[ATK Process] ATK 已关闭');
  }

  /**
   * 检查 ATK 是否正在运行
   */
  isRunning(): boolean {
    return this.managedPid !== null && pidExists(this.managedPid);
  }

  /**
   * 获取进程 PID
   */
  getPid(): number | null {
    return this.managedPid;
  }

  /** 保留已启动的 ATK，但释放当前 Node 进程对它的等待句柄。 */
  release(): void {
    this.process?.unref();
    this.process = null;
    this.managedPid = null;
  }
}

/** 仅供持久会话按已记录的精确 PID 关闭自己启动的 ATK。 */
export async function terminateManagedATK(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('无效的 ATK PID');
  if (process.platform === 'win32') {
    // Some ATK builds use a short-lived launcher. If an older manifest contains
    // that launcher PID, locate only its direct ATK.exe child before terminating.
    const targets = pidExists(pid) ? [pid] : await findATKChildren(pid);
    for (const target of targets) {
      await waitForChild(spawn('taskkill', ['/PID', String(target), '/F', '/T'], {
        windowsHide: true, stdio: 'ignore',
      }));
      await waitUntilExited(target, 5000);
    }
    return;
  }
  process.kill(pid, 'SIGTERM');
  await waitUntilExited(pid, 5000);
}

// ============================================================
// 辅助函数
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function findATKChildren(parentPid: number): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | `
    + "Where-Object { $_.Name -ieq 'ATK.exe' } | "
    + 'Select-Object -ExpandProperty ProcessId';
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const output = await collectOutput(child);
  return output.split(/\s+/)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
}

function collectOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { output += chunk.toString(); });
    child.once('exit', () => resolve(output));
    child.once('error', () => resolve(''));
  });
}

function waitForChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}

async function waitUntilExited(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  throw new Error(`等待 ATK 进程退出超时，PID=${pid}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => reject(new Error('等待 ATK 进程退出超时')), timeoutMs);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}
