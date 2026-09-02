import { describe, expect, it } from 'vitest';
import { createATKTools, type ATKToolRuntime } from '../src/atk/tools/index.js';
import type { ATKCommandResult } from '../src/types.js';

class FakeRuntime implements ATKToolRuntime {
  currentScenario: string | null = null;
  ensureCount = 0;
  commands: Array<{ command: string; param: string }> = [];
  failCommand: string | null = null;
  nackCommand: string | null = null;

  async ensureConnected(): Promise<void> {
    this.ensureCount++;
  }

  async sendCommand(command: string, param = ''): Promise<ATKCommandResult> {
    this.commands.push({ command, param });
    if (command === this.failCommand) {
      return { success: false, response: 'simulated failure', command, param };
    }
    if (command === this.nackCommand) {
      return { success: true, response: 'NACK', command, param };
    }
    if (command === 'Position') {
      return { success: true, response: '7000000 0 0 0 7500 0', command, param };
    }
    return { success: true, response: 'OK', command, param };
  }
}

function tool(runtime: FakeRuntime, name: string) {
  const result = createATKTools(runtime).find((item) => item.name === name);
  if (!result) throw new Error(`missing tool: ${name}`);
  return result;
}

describe('ATK tools', () => {
  it('creates a lunar scenario and configures its time period', async () => {
    const runtime = new FakeRuntime();
    const result = await tool(runtime, 'create_scenario').execute({
      name: 'MoonMission',
      central_body: 'Moon',
      start_time: '5 Nov 2022 00:00:00.000',
      end_time: '6 Nov 2022 00:00:00.000',
      step_seconds: 30,
    });

    expect(runtime.currentScenario).toBe('MoonMission');
    expect(runtime.commands).toEqual([
      { command: 'New', param: '/ Scenario MoonMission CentralBody Moon' },
      {
        command: 'SetAnalysisTimePeriod',
        param: '* "5 Nov 2022 00:00:00.000" "6 Nov 2022 00:00:00.000"',
      },
      { command: 'SetStepSize', param: '/ Value 30000' },
    ]);
    expect(JSON.parse(String(result)).status).toBe('success');
  });

  it('builds the documented Classical SetState command', async () => {
    const runtime = new FakeRuntime();
    await tool(runtime, 'set_satellite_classical').execute({
      name: 'Sat1',
      propagator: 'TwoBody',
      start_time: '5 Nov 2022 00:00:00.000',
      end_time: '6 Nov 2022 00:00:00.000',
      step_seconds: 60,
      coord_system: 'J2000',
      orbit_epoch: '5 Nov 2022 00:00:00.000',
      sma: 6778100,
      ecc: 0,
      inc: 51.6,
      argp: 0,
      raan: 0,
      ma: 0,
    });

    expect(runtime.commands[0]).toEqual({
      command: 'SetState',
      param: '*/Satellite/Sat1 Classical TwoBody "5 Nov 2022 00:00:00.000" "6 Nov 2022 00:00:00.000" 60 J2000 "5 Nov 2022 00:00:00.000" 6778100 0 51.6 0 0 0',
    });
    expect(runtime.commands[1]).toEqual({
      command: 'Position',
      param: '*/Satellite/Sat1 "5 Nov 2022 00:00:00.000"',
    });
  });

  it('converts facility altitude from kilometres to metres', async () => {
    const runtime = new FakeRuntime();
    await tool(runtime, 'create_facility').execute({
      name: 'BeijingGS', lat: 39.9, lon: 116.4, alt_km: 0.05,
    });

    expect(runtime.commands[1]).toEqual({
      command: 'SetPosition',
      param: '*/Facility/BeijingGS Geodetic 39.9 116.4 50',
    });
  });

  it('rejects unsafe ATK object names before connecting', async () => {
    const runtime = new FakeRuntime();
    await expect(tool(runtime, 'create_satellite').execute({ name: 'Bad Name' }))
      .rejects.toThrow('只能包含英文字母');
    expect(runtime.ensureCount).toBe(0);
  });

  it('surfaces failed CONNECT commands', async () => {
    const runtime = new FakeRuntime();
    runtime.failCommand = 'Animate';
    await expect(tool(runtime, 'run_simulation').execute({}))
      .rejects.toThrow('Animate 执行失败');
  });

  it('treats an ATK NACK response as failure even if the transport succeeded', async () => {
    const runtime = new FakeRuntime();
    runtime.nackCommand = 'Animate';
    await expect(tool(runtime, 'run_simulation').execute({}))
      .rejects.toThrow('NACK');
  });

  it('searches bundled official documentation without connecting to ATK', async () => {
    const runtime = new FakeRuntime();
    const result = await tool(runtime, 'search_atk_commands').execute({
      query: '敏感器',
      limit: 5,
    });
    const parsed = JSON.parse(String(result));
    expect(parsed.status).toBe('success');
    expect(parsed.results.some((entry: { category: string }) => entry.category.includes('敏感器'))).toBe(true);
    expect(runtime.ensureCount).toBe(0);
  });

  it('executes only commands present in the official offline allowlist', async () => {
    const runtime = new FakeRuntime();
    await tool(runtime, 'execute_atk_connect_command').execute({
      command: 'setstate',
      parameters: '*/Satellite/Sat1 Classical TwoBody',
    });
    expect(runtime.commands).toEqual([{
      command: 'SetState',
      param: '*/Satellite/Sat1 Classical TwoBody',
    }]);
  });

  it('rejects unknown commands and command-separator newlines before connecting', async () => {
    const runtime = new FakeRuntime();
    await expect(tool(runtime, 'execute_atk_connect_command').execute({
      command: 'MadeUpCommand', parameters: '*',
    })).rejects.toThrow('不在内置离线官方 CONNECT 白名单');
    await expect(tool(runtime, 'execute_atk_connect_command').execute({
      command: 'New', parameters: '/ Scenario Safe\nUnload /',
    })).rejects.toThrow('不能包含换行符');
    expect(runtime.ensureCount).toBe(0);
  });

  it('rejects Unicode or relative paths in raw CONNECT file commands', async () => {
    const runtime = new FakeRuntime();
    await expect(tool(runtime, 'execute_atk_connect_command').execute({
      command: 'ImportTLEFile', parameters: '* "D:\\空间轨道设计竞赛\\catalog.tle"',
    })).rejects.toThrow('纯 ASCII');
    await expect(tool(runtime, 'execute_atk_connect_command').execute({
      command: 'Load', parameters: '/ Scenario ".\\scene.xml"',
    })).rejects.toThrow('纯 ASCII');
    expect(runtime.ensureCount).toBe(0);
  });
});
