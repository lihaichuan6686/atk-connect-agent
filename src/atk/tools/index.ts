/**
 * Agent 工具集。
 *
 * utilityTools 不依赖 ATK；createATKTools 将真实 CONNECT 命令绑定到 ATKManager。
 */

import type { AITool, ATKCommandResult, ToolExecutionContext } from '../../types.js';
import {
  atkCatalogStats,
  canonicalATKCommand,
  getATKCommandHelp,
  searchATKDocumentation,
} from '../catalog/catalog.js';
import { currentToolExecutionContext } from '../../core/execution-context.js';
import { assertASCIIATKPath } from '../ascii-staging.js';

export interface ATKToolRuntime {
  currentScenario: string | null;
  ensureConnected(): Promise<void>;
  sendCommand(
    command: string,
    param?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ATKCommandResult>;
}

export const utilityTools: AITool[] = [
  {
    name: 'cancel_operation',
    description: '请求常驻 Session daemon 取消客户端等待并切断 CONNECT bridge；不会宣称 ATK 内部计算已经终止。',
    metadata: { readOnly: true, concurrencySafe: true, category: 'daemon' },
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => { throw new Error('cancel_operation 只能通过 Session daemon 调用'); },
  },
  {
    name: 'wait_until_idle',
    description: '等待 Session 变为 idle；取消后可通过 recover 探测 ATK 是否恢复响应。',
    metadata: { readOnly: true, concurrencySafe: true, category: 'daemon' },
    parameters: {
      type: 'object', properties: {
        timeout_ms: { type: 'number', description: '最长等待毫秒数' },
        recover: { type: 'boolean', description: '对 failed Session 执行安全只读探测' },
      }, required: [],
    },
    execute: () => { throw new Error('wait_until_idle 只能通过 Session daemon 调用'); },
  },
  {
    name: 'get_current_time',
    description: '获取当前日期和时间。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => new Date().toISOString(),
  },
  {
    name: 'calculate',
    description: '计算只包含数字、括号和四则运算符的数学表达式。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '数学表达式，如 6778.1 * 1000' } },
      required: ['expression'],
    },
    execute: (params) => {
      const expression = requiredString(params, 'expression');
      if (!/^[\d+\-*/().\s]+$/.test(expression)) {
        throw new Error('表达式包含非法字符');
      }
      const result = new Function(`return (${expression})`)();
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        throw new Error('计算结果不是有限数值');
      }
      return String(result);
    },
  },
  {
    name: 'get_orbit_params',
    description: '获取常见卫星轨道的参数建议。支持 LEO、ISS、SSO、GPS、GEO、GTO、LLO、LMO。',
    parameters: {
      type: 'object',
      properties: {
        orbit_type: {
          type: 'string',
          description: '轨道类型',
          enum: ['LEO', 'ISS', 'SSO', 'GPS', 'GEO', 'GTO', 'LLO', 'LMO'],
        },
      },
      required: ['orbit_type'],
    },
    execute: (params) => {
      const orbits: Record<string, string> = {
        LEO: 'sma=6578100~8378100m, ecc=0, inc=28~98.4, propagator=HPOP',
        ISS: 'sma=6778100m, ecc=0, inc=51.6, propagator=HPOP',
        SSO: 'sma=7128100m, ecc=0.001, inc=98.4, propagator=HPOP',
        GPS: 'sma=26560000m, ecc=0.01, inc=55, propagator=HPOP',
        GEO: 'sma=42164197m, ecc=0, inc=0, propagator=HPOP',
        GTO: 'sma=24400000m, ecc=0.73, inc=28.5, propagator=HPOP',
        LLO: 'sma=1837400m, ecc=0, inc=90, propagator=TwoBody, central_body=Moon',
        LMO: 'sma=3789500m, ecc=0, inc=93, propagator=TwoBody, central_body=Mars',
      };
      const type = requiredString(params, 'orbit_type').toUpperCase();
      if (!orbits[type]) throw new Error(`未知轨道类型: ${type}`);
      return orbits[type];
    },
  },
];

