import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { ATKInstanceBinding } from '../core/session-store.js';
import { ATKAgentError } from '../core/errors.js';

export interface ATKInstanceInfo {
  pid: number;
  parentPid: number;
  startTime: string;
  executablePath: string;
  commandLine: string;
  windowTitle: string;
  workingSetBytes: number;
  connectPorts: number[];
}

export async function listATKInstances(): Promise<ATKInstanceInfo[]> {
  if (process.platform !== 'win32') return [];
  const script = [
    "$ports = @{}",
    "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $ports[[string]$_.OwningProcess] = @($ports[[string]$_.OwningProcess]) + $_.LocalPort }",
    "$items = Get-CimInstance Win32_Process -Filter \"Name = 'ATK.exe'\" | ForEach-Object {",
    "$p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue",
    "[pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startTime=(([datetime]$_.CreationDate).ToUniversalTime().ToString('o')); executablePath=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine; windowTitle=[string]$p.MainWindowTitle; workingSetBytes=[int64]$_.WorkingSetSize; connectPorts=@($ports[[string]$_.ProcessId]) }",
    "}",
    "@($items) | ConvertTo-Json -Compress -Depth 4",
  ].join('; ');
  const output = await runPowerShell(script);
  if (!output.trim()) return [];
  const parsed = JSON.parse(output) as ATKInstanceInfo | ATKInstanceInfo[];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    ...entry,
    connectPorts: (entry.connectPorts ?? []).map(Number).filter(Number.isInteger),
  }));
}

export async function getATKInstance(pid: number): Promise<ATKInstanceInfo | null> {
  return (await listATKInstances()).find((entry) => entry.pid === pid) ?? null;
}

export function bindingFromInstance(instance: ATKInstanceInfo, startedByAgent: boolean, port: number): ATKInstanceBinding {
  return {
    startedByAgent,
    pid: instance.pid,
    startTime: instance.startTime,
    executablePath: instance.executablePath,
    connectPort: port,
    windowTitle: instance.windowTitle,
  };
}

export async function verifyInstanceBinding(
  binding: ATKInstanceBinding,
  expectedPort: number,
): Promise<ATKInstanceInfo> {
  if (!binding.pid || !binding.startTime || !binding.executablePath) {
    throw new ATKAgentError('ATTACH_FAILED', 'Session 的 ATK 绑定信息不完整，请重新执行 instance attach');
  }
  const instance = await getATKInstance(binding.pid);
  if (!instance) throw new ATKAgentError('ATTACH_FAILED', `绑定的 ATK PID ${binding.pid} 已不存在`);
  if (instance.startTime !== binding.startTime) {
    throw new ATKAgentError('ATTACH_FAILED', `PID ${binding.pid} 已被系统复用，启动时间不匹配`);
  }
  const [actualPath, expectedPath] = await Promise.all([
    canonicalPath(instance.executablePath), canonicalPath(binding.executablePath),
  ]);
  if (actualPath.toLowerCase() !== expectedPath.toLowerCase()) {
    throw new ATKAgentError('ATTACH_FAILED', `PID ${binding.pid} 的程序路径与 Session 绑定不一致`);
  }
  if (!instance.connectPorts.includes(expectedPort)) {
    throw new ATKAgentError(
      'ATTACH_FAILED',
      `PID ${binding.pid} 存活，但没有监听 Session 的 CONNECT 端口 ${expectedPort}；禁止启动第二个 ATK`,
      { instance },
    );
  }
  return instance;
}

export function instanceFingerprint(instance: ATKInstanceInfo): string {
  return createHash('sha256')
    .update(`${instance.pid}\0${instance.startTime}\0${instance.executablePath}`)
    .digest('hex');
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}

function runPowerShell(script: string): Promise<string> {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collect(child);
}

function collect(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exit ${code}`)));
  });
}
