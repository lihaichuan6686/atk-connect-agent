import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/tool-registry.js';
import type { AITool } from '../src/types.js';

function makeTool(overrides: Partial<AITool> = {}): AITool {
  return {
    name: 'sample',
    description: 'sample tool',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => JSON.stringify({ status: 'success', value: 42 }),
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  it('wraps legacy tools in a stable structured envelope', async () => {
    const registry = new ToolRegistry([makeTool({ metadata: { readOnly: true } })]);
    const result = await registry.execute('sample', {});
    expect(result).toMatchObject({
      schemaVersion: '1.0',
      success: true,
      executionStatus: 'executed',
      verificationStatus: 'not_requested',
      tool: 'sample',
      data: { status: 'success', value: 42 },
    });
  });

  it('returns typed failures for missing tools', async () => {
    const result = await new ToolRegistry([]).execute('missing', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('times out slow tools with a machine-readable status', async () => {
    const registry = new ToolRegistry([makeTool({
      execute: () => new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
    })]);
    const result = await registry.execute('sample', {}, { timeoutMs: 5 });
    expect(result.success).toBe(false);
    expect(result.executionStatus).toBe('timeout');
    expect(result.error?.code).toBe('TIMEOUT');
  });

  it('never executes mutating tools during dry-run', async () => {
    let called = false;
    const registry = new ToolRegistry([makeTool({ execute: () => { called = true; return 'changed'; } })]);
    const result = await registry.execute('sample', { value: 1 }, { dryRun: true });
    expect(result.executionStatus).toBe('dry_run');
    expect(called).toBe(false);
  });

  it('requires explicit authorization for destructive tools', async () => {
    let called = false;
    const registry = new ToolRegistry([makeTool({
      metadata: { destructive: true },
      execute: () => { called = true; return 'deleted'; },
    })]);
    const denied = await registry.execute('sample', {});
    expect(denied.success).toBe(false);
    expect(called).toBe(false);
    const allowed = await registry.execute('sample', {}, { allowDestructive: true });
    expect(allowed.success).toBe(true);
    expect(called).toBe(true);
  });

  it('serializes tools that can touch ATK state', async () => {
    let active = 0;
    let maxActive = 0;
    const registry = new ToolRegistry([makeTool({
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return 'ok';
      },
    })]);
    await Promise.all([
      registry.execute('sample', {}),
      registry.execute('sample', {}),
      registry.execute('sample', {}),
    ]);
    expect(maxActive).toBe(1);
  });
});