export function createATKTools(runtime: ATKToolRuntime): AITool[] {
  const send = async (command: string, param = '', context?: ToolExecutionContext): Promise<string> => {
    context ??= currentToolExecutionContext();
    await runtime.ensureConnected();
    if (context?.signal?.aborted) throw new Error('工具执行已取消');
    const result = await runtime.sendCommand(command, param, {
      signal: context?.signal,
      timeoutMs: context?.timeoutMs,
    });
    const normalized = result.response.trim().toUpperCase();
    if (!result.success || normalized.startsWith('NACK') || normalized.startsWith('ERROR')) {
      throw new Error(`${command} 执行失败: ${result.response}`);
    }
    return result.response || 'OK';
  };

  return [
    ...createOfficialCommandTools(send),
    {
      name: 'create_scenario',
      description: '创建 ATK 仿真场景，并可同时设置分析时间和动画步长。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '英文场景名称' },
          start_time: { type: 'string', description: '可选，ATK 格式开始时间' },
          end_time: { type: 'string', description: '可选，ATK 格式结束时间' },
          step_seconds: { type: 'number', description: '动画步长（秒）', default: 60 },
          central_body: { type: 'string', description: '中心天体', enum: ['Earth', 'Moon', 'Mars'], default: 'Earth' },
        },
        required: ['name'],
      },
      execute: async (params) => {
        const name = objectName(params, 'name');
        const centralBody = enumValue(params, 'central_body', ['Earth', 'Moon', 'Mars'], 'Earth');
        const startTime = optionalString(params, 'start_time');
        const endTime = optionalString(params, 'end_time');
        if (Boolean(startTime) !== Boolean(endTime)) {
          throw new Error('start_time 和 end_time 必须同时提供');
        }
        const newParam = centralBody === 'Earth'
          ? `/ Scenario ${name}`
          : `/ Scenario ${name} CentralBody ${centralBody}`;
        const responses = [await send('New', newParam)];
        runtime.currentScenario = name;
        if (startTime && endTime) {
          responses.push(await send('SetAnalysisTimePeriod', `* ${quoted(startTime)} ${quoted(endTime)}`));
          responses.push(await send('SetStepSize', `/ Value ${positiveNumber(params, 'step_seconds', 60) * 1000}`));
        }
        return success({ scenario: name, centralBody, responses });
      },
    },
    {
      name: 'set_scenario_time',
      description: '设置当前场景的分析时间段和动画步长。',
      parameters: {
        type: 'object',
        properties: {
          start_time: { type: 'string', description: 'ATK 格式开始时间' },
          end_time: { type: 'string', description: 'ATK 格式结束时间' },
          step_seconds: { type: 'number', description: '动画步长（秒）', default: 60 },
        },
        required: ['start_time', 'end_time'],
      },
      execute: async (params) => {
        const startTime = requiredString(params, 'start_time');
        const endTime = requiredString(params, 'end_time');
        const responses = [
          await send('SetAnalysisTimePeriod', `* ${quoted(startTime)} ${quoted(endTime)}`),
          await send('SetStepSize', `/ Value ${positiveNumber(params, 'step_seconds', 60) * 1000}`),
        ];
        return success({ scenario: runtime.currentScenario, responses });
      },
    },
    {
      name: 'save_scenario',
      description: '保存当前 ATK 场景。filepath 省略时保存到当前场景文件。',
      parameters: {
        type: 'object',
        properties: { filepath: { type: 'string', description: '可选，保存路径' } },
        required: [],
      },
      execute: async (params) => {
        const filepath = optionalString(params, 'filepath');
        if (filepath && /[\r\n"]/.test(filepath)) throw new Error('保存路径包含非法字符');
        const response = await send('Save', filepath ? `*/ ${filepath}` : '*/ *');
        return success({ filepath: filepath || null, response });
      },
    },
    {
      name: 'create_satellite',
      description: '在当前场景中创建卫星对象。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '英文卫星名称' } },
        required: ['name'],
      },
      execute: async (params) => {
        const name = objectName(params, 'name');
        return success({ satellite: name, response: await send('New', `/ Satellite ${name}`) });
      },
    },
    {
      name: 'set_satellite_classical',
      description: '使用经典轨道根数设置卫星状态。半长轴单位为米，角度单位为度。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '英文卫星名称' },
          propagator: { type: 'string', description: '轨道预报器', enum: ['TwoBody', 'J2Perturbation', 'J4Perturbation', 'HPOP', 'LOP'] },
          start_time: { type: 'string', description: 'ATK 格式开始时间' },
          end_time: { type: 'string', description: 'ATK 格式结束时间' },
          step_seconds: { type: 'number', description: '计算步长（秒）' },
          coord_system: { type: 'string', description: '坐标系', enum: ['J2000', 'Fixed'] },
          orbit_epoch: { type: 'string', description: 'ATK 格式轨道历元' },
          sma: { type: 'number', description: '半长轴（米）' },
          ecc: { type: 'number', description: '偏心率，0 <= ecc < 1' },
          inc: { type: 'number', description: '轨道倾角（度）' },
          argp: { type: 'number', description: '近地点角（度）' },
          raan: { type: 'number', description: '升交点赤经（度）' },
          ma: { type: 'number', description: '平近点角（度）' },
        },
        required: ['name', 'propagator', 'start_time', 'end_time', 'step_seconds', 'coord_system', 'orbit_epoch', 'sma', 'ecc', 'inc', 'argp', 'raan', 'ma'],
      },
      execute: async (params) => {
        const name = objectName(params, 'name');
        const propagator = enumValue(params, 'propagator', ['TwoBody', 'J2Perturbation', 'J4Perturbation', 'HPOP', 'LOP']);
        const coord = enumValue(params, 'coord_system', ['J2000', 'Fixed']);
        const ecc = boundedNumber(params, 'ecc', 0, 1, false);
        const param = [
          `*/Satellite/${name}`, 'Classical', propagator,
          quoted(requiredString(params, 'start_time')),
          quoted(requiredString(params, 'end_time')),
          positiveNumber(params, 'step_seconds'), coord,
          quoted(requiredString(params, 'orbit_epoch')),
          positiveNumber(params, 'sma'), ecc,
          numberValue(params, 'inc'), numberValue(params, 'argp'),
          numberValue(params, 'raan'), numberValue(params, 'ma'),
        ].join(' ');
        const response = await send('SetState', param);
        const position = await send('Position', `*/Satellite/${name} ${quoted(requiredString(params, 'start_time'))}`);
        assertPropagatedPosition(name, position);
        return success({ satellite: name, response, positionVerification: position });
      },
    },
    {
      name: 'set_satellite_cartesian',
      description: '使用位置和速度矢量设置卫星状态。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '英文卫星名称' },
          propagator: { type: 'string', description: '轨道预报器', enum: ['TwoBody', 'J2Perturbation', 'J4Perturbation', 'HPOP', 'LOP'] },
          start_time: { type: 'string', description: 'ATK 格式开始时间' },
          end_time: { type: 'string', description: 'ATK 格式结束时间' },
          step_seconds: { type: 'number', description: '计算步长（秒）' },
          coord_system: { type: 'string', description: '坐标系', enum: ['J2000', 'Fixed'] },
          orbit_epoch: { type: 'string', description: 'ATK 格式轨道历元' },
          x: { type: 'number', description: 'X 位置' }, y: { type: 'number', description: 'Y 位置' },
          z: { type: 'number', description: 'Z 位置' }, vx: { type: 'number', description: 'X 速度' },
          vy: { type: 'number', description: 'Y 速度' }, vz: { type: 'number', description: 'Z 速度' },
        },
        required: ['name', 'propagator', 'start_time', 'end_time', 'step_seconds', 'coord_system', 'orbit_epoch', 'x', 'y', 'z', 'vx', 'vy', 'vz'],
      },
      execute: async (params) => {
        const name = objectName(params, 'name');
        const parts = [
          `*/Satellite/${name}`, 'Cartesian', enumValue(params, 'propagator', ['TwoBody', 'J2Perturbation', 'J4Perturbation', 'HPOP', 'LOP']),
          quoted(requiredString(params, 'start_time')), quoted(requiredString(params, 'end_time')),
          positiveNumber(params, 'step_seconds'), enumValue(params, 'coord_system', ['J2000', 'Fixed']),
          quoted(requiredString(params, 'orbit_epoch')),
          ...['x', 'y', 'z', 'vx', 'vy', 'vz'].map((key) => numberValue(params, key)),
        ];
        const response = await send('SetState', parts.join(' '));
        const position = await send('Position', `*/Satellite/${name} ${quoted(requiredString(params, 'start_time'))}`);
        assertPropagatedPosition(name, position);
        return success({ satellite: name, response, positionVerification: position });
      },
    },
    {
      name: 'get_satellite_position',
      description: '获取卫星在指定时间或当前时间的位置。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '英文卫星名称' },
          time: { type: 'string', description: '可选，ATK 格式时间' },
        },
        required: ['name'],
      },
      execute: async (params) => {
        const name = objectName(params, 'name');
        const time = optionalString(params, 'time');
        const param = time ? `*/Satellite/${name} ${quoted(time)}` : `*/Satellite/${name}`;
        return success({ satellite: name, response: await send('Position', param) });
      },
    },
    {
      name: 'create_facility',
      description: '创建地面站并设置经纬度和海拔。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '英文地面站名称' },
          lat: { type: 'number', description: '纬度（度）' },
          lon: { type: 'number', description: '经度（度）' },
          alt_km: { type: 'number', description: '海拔（千米）', default: 0 },
        },
        required: ['name', 'lat', 'lon'],
      },
      execute: async (params) => {
        const name = objectName(params, 'name');
        const lat = boundedNumber(params, 'lat', -90, 90, true);
        const lon = boundedNumber(params, 'lon', -180, 180, true);
        const altM = numberValue(params, 'alt_km', 0) * 1000;
        const responses = [
          await send('New', `/ Facility ${name}`),
          // ATK 4.0 实际接受 Geodetic；离线文档中的 Geoditic 是拼写错误。
          await send('SetPosition', `*/Facility/${name} Geodetic ${lat} ${lon} ${altM}`),
        ];
        return success({ facility: name, responses });
      },
    },
    {
      name: 'run_simulation',
      description: '开始播放当前 ATK 仿真。',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => success({ response: await send('Animate', '* Start') }),
    },
    {
      name: 'reset_simulation',
      description: '将当前 ATK 仿真重置到开始时刻。',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => success({ response: await send('Animate', '* Reset') }),
    },
  ];
}

