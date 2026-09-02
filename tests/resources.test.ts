import { describe, expect, it } from 'vitest';
import { assessResourceBudget, enforceResourceBudget, estimateSceneCost } from '../src/atk/resources.js';

const limits = {
  maxAtkMemoryGB: 6,
  minSystemFreeMemoryGB: 4,
  maxGpuMemoryPercent: 80,
  maxObjectCount: 1000,
  maxEstimatedEphemerisPoints: 2_000_000,
};

const healthy = {
  timestamp: new Date(0).toISOString(),
  atkPid: 42,
  atkMemoryGB: 1,
  systemFreeMemoryGB: 8,
  systemTotalMemoryGB: 16,
  gpuDedicatedMemoryGB: 1,
  gpuTotalMemoryGB: 8,
  gpuMemoryPercent: 12.5,
};

describe('resource safety', () => {
  it('estimates the 597-object annual propagation as critical', () => {
    const estimate = estimateSceneCost({ objectCount: 597, durationSeconds: 365 * 86400, stepSeconds: 1800 });
    expect(estimate.estimatedEphemerisPoints).toBe(10_460_037);
    expect(estimate.riskLevel).toBe('critical');
    expect(estimate.recommendations).toContain('总体分布优先使用轻量点云，仅将候选对象升级为完整 Satellite');
  });

  it('warns at 80 percent and refuses at hard limits', () => {
    const warning = assessResourceBudget(healthy, limits, { objectCount: 800, estimatedEphemerisPoints: 1_600_000 });
    expect(warning.allowed).toBe(true);
    expect(warning.warnings.length).toBeGreaterThan(0);
    const blocked = assessResourceBudget({ ...healthy, systemFreeMemoryGB: 3.5 }, limits, { objectCount: 1000 });
    expect(blocked.allowed).toBe(false);
    expect(() => enforceResourceBudget(blocked)).toThrow('资源硬限制');
  });
});
