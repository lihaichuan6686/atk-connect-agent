import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import type { DaemonMethod, DaemonRequest, DaemonResponse, DaemonStatus } from './protocol.js';
import { daemonEndpoint } from './protocol.js';
import { ATKAgentError } from '../core/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function daemonRequest<T>(
  dataRoot: string,
  sessionId: string,
  method: DaemonMethod,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const endpoint = daemonEndpoint(dataRoot, sessionId);
  return new Promise<T>((resolvePromise, reject) => {
    const socket = connect(endpoint);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new ATKAgentError('DAEMON_UNAVAILABLE', `daemon 请求超时: ${method}`));
    }, timeoutMs);
    const finishError = (cause: unknown) => {
      clearTimeout(timeout);
      reject(cause instanceof ATKAgentError ? cause : new ATKAgentError(
        'DAEMON_UNAVAILABLE',
        `Session daemon 不可用: ${sessionId} (${cause instanceof Error ? cause.message : String(cause)})`,
        undefined,
        { cause },
      ));
    };
    socket.setEncoding('utf8');
    socket.once('error', finishError);
    socket.once('connect', () => {
      const request: DaemonRequest = { id: randomUUID(), method, params };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as DaemonResponse;
        if (!response.success) {
          reject(new ATKAgentError(
            (response.error?.code ?? 'INTERNAL_ERROR') as ConstructorParameters<typeof ATKAgentError>[0],
            response.error?.message ?? 'daemon 请求失败',
            response.error?.details,
          ));
        } else resolvePromise(response.result as T);
      } catch (cause) { finishError(cause); }
    });
  });
}

export async function daemonStatus(
  dataRoot: string,
  sessionId: string,
  expectedStartingPid?: number,
): Promise<DaemonStatus | null> {
  try { return await daemonRequest<DaemonStatus>(dataRoot, sessionId, 'status', {}, 1500); }
  catch (cause) {
    const mismatch = detectDaemonPermissionMismatch(dataRoot, sessionId, cause, expectedStartingPid);
    if (mismatch) throw mismatch;
    return null;
  }
}

export async function ensureDaemon(dataRoot: string, sessionId: string): Promise<DaemonStatus> {
  const existing = await daemonStatus(dataRoot, sessionId);
  if (existing) return existing;
  const entry = resolve(__dirname, '..', 'index.js');
  const sessionDir = resolve(dataRoot, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const logFd = openSync(resolve(sessionDir, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [entry, 'daemon', 'serve', '--session', sessionId], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    cwd: process.cwd(),
    env: { ...process.env, ATK_AGENT_HOME: dataRoot },
  });
  closeSync(logFd);
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    const status = await daemonStatus(dataRoot, sessionId, child.pid);
    if (status) return status;
  }
  throw new ATKAgentError('DAEMON_UNAVAILABLE', `Session daemon 启动超时: ${sessionId}`);
}

function detectDaemonPermissionMismatch(
  dataRoot: string,
  sessionId: string,
  cause: unknown,
  expectedStartingPid?: number,
): ATKAgentError | null {
  if (process.platform !== 'win32') return null;
  const sessionDir = resolve(dataRoot, 'sessions', sessionId);
  const metadataPath = resolve(sessionDir, 'daemon.json');
  const lockPath = resolve(sessionDir, '.lock');
  if (!existsSync(metadataPath) || !existsSync(lockPath)) return null;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { pid?: unknown; endpoint?: unknown };
    if (typeof metadata.pid !== 'number' || !Number.isInteger(metadata.pid) || metadata.pid <= 0 || !isProcessAlive(metadata.pid)) return null;
    if (metadata.pid === expectedStartingPid) return null;
    return new ATKAgentError(
      'DAEMON_PERMISSION_MISMATCH',
      `Session daemon PID ${metadata.pid} 仍在运行，但当前 CLI 无法访问其 Windows 命名管道。请让 daemon 与后续 CLI/ATK 调用保持相同权限级别；不会尝试启动第二个 daemon。`,
      {
        sessionId,
        daemonPid: metadata.pid,
        endpoint: metadata.endpoint,
        originalError: cause instanceof Error ? cause.message : String(cause),
      },
      { cause: cause instanceof Error ? cause : undefined },
    );
  } catch { return null; }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === 'EPERM'; }
}