function createOfficialCommandTools(
  send: (command: string, param?: string) => Promise<string>,
): AITool[] {
  return [
    {
      name: 'list_atk_command_categories',
      description: '列出离线官方 CONNECT 手册覆盖的命令分类与覆盖统计。',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => JSON.stringify({
        status: 'success',
        files: atkCatalogStats.files,
        entries: atkCatalogStats.entries,
        commandEntries: atkCatalogStats.commandEntries,
        uniqueCommands: atkCatalogStats.uniqueCommands,
        categories: atkCatalogStats.categories,
      }),
    },
    {
      name: 'search_atk_commands',
      description: '检索内置的离线官方 CONNECT 命令、Astrogator 属性和格式参考。执行不熟悉的操作前先用此工具查证。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '命令名、对象类型、功能或中文关键词' },
          category: { type: 'string', description: '可选分类，例如 卫星、敏感器、机动规划' },
          limit: { type: 'number', description: '返回条数，1 到 20，默认 8', default: 8 },
        },
        required: ['query'],
      },
      execute: (params) => {
        const query = requiredString(params, 'query');
        const category = optionalString(params, 'category');
        const limit = integerInRange(params, 'limit', 1, 20, 8);
        const results = searchATKDocumentation(query, { category, limit }).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          category: entry.category,
          title: entry.title,
          command: entry.command,
          summary: entry.summary,
          usage: entry.usage,
          source: entry.source,
        }));
        return JSON.stringify({ status: 'success', query, count: results.length, results });
      },
    },
    {
      name: 'get_atk_command_help',
      description: '读取某条 CONNECT 命令或参考项的离线官方用法、示例和说明。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '精确命令名或章节标题，例如 SetState、规划设置属性值' },
          category: { type: 'string', description: '可选分类，用于缩小同名命令范围' },
          limit: { type: 'number', description: '返回变体数，1 到 20，默认 8', default: 8 },
        },
        required: ['query'],
      },
      execute: (params) => {
        const query = requiredString(params, 'query');
        const category = optionalString(params, 'category');
        const limit = integerInRange(params, 'limit', 1, 20, 8);
        const results = getATKCommandHelp(query, category, limit).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          category: entry.category,
          title: entry.title,
          command: entry.command,
          summary: entry.summary,
          usage: entry.usage,
          examples: entry.examples,
          details: entry.details.slice(0, 2000),
          source: entry.source,
        }));
        return JSON.stringify({ status: 'success', query, count: results.length, results });
      },
    },
    {
      name: 'execute_atk_connect_command',
      description: '执行已被离线官方手册收录的 CONNECT 命令。必须先查官方用法；command 只填命令首词，parameters 填其余参数。',
      metadata: { category: 'connect', defaultTimeoutMs: 120_000 },
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '官方命令首词，例如 New、SetState、Astrogator' },
          parameters: { type: 'string', description: '命令首词之后的完整参数；无参数时传空字符串' },
        },
        required: ['command', 'parameters'],
      },
      execute: async (params) => {
        const requested = requiredString(params, 'command');
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(requested)) {
          throw new Error('command 必须是单个 CONNECT 命令首词');
        }
        const command = canonicalATKCommand(requested);
        if (!command) {
          throw new Error(`命令 ${requested} 不在内置离线官方 CONNECT 白名单中，请先使用 search_atk_commands`);
        }
        const context = currentToolExecutionContext();
        if (isDestructiveConnectCommand(command) && !context?.allowDestructive) {
          throw new Error(`CONNECT 命令 ${command} 可能删除或覆盖场景数据，需要显式授权 allowDestructive`);
        }
        const raw = params.parameters;
        if (typeof raw !== 'string') throw new Error('parameters 必须是字符串');
        if (/[\r\n\0]/.test(raw)) throw new Error('parameters 不能包含换行符或 NUL 字符');
        if (raw.length > 32_768) throw new Error('parameters 超过 32768 字符限制');
        validateRawFileCommandPaths(command, raw);
        const response = await send(command, raw.trim());
        return success({ command, parameters: raw.trim(), response });
      },
    },
  ];
}

