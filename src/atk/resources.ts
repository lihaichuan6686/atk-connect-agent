import { freemem, totalmem } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ResourceLimits } from '../config.js';
import { getATKInstance } from './instances.js';
import { ATKAgentError } from '../core/errors.js';

export interface ResourceSnapshot {
  timestamp: string;
  atkPid: number | null;
  atkMemoryGB: number | null;
  systemFreeMemoryGB: number;
  systemTotalMemoryGB: number;
  gpuDedicatedMemoryGB: number | null;
  gpuTotalMemoryGB: number | null;
  gpuMemoryPercent: number | null;
}

export interface SceneCostEstimate {
  objectCount: number;
  durationSeconds: number;
  stepSeconds: number;
  pointsPerObject: number;
  estimatedEphemerisPoints: number;
  estimatedEphemerisMemoryGB: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
}

export async function getResourceSnapshot(atkPid: number | null): Promise<ResourceSnapshot> {
  const instance = atkPid ? await getATKInstance(atkPid) : null;
  const gpu = atkPid ? await queryGpuMemory(atkPid) : null;
  const bytesPerGB = 1024 ** 3;
  return {
    timestamp: new Date().toISOString(),
    atkPid,
    atkMemoryGB: instance ? instance.workingSetBytes / bytesPerGB : null,
    systemFreeMemoryGB: freemem() / bytesPerGB,
    systemTotalMemoryGB: totalmem() / bytesPerGB,
    gpuDedicatedMemoryGB: gpu ? gpu.usedBytes / bytesPerGB : null,
    gpuTotalMemoryGB: gpu?.totalBytes ? gpu.totalBytes / bytesPerGB : null,
    gpuMemoryPercent: gpu?.totalBytes ? gpu.usedBytes / gpu.totalBytes * 100 : null,
  };
}

export function estimateSceneCost(input: {
  objectCount: number;
  durationSeconds: number;
  stepSeconds: number;
  bytesPerPoint?: number;
}): SceneCostEstimate {
  const objectCount = positiveInteger(input.objectCount, 'objectCount');
  const durationSeconds = positive(input.durationSeconds, 'durationSeconds');
  const stepSeconds = positive(input.stepSeconds, 'stepSeconds');
  const pointsPerObject = Math.floor(durationSeconds / stepSeconds) + 1;
  const estimatedEphemerisPoints = objectCount * pointsPerObject;
  const estimatedEphemerisMemoryGB = estimatedEphemerisPoints * (input.bytesPerPoint ?? 96) / 1024 ** 3;
  const riskLevel = estimatedEphemerisPoints >= 10_000_000 ? 'critical'
    : estimatedEphemerisPoints >= 2_000_000 ? 'high'
      : estimatedEphemerisPoints >= 500_000 ? 'medium' : 'low';
  const recommendations: string[] = [];
  if (riskLevel === 'high' || riskLevel === 'critical') {
    recommendations.push('缩短分析窗口或增大传播步长');
    recommendations.push('总体分布优先使用轻量点云，仅将候选对象升级为完整 Satellite');
    recommendations.push('将目录拆分为多个批次，并在批次间检查资源预算');
  }
  return { objectCount, durationSeconds, stepSeconds, pointsPerObject, estimatedEphemerisPoints, estimatedEphemerisMemoryGB, riskLevel, recommendations };
}

export function assessResourceBudget(
  snapshot: ResourceSnapshot,
  limits: ResourceLimits,
  scene?: { objectCount?: number; estimatedEphemerisPoints?: number },
): { allowed: boolean; warnings: string[]; violations: string[] } {
  const warnings: string[] = [];
  const violations: string[] = [];
  checkUpper('ATK 内存', snapshot.atkMemoryGB, limits.maxAtkMemoryGB, 'GB', warnings, violations);
  if (snapshot.systemFreeMemoryGB < limits.minSystemFreeMemoryGB) {
    violations.push(`系统剩余内存 ${snapshot.systemFreeMemoryGB.toFixed(2)} GB 低于硬限制 ${limits.minSystemFreeMemoryGB} GB`);
  } else if (snapshot.systemFreeMemoryGB < limits.minSystemFreeMemoryGB * 1.25) {
    warnings.push(`系统剩余内存仅 ${snapshot.systemFreeMemoryGB.toFixed(2)} GB`);
  }
  checkUpper('GPU 显存', snapshot.gpuMemoryPercent, limits.maxGpuMemoryPercent, '%', warnings, violations);
  checkUpper('对象数量', scene?.objectCount, limits.maxObjectCount, '', warnings, violations);
  checkUpper('预计星历点', scene?.estimatedEphemerisPoints, limits.maxEstimatedEphemerisPoints, '', warnings, violations);
  if (snapshot.gpuMemoryPercent === null) warnings.push('当前系统无法读取 ATK GPU 显存计数器，将继续监控内存和对象规模');
  return { allowed: violations.length === 0, warnings, violations };
}

export function enforceResourceBudget(assessment: ReturnType<typeof assessResourceBudget>): void {
  if (!assessment.allowed) throw new ATKAgentError('RESOURCE_LIMIT', '资源硬限制阻止了本次操作', assessment);
}

function checkUpper(label: string, value: number | null | undefined, limit: number, unit: string, warnings: string[], violations: string[]): void {
  if (value === null || value === undefined) return;
  if (value >= limit) violations.push(`${label} ${value.toFixed(2)}${unit} 达到硬限制 ${limit}${unit}`);
  else if (value >= limit * 0.8) warnings.push(`${label} ${value.toFixed(2)}${unit} 已达到限制的 80%`);
}

async function queryGpuMemory(pid: number): Promise<{ usedBytes: number; totalBytes: number } | null> {
  if (process.platform !== 'win32') return null;
  const script = `$used = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'pid_${pid}_' } | Measure-Object -Property DedicatedUsage -Sum).Sum; $total = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Measure-Object -Property AdapterRAM -Sum).Sum; [pscustomobject]@{used=[int64]$used;total=[int64]$total} | ConvertTo-Json -Compress`;
  try {
    const output = await collect(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    const parsed = JSON.parse(output) as { used?: number; total?: number };
    return { usedBytes: Number(parsed.used ?? 0), totalBytes: Number(parsed.total ?? 0) };
  } catch { return null; }
}

function collect(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`PowerShell exit ${code}`)));
  });
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new ATKAgentError('INVALID_INPUT', `${name} 必须是正数`);
  return value;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new ATKAgentError('INVALID_INPUT', `${name} 必须是正整数`);
  return value;
}
