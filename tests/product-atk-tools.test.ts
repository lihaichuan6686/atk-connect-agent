import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductATKTools } from '../src/atk/tools/product.js';
import type { ATKManager } from '../src/atk/manager.js';
import { SessionStore } from '../src/core/session-store.js';
import type { ATKCommandResult } from '../src/types.js';

class FakeManager {
  currentScenario: string | null = null;
  commands: Array<{ command: string; parameters: string }> = [];
  objects = new Set<string>();
  async ensureConnected() {}
  isConnected() { return true; }
  getState() { return 'connected' as const; }
  wasStartedByAgent() { return false; }
  getManagedPid() { return null; }
  getBinding() { return undefined; }
  async sendCommand(command: string, parameters = ''): Promise<ATKCommandResult> {
    this.commands.push({ command, parameters });
    if (command === 'SaveAs') {
      const file = /"([^"]+)"\s*$/.exec(parameters)?.[1];
      if (!file) return { success: false, response: 'NACK' };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '<Scenario><Satellite Name="DemoSat"><GfxShow>1</GfxShow><GfxShowLabel>1</GfxShowLabel><GfxShowOrbit>1</GfxShowOrbit><GfxColor>4</GfxColor><GfxModel ShowModel="0" ShowPoint="1" PointSize="8"/><PositionX>7000000</PositionX><PositionY>0</PositionY><PositionZ>0</PositionZ></Satellite></Scenario>', 'utf8');
      return { success: true, response: 'ACK' };
    }
    if (command === 'DoesObjExist') {
      const path = parameters.replace(/^\/\s*/, '');
      return { success: true, response: this.objects.has(path) ? '1' : '0' };
    }
    if (command === 'New') {
      const match = parameters.match(/^\/ Scenario ([A-Za-z0-9_]+)/);
      if (match) this.objects.add(`*/Scenario/${match[1]}`);
    }
    if (command === 'GetATKVersion') return { success: true, response: 'ATK 4.0.0' };
    if (command === 'GetAnimationData') return { success: true, response: '"start","stop"' };
    if (command === 'AllInstanceNames') {
      return {
        success: true,
        response: '/Scenario/Demo /Scenario/Demo/Satellite/RollbackSat',
      };
    }
    return { success: true, response: 'ACK' };
  }
  async sendBatch(commands: Array<{ command: string; param: string }>) {
    const started = Date.now();
    const results = [];
    for (let index = 0; index < commands.length; index++) {
      const item = commands[index];
      const result = await this.sendCommand(item.command, item.param);
      results.push({ index, command: item.command, param: item.param, response: result.response, success: result.success });
    }
    const succeeded = results.filter((entry) => entry.success).length;
    return { success: succeeded === results.length, succeeded, failed: results.length - succeeded, completed: results.length, total: results.length, durationMs: Date.now() - started, results };
  }
}