function validateRawFileCommandPaths(command: string, parameters: string): void {
  const fileCommands = new Set(['Save', 'SaveAs', 'Load', 'Reload', 'ImportTLEFile', 'TLEFileOptions']);
  if (!fileCommands.has(command)) return;
  const quoted = [...parameters.matchAll(/"([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
  if (quoted.length === 0) {
    if (command === 'Save') return;
    throw new Error(`CONNECT 文件命令 ${command} 缺少带双引号的绝对文件路径`);
  }
  for (const path of quoted) assertASCIIATKPath(path);
}

function isDestructiveConnectCommand(command: string): boolean {
  return new Set([
    'Unload', 'UnloadMulti', 'SubObjUnload', 'Save', 'SaveAs',
    'QuickReport_RM', 'Exec_Report_RM',
  ]).has(command);
}

function success(data: Record<string, unknown>): string {
  return JSON.stringify({ status: 'success', ...data });
}

function assertPropagatedPosition(name: string, response: string): void {
  const values = response.trim().split(/\s+/).map(Number);
  const valid = values.length >= 3
    && values.every(Number.isFinite)
    && values.slice(0, 3).some((value) => Math.abs(value) > 1e-9);
  if (!valid) {
    throw new Error(
      `卫星 ${name} 的 SetState 返回成功，但 ATK 未生成可播放星历（Position 仍为零或无效）`,
    );
  }
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串`);
  if (/[\r\n]/.test(value)) throw new Error(`${key} 包含非法换行符`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  if (params[key] === undefined || params[key] === null || params[key] === '') return undefined;
  return requiredString(params, key);
}

function objectName(params: Record<string, unknown>, key: string): string {
  const value = requiredString(params, key);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${key} 只能包含英文字母、数字和下划线，且必须以字母开头`);
  }
  return value;
}

function numberValue(params: Record<string, unknown>, key: string, defaultValue?: number): number {
  const raw = params[key] ?? defaultValue;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`${key} 必须是有限数值`);
  return raw;
}

function integerInRange(
  params: Record<string, unknown>, key: string, min: number, max: number, defaultValue: number,
): number {
  const value = numberValue(params, key, defaultValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function positiveNumber(params: Record<string, unknown>, key: string, defaultValue?: number): number {
  const value = numberValue(params, key, defaultValue);
  if (value <= 0) throw new Error(`${key} 必须大于 0`);
  return value;
}

function boundedNumber(
  params: Record<string, unknown>, key: string, min: number, max: number, inclusiveMax: boolean,
): number {
  const value = numberValue(params, key);
  const tooHigh = inclusiveMax ? value > max : value >= max;
  if (value < min || tooHigh) {
    throw new Error(`${key} 必须在 ${min} 到 ${max}${inclusiveMax ? '（含）' : '（不含）'}之间`);
  }
  return value;
}

function enumValue<T extends string>(
  params: Record<string, unknown>, key: string, allowed: readonly T[], defaultValue?: T,
): T {
  const raw = params[key] ?? defaultValue;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new Error(`${key} 必须是 ${allowed.join('、')} 之一`);
  }
  return raw as T;
}

function quoted(value: string): string {
  if (value.includes('"')) throw new Error('参数中不能包含双引号');
  return `"${value}"`;
}

/** 向后兼容旧导入；新代码应组合 utilityTools 与 createATKTools。 */
export const builtinTools = utilityTools;