describe('product ATK tools', () => {
  it('ensures a scenario idempotently and verifies it by reading ATK state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-product-tools-'));
    const session = new SessionStore(root, 'test', 'test');
    await session.initialize();
    const manager = new FakeManager();
    const tool = createProductATKTools(manager as unknown as ATKManager, session, defaultLimits)
      .find((candidate) => candidate.name === 'ensure_scenario')!;
    const first = JSON.parse(String(await tool.execute({ name: 'Demo' })));
    const second = JSON.parse(String(await tool.execute({ name: 'Demo' })));
    expect(first).toMatchObject({ created: true, verification: true });
    expect(second).toMatchObject({ created: false, verification: true });
    expect(manager.commands.filter((entry) => entry.command === 'New')).toHaveLength(1);
  });

  it('parses whitespace-delimited ATK paths and identifies only the root scenario', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-product-state-'));
    const session = new SessionStore(root, 'state-test', 'test');
    await session.initialize();
    const manager = new FakeManager();
    const tool = createProductATKTools(manager as unknown as ATKManager, session, defaultLimits)
      .find((candidate) => candidate.name === 'get_atk_runtime_state')!;
    const state = JSON.parse(String(await tool.execute({})));
    expect(state.currentScenario).toBe('Demo');
    expect(state.scenarioPath).toBe('*/Scenario/Demo');
    expect(state.objects).toEqual([
      '*/Scenario/Demo',
      '*/Scenario/Demo/Satellite/RollbackSat',
    ]);
  });

  it('never passes a Unicode Session path to ATK for checkpoints', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'atk-product-unicode-'));
    const root = join(parent, '空间轨道设计竞赛');
    const asciiRoot = await mkdtemp(join(tmpdir(), 'atk-product-ascii-'));
    process.env.ATK_AGENT_ASCII_TEMP = asciiRoot;
    try {
      const session = new SessionStore(root, 'unicode-checkpoint', 'test');
      await session.initialize();
      const manager = new FakeManager();
      const tool = createProductATKTools(manager as unknown as ATKManager, session, defaultLimits)
        .find((candidate) => candidate.name === 'create_scenario_checkpoint')!;
      const result = JSON.parse(String(await tool.execute({ label: 'BeforeLoad' })));
      const save = manager.commands.find((entry) => entry.command === 'SaveAs')!;
      expect(save.parameters).not.toContain('空间轨道设计竞赛');
      expect(save.parameters).toContain(asciiRoot);
      expect(result).toMatchObject({ verification: true, asciiStaging: true });
      expect(result.path).toContain('空间轨道设计竞赛');
    } finally {
      delete process.env.ATK_AGENT_ASCII_TEMP;
    }
  });

  it('uses ASCII paths for display export even under a Unicode data root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'atk-display-unicode-'));
    const root = join(parent, '中文根目录');
    const asciiRoot = await mkdtemp(join(tmpdir(), 'atk-display-ascii-'));
    process.env.ATK_AGENT_ASCII_TEMP = asciiRoot;
    try {
      const session = new SessionStore(root, 'unicode-display', 'test');
      await session.initialize();
      const manager = new FakeManager();
      const tool = createProductATKTools(manager as unknown as ATKManager, session, defaultLimits)
        .find((candidate) => candidate.name === 'verify_object_display_state')!;
      const result = JSON.parse(String(await tool.execute({ paths: ['*/Satellite/DemoSat'] })));
      const save = manager.commands.find((entry) => entry.command === 'SaveAs')!;
      expect(save.parameters).toContain(asciiRoot);
      expect(save.parameters).not.toContain('中文根目录');
      expect(result).toMatchObject({ verification: true, asciiStaging: true, objectsWith3dPoint: 1 });
    } finally {
      delete process.env.ATK_AGENT_ASCII_TEMP;
    }
  });

  it('copies a Unicode scenario source to ASCII before ATK Load', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'atk-load-unicode-'));
    const root = join(parent, '中文工程');
    const source = join(root, '中文场景.xml');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, '<Scenario Name="Demo"/>', 'utf8');
    const asciiRoot = await mkdtemp(join(tmpdir(), 'atk-load-ascii-'));
    process.env.ATK_AGENT_ASCII_TEMP = asciiRoot;
    try {
      const session = new SessionStore(root, 'unicode-load', 'test');
      await session.initialize();
      const manager = new FakeManager();
      const tool = createProductATKTools(manager as unknown as ATKManager, session, defaultLimits)
        .find((candidate) => candidate.name === 'load_scenario_unicode_safe')!;
      const result = JSON.parse(String(await tool.execute({ source_path: source })));
      const load = manager.commands.find((entry) => entry.command === 'Load')!;
      expect(load.parameters).toContain(asciiRoot);
      expect(load.parameters).not.toContain('中文');
      expect(result).toMatchObject({ verification: true, asciiStaging: true, unicodeCompatible: true });
    } finally {
      delete process.env.ATK_AGENT_ASCII_TEMP;
    }
  });
});

const defaultLimits = {
  maxAtkMemoryGB: 6,
  minSystemFreeMemoryGB: 4,
  maxGpuMemoryPercent: 80,
  maxObjectCount: 1000,
  maxEstimatedEphemerisPoints: 2_000_000,
};
