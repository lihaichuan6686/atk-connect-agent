import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname } from 'node:path';
import { copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import type { AITool, ATKCommandResult } from '../../types.js';
import type { ATKManager } from '../manager.js';
import type { SessionStore } from '../../core/session-store.js';
import { currentToolExecutionContext } from '../../core/execution-context.js';
import type { ResourceLimits } from '../../config.js';
import { assessResourceBudget, enforceResourceBudget, estimateSceneCost, getResourceSnapshot } from '../resources.js';
import { assertASCIIATKPath, createASCIIStagingWorkspace, type ASCIIStagingWorkspace } from '../ascii-staging.js';

export function createProductATKTools(manager: ATKManager, session: SessionStore, limits: ResourceLimits): AITool[] {
  let activeTransaction: {
    id: string;
    atkPath: string;
    auditPath: string;
    workspace: ASCIIStagingWorkspace;
    createdObjects: string[];
  } | null = null;
  const send = async (command: string, parameters = ''): Promise<string> => {
    const context = currentToolExecutionContext();
    if (context?.signal?.aborted) throw new Error('工具执行已取消');
    await manager.ensureConnected();
    const result = await manager.sendCommand(command, parameters, {
      signal: context?.signal,
      timeoutMs: context?.timeoutMs,
    });
    assertSuccess(command, result);
    return result.response.trim();
  };

  const exists = async (path: string): Promise<boolean> => {
    const response = (await send('DoesObjExist', `/ ${path}`)).toLowerCase();
    return response === '1' || response === 'true' || response.includes('exists');
  };

  const rollbackActiveTransaction = async (): Promise<void> => {
    if (!activeTransaction) throw new Error('当前没有活动事务');
    const transaction = activeTransaction;
    await send('Unload', '/ *').catch(() => '');
    await send('Load', `/ Scenario "${safeQuotedPath(transaction.atkPath)}"`);
    activeTransaction = null;
    await transaction.workspace.cleanup();
  };

  const checkPlannedBudget = async (additionalObjects: number, estimatedEphemerisPoints?: number): Promise<string[]> => {
    await manager.ensureConnected();
    const objectResponse = await manager.sendCommand('AllInstanceNames', '/', { timeoutMs: 10_000 });
    const currentObjects = objectResponse.success ? parseObjectPaths(objectResponse.response).length : 0;
    const snapshot = await getResourceSnapshot(manager.getManagedPid());
    const assessment = assessResourceBudget(snapshot, limits, {
      objectCount: currentObjects + additionalObjects,
      estimatedEphemerisPoints,
    });
    enforceResourceBudget(assessment);
    return assessment.warnings;
  };

  const verifyConfiguredOrbits = async (names: string[]): Promise<Array<{ name: string; verified: boolean }>> => {
    const workspace = await createASCIIStagingWorkspace(session.sessionId, 'orbit-verify');
    const paths = names.map((name) => `*/Satellite/${safeName(name)}`);
    const files = names.map((name, index) => workspace.path(`${index}-${name}.xml`));
    try {
      const exported = await sendBatch(manager, paths.map((path, index) => ({ command: 'SaveAs', param: `/ ${path} "${safeQuotedPath(files[index])}"` })));
      return await Promise.all(names.map(async (name, index) => {
        const accepted = exported.results.find((entry) => entry.index === index)?.success === true;
        let verified = false;
        if (accepted && existsSync(files[index])) {
          const state = parseDisplayState(await readFile(files[index], 'utf8'), paths[index]);
          verified = state.hasConfiguredOrbitState;
        }
        return { name, verified };
      }));
    } finally {
      await workspace.cleanup();
    }
  };

  return [
    {
      name: 'estimate_scene_cost',
      description: '在建模前根据对象数、分析跨度和步长估算总星历点、内存量级与风险等级。',
      metadata: { readOnly: true, concurrencySafe: true, category: 'safety' },
      parameters: {
        type: 'object',
        properties: {
          object_count: { type: 'number', description: '计划创建的对象数量' },
          duration_seconds: { type: 'number', description: '分析总时长（秒）' },
          step_seconds: { type: 'number', description: '传播采样步长（秒）' },
          bytes_per_point: { type: 'number', description: '可选，每个星历点估算字节数，默认 96' },
        },
        required: ['object_count', 'duration_seconds', 'step_seconds'],
      },
      execute: (params) => JSON.stringify({ status: 'success', ...estimateSceneCost({
        objectCount: Number(params.object_count), durationSeconds: Number(params.duration_seconds),
        stepSeconds: Number(params.step_seconds), bytesPerPoint: params.bytes_per_point === undefined ? undefined : Number(params.bytes_per_point),
      }) }),
    },
    {
      name: 'estimate_propagation_cost',
      description: '估算一次或一批轨道传播的采样点规模与风险。',
      metadata: { readOnly: true, concurrencySafe: true, category: 'safety' },
      parameters: {
        type: 'object', properties: {
          object_count: { type: 'number', description: '传播对象数量' },
          start_epoch_ms: { type: 'number', description: '开始时间 Unix 毫秒' },
          stop_epoch_ms: { type: 'number', description: '结束时间 Unix 毫秒' },
          step_seconds: { type: 'number', description: '步长（秒）' },
        }, required: ['object_count', 'start_epoch_ms', 'stop_epoch_ms', 'step_seconds'],
      },
      execute: (params) => JSON.stringify({ status: 'success', ...estimateSceneCost({
        objectCount: Number(params.object_count),
        durationSeconds: (Number(params.stop_epoch_ms) - Number(params.start_epoch_ms)) / 1000,
        stepSeconds: Number(params.step_seconds),
      }) }),
    },
    {
      name: 'check_resource_budget',
      description: '读取 ATK/系统/GPU 资源，并按配置阈值检查对象数和预计星历点预算。',
      metadata: { readOnly: true, concurrencySafe: false, category: 'safety', defaultTimeoutMs: 60_000 },
      parameters: {
        type: 'object', properties: {
          object_count: { type: 'number', description: '可选，计划或当前对象数' },
          estimated_ephemeris_points: { type: 'number', description: '可选，预计总星历点' },
        }, required: [],
      },
      execute: async (params) => {
        const snapshot = await getResourceSnapshot(manager.getManagedPid());
        const assessment = assessResourceBudget(snapshot, limits, {
          objectCount: params.object_count === undefined ? undefined : Number(params.object_count),
          estimatedEphemerisPoints: params.estimated_ephemeris_points === undefined ? undefined : Number(params.estimated_ephemeris_points),
        });
        return JSON.stringify({ status: 'success', limits, snapshot, ...assessment });
      },
    },
    {
      name: 'begin_scene_transaction',
      description: '在批量建模前创建可回滚场景快照，并开始事务。',
      metadata: { category: 'transaction', defaultTimeoutMs: 120_000 },
      parameters: { type: 'object', properties: { label: { type: 'string', description: '可选事务标签' } }, required: [] },
      execute: async (params) => {
        if (activeTransaction) throw new Error(`事务 ${activeTransaction.id} 已在进行`);
        const label = params.label === undefined ? `Txn_${Date.now()}` : safeName(params.label);
        const auditPath = resolve(session.sessionDir, 'checkpoints', `${label}.xml`);
        if (existsSync(auditPath)) throw new Error(`事务检查点已存在: ${label}`);
        const workspace = await createASCIIStagingWorkspace(session.sessionId, 'transaction');
        const atkPath = workspace.path(`${label}.xml`);
        try {
          await send('SaveAs', `/ * "${safeQuotedPath(atkPath)}"`);
          if (!existsSync(atkPath)) throw new Error('事务检查点保存后读回验证失败');
          await copyFileAtomically(atkPath, auditPath, false);
          activeTransaction = { id: label, atkPath, auditPath, workspace, createdObjects: [] };
          return JSON.stringify({ status: 'success', transactionId: label, checkpoint: auditPath, asciiStaging: true, verification: true });
        } catch (cause) {
          await workspace.cleanup();
          throw cause;
        }
      },
    },
    {
      name: 'commit_scene_transaction',
      description: '验证后提交当前场景事务，保留检查点作为审计产物。',
      metadata: { idempotent: true, category: 'transaction' },
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        if (!activeTransaction) return JSON.stringify({ status: 'success', committed: false, reason: 'no_active_transaction' });
        const committed = activeTransaction;
        activeTransaction = null;
        await committed.workspace.cleanup();
        return JSON.stringify({ status: 'success', committed: true, transactionId: committed.id, checkpoint: committed.auditPath, verification: true });
      },
    },
    {
      name: 'rollback_scene_transaction',
      description: '卸载当前场景并恢复事务开始时的快照。破坏性操作。',
      metadata: { destructive: true, idempotent: true, category: 'transaction', defaultTimeoutMs: 120_000 },
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const id = activeTransaction?.id;
        if (!id) return JSON.stringify({ status: 'success', rolledBack: false, reason: 'no_active_transaction' });
        await rollbackActiveTransaction();
        return JSON.stringify({ status: 'success', rolledBack: true, transactionId: id, verification: true });
      },
    },
    {
      name: 'batch_create_satellites',
      description: '在 Python sidecar 内一次性循环创建卫星，避免数百次 Node/MCP 往返。',
      metadata: { category: 'batch', defaultTimeoutMs: 3_600_000 },
      parameters: {
        type: 'object', properties: {
          names: { type: 'array', description: '卫星英文名称数组' },
          stop_on_error: { type: 'boolean', description: '遇到首个失败时停止，默认 true' },
          rollback_on_failure: { type: 'boolean', description: '批次失败时自动回滚活动事务' },
        }, required: ['names'],
      },
      execute: async (params) => {
        const names = stringArray(params.names, limits.maxObjectCount).map(safeName);
        const resourceWarnings = await checkPlannedBudget(names.length);
        const commands = names.map((name) => ({ command: 'New', param: `/ Satellite ${name}` }));
        const context = currentToolExecutionContext();
        const result = await manager.sendBatch(commands, {
          timeoutMs: context?.timeoutMs, signal: context?.signal, stopOnError: params.stop_on_error !== false,
        });
        if (activeTransaction) activeTransaction.createdObjects.push(...names.slice(0, result.succeeded).map((name) => `*/Satellite/${name}`));
        let rolledBack = false;
        if (!result.success && params.rollback_on_failure === true && activeTransaction) {
          await rollbackActiveTransaction();
          rolledBack = true;
        }
        return JSON.stringify({ status: result.success ? 'success' : 'partial_failure', ...result, failedObjects: result.results.filter((entry) => !entry.success).map((entry) => names[entry.index]), rolledBack, verification: result.success, warnings: resourceWarnings });
      },
    },
    {
      name: 'batch_set_satellite_classical',
      description: '在 Python sidecar 内批量设置卫星经典轨道根数。',
      metadata: { category: 'batch', defaultTimeoutMs: 3_600_000 },
      parameters: {
        type: 'object', properties: {
          satellites: { type: 'array', description: '轨道对象数组；sma 半长轴单位为米，角度为度，时间建议使用官方格式 1 Jan 2014 00:00:00.00' },
          stop_on_error: { type: 'boolean', description: '遇错停止' },
          rollback_on_failure: { type: 'boolean', description: '失败时回滚活动事务' },
        }, required: ['satellites'],
      },
      execute: async (params) => {
        const entries = recordArray(params.satellites, limits.maxObjectCount);
        const estimatedEphemerisPoints = estimateClassicalPoints(entries);
        const resourceWarnings = await checkPlannedBudget(0, estimatedEphemerisPoints);
        const commands = entries.map((entry) => ({ command: 'SetState', param: classicalStateParameters(entry) }));
        const context = currentToolExecutionContext();
        const result = await manager.sendBatch(commands, { timeoutMs: context?.timeoutMs, signal: context?.signal, stopOnError: params.stop_on_error !== false });
        const orbitVerification = result.success
          ? await verifyConfiguredOrbits(entries.map((entry) => String(entry.name))) : [];
        const verified = result.success && orbitVerification.every((entry) => entry.verified);
        let rolledBack = false;
        if (!result.success && params.rollback_on_failure === true && activeTransaction) { await rollbackActiveTransaction(); rolledBack = true; }
        return JSON.stringify({ status: verified ? 'success' : result.success ? 'verification_failed' : 'partial_failure', ...result, failedObjects: result.results.filter((entry) => !entry.success).map((entry) => entries[entry.index]?.name), orbitVerification, rolledBack, verification: verified, estimatedEphemerisPoints, warnings: resourceWarnings });
      },
    },
    {
      name: 'batch_get_positions',
      description: '在 sidecar 内批量读取对象在指定时刻的位置，返回失败对象和总耗时。',
      metadata: { readOnly: true, concurrencySafe: false, category: 'batch', defaultTimeoutMs: 600_000 },
      parameters: {
        type: 'object', properties: {
          paths: { type: 'array', description: '对象路径数组' },
          time: { type: 'string', description: '可选 ATK 时间；省略使用当前动画时间' },
          stop_on_error: { type: 'boolean', description: '遇错停止' },
        }, required: ['paths'],
      },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const time = params.time === undefined ? '' : ` "${String(params.time).replace(/"/g, '')}"`;
        const context = currentToolExecutionContext();
        const result = await manager.sendBatch(paths.map((path) => ({ command: 'Position', param: `${path}${time}` })), {
          timeoutMs: context?.timeoutMs, signal: context?.signal, stopOnError: params.stop_on_error === true,
        });
        return JSON.stringify({
          status: result.success ? 'success' : 'partial_failure', ...result,
          positions: result.results.map((entry) => ({
            path: paths[entry.index], commandAccepted: entry.success,
            valid: entry.success && hasNonZeroPosition(entry.response), response: entry.response,
          })),
          warnings: result.results.some((entry) => entry.success && !hasNonZeroPosition(entry.response))
            ? ['CONNECT Position 返回全零坐标，不能视为当前时刻有效位置'] : [],
        });
      },
    },
    {
      name: 'batch_set_graphics',
      description: '在 sidecar 内批量设置二维显示、标签、轨道和颜色。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: {
        type: 'object', properties: {
          paths: { type: 'array', description: '对象路径数组' },
          show: { type: 'boolean', description: '二维可见性' },
          show_label: { type: 'boolean', description: '标签可见性' },
          show_orbit: { type: 'boolean', description: '轨道可见性' },
          color: { type: 'string', description: '官方颜色编号、名称或 %RRGGBB' },
        }, required: ['paths'],
      },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const commands: Array<{ command: string; param: string }> = [];
        for (const path of paths) {
          if (params.show !== undefined) commands.push({ command: 'Graphics', param: `${path} Show ${onOff(params.show)}` });
          if (params.show_label !== undefined) commands.push({ command: 'Graphics', param: `${path} Label Show ${onOff(params.show_label)}` });
          if (params.show_orbit !== undefined) commands.push({ command: 'Graphics', param: `${path} Basic Orbit ${onOff(params.show_orbit)}` });
          if (params.color !== undefined) commands.push({ command: 'Graphics', param: `${path} SetColor ${safeColor(params.color)}` });
        }
        if (commands.length === 0) throw new Error('至少提供一个显示属性');
        const context = currentToolExecutionContext();
        const result = await manager.sendBatch(commands, { timeoutMs: context?.timeoutMs, signal: context?.signal, stopOnError: false });
        return JSON.stringify({ status: result.success ? 'success' : 'partial_failure', ...result, objectCount: paths.length, verification: result.success, warnings: ['CONNECT 仅确认命令接受；需要调用 verify_object_display_state 读取场景文件验证显示属性'] });
      },
    },
    {
      name: 'set_object_visibility',
      description: '统一设置对象二维或三维模型可见性；三维使用已在 ATK 4.0 实机验证的 VO Model Show。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: {
        type: 'object', properties: {
          paths: { type: 'array', description: '对象路径数组' },
          view: { type: 'string', enum: ['2d', '3d', 'both'], description: '目标视图' },
          show: { type: 'boolean', description: '是否显示' },
        }, required: ['paths', 'view', 'show'],
      },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const view = String(params.view);
        if (!['2d', '3d', 'both'].includes(view)) throw new Error('view 必须是 2d、3d 或 both');
        const commands = paths.flatMap((path) => [
          ...(view === '2d' || view === 'both' ? [{ command: 'Graphics', param: `${path} Show ${onOff(params.show)}` }] : []),
          ...(view === '3d' || view === 'both' ? [{ command: 'VO', param: `${path} Model Show ${onOff(params.show)}` }] : []),
        ]);
        const result = await sendBatch(manager, commands);
        return visualizationMutationResult(result, paths.length, ['调用 verify_object_display_state 可通过对象导出读回显示属性']);
      },
    },
    {
      name: 'set_point_cloud_display',
      description: '批量开启三维点显示并设置点大小；使用已在 ATK 4.0 实机验证的 VO Point 语法。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: {
        type: 'object', properties: {
          paths: { type: 'array', description: '对象路径数组' },
          show_point: { type: 'boolean', description: '是否显示三维点' },
          point_size: { type: 'number', description: '点大小，1-64' },
          show_model: { type: 'boolean', description: '可选，同时控制三维模型' },
        }, required: ['paths', 'show_point'],
      },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const size = params.point_size === undefined ? undefined : boundedInteger(params.point_size, 1, 64, 'point_size');
        const commands = paths.flatMap((path) => [
          { command: 'VO', param: `${path} Point Show ${onOff(params.show_point)}${size === undefined ? '' : ` Size ${size}`}` },
          ...(params.show_model === undefined ? [] : [{ command: 'VO', param: `${path} Model Show ${onOff(params.show_model)}` }]),
        ]);
        const result = await sendBatch(manager, commands);
        return visualizationMutationResult(result, paths.length, ['调用 verify_object_display_state 可读回 ShowPoint、PointSize 和 ShowModel']);
      },
    },
    {
      name: 'set_orbit_display',
      description: '批量控制对象轨道线显示。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: { type: 'object', properties: { paths: { type: 'array', description: '对象路径数组' }, show: { type: 'boolean', description: '是否显示轨道线' } }, required: ['paths', 'show'] },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const result = await sendBatch(manager, paths.map((path) => ({ command: 'Graphics', param: `${path} Basic Orbit ${onOff(params.show)}` })));
        return visualizationMutationResult(result, paths.length);
      },
    },
    {
      name: 'set_label_display',
      description: '批量控制对象标签显示。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: { type: 'object', properties: { paths: { type: 'array', description: '对象路径数组' }, show: { type: 'boolean', description: '是否显示标签' } }, required: ['paths', 'show'] },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const result = await sendBatch(manager, paths.map((path) => ({ command: 'Graphics', param: `${path} Label Show ${onOff(params.show)}` })));
        return visualizationMutationResult(result, paths.length);
      },
    },
    {
      name: 'set_3d_model_display',
      description: '批量控制对象三维模型显示。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: { type: 'object', properties: { paths: { type: 'array', description: '对象路径数组' }, show: { type: 'boolean', description: '是否显示三维模型' } }, required: ['paths', 'show'] },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const result = await sendBatch(manager, paths.map((path) => ({ command: 'VO', param: `${path} Model Show ${onOff(params.show)}` })));
        return visualizationMutationResult(result, paths.length);
      },
    },
    {
      name: 'color_objects_by_attribute',
      description: '按对象到颜色的映射批量着色，颜色支持官方编号、名称或 %RRRGGGBBB。',
      metadata: { category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: {
        type: 'object', properties: {
          objects: { type: 'array', description: '每项包含 path 和 color' },
        }, required: ['objects'],
      },
      execute: async (params) => {
        const objects = recordArray(params.objects, limits.maxObjectCount).map((entry) => ({ path: safeObjectPath(entry.path), color: safeColor(entry.color) }));
        const result = await sendBatch(manager, objects.map((entry) => ({ command: 'Graphics', param: `${entry.path} SetColor ${entry.color}` })));
        return visualizationMutationResult(result, objects.length);
      },
    },
    {
      name: 'verify_object_display_state',
      description: '把对象导出到 Session 临时文件并读回二维/三维显示字段，同时检查当前时刻位置是否有效。',
      metadata: { readOnly: true, concurrencySafe: false, category: 'visualization', defaultTimeoutMs: 600_000 },
      parameters: {
        type: 'object', properties: {
          paths: { type: 'array', description: '要验证的对象路径数组' },
          time: { type: 'string', description: '可选位置检查时刻' },
        }, required: ['paths'],
      },
      execute: async (params) => {
        const paths = stringArray(params.paths, limits.maxObjectCount).map(safeObjectPath);
        const workspace = await createASCIIStagingWorkspace(session.sessionId, 'display-verify');
        const files = paths.map((path, index) => workspace.path(`${index}-${createHash('sha1').update(path).digest('hex').slice(0, 10)}.xml`));
        try {
          const exports = await sendBatch(manager, paths.map((path, index) => ({ command: 'SaveAs', param: `/ ${path} "${safeQuotedPath(files[index])}"` })));
          const positionSuffix = params.time === undefined ? '' : ` "${String(params.time).replace(/"/g, '')}"`;
          const positions = await sendBatch(manager, paths.map((path) => ({ command: 'Position', param: `${path}${positionSuffix}` })));
          const states = await Promise.all(paths.map(async (path, index) => {
            const exported = exports.results.find((entry) => entry.index === index)?.success === true && existsSync(files[index]);
            const state = exported ? parseDisplayState(await readFile(files[index], 'utf8'), path) : null;
            const position = positions.results.find((entry) => entry.index === index);
            return {
              path, exported, ...state,
              positionCommandAccepted: position?.success === true,
              hasValidPosition: position?.success === true && hasNonZeroPosition(position.response),
              positionResponse: position?.response ?? null,
            };
          }));
          return JSON.stringify({
            status: exports.success ? 'success' : 'partial_failure', objectCount: paths.length,
            objectsWithValidPosition: states.filter((entry) => entry.hasValidPosition).length,
            objectsWith3dPoint: states.filter((entry) => entry.showPoint === true).length,
            objectsWith3dModel: states.filter((entry) => entry.showModel === true).length,
            states, asciiStaging: true,
            cameraVerification: { available: false, reason: 'ATK 4.0 离线官方 CONNECT 接口未提供相机包围盒或裁剪状态读回' },
            verification: exports.success,
          });
        } finally {
          await workspace.cleanup();
        }
      },
    },
    {
      name: 'get_visualization_capabilities',
      description: '报告当前 ATK 4.0 官方接口中已验证的显示能力及相机控制边界。',
      metadata: { readOnly: true, concurrencySafe: true, category: 'visualization' },
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => JSON.stringify({
        status: 'success',
        supported: ['2d_visibility', 'label_display', 'orbit_display', 'color', '3d_model_display', '3d_point_display', 'point_size', 'position_readback', 'display_state_export_readback'],
        unavailable: ['camera_bounding_box_readback', 'camera_clipping_readback', 'documented_fit_all_camera_command', 'native_single-object_catalog_point_cloud'],
        note: '未在离线官方接口中证实的相机命令不会被猜测执行；可继续通过官方 CONNECT 通用工具调用手册中存在的命令。',
      }),
    },
    {
      name: 'import_orbit_catalog',
      description: '从 JSON 数组或 CSV 文件导入轨道目录，在 sidecar 内批量创建并设置经典轨道。',
      metadata: { category: 'batch', defaultTimeoutMs: 3_600_000 },
      parameters: {
        type: 'object', properties: {
          records: { type: 'array', description: '轨道记录数组' },
          csv_path: { type: 'string', description: 'CSV 文件路径；与 records 二选一' },
          rollback_on_failure: { type: 'boolean', description: '失败时回滚活动事务' },
        }, required: [],
      },
      execute: async (params) => {
        if ((params.records === undefined) === (params.csv_path === undefined)) throw new Error('records 与 csv_path 必须且只能提供一个');
        const rawRecords = params.records !== undefined
          ? recordArray(params.records, limits.maxObjectCount)
          : parseSimpleCsv(await readFile(String(params.csv_path), 'utf8'));
        if (rawRecords.length > limits.maxObjectCount) throw new Error(`目录对象数超过 ${limits.maxObjectCount}`);
        const names = rawRecords.map((entry) => safeName(entry.name));
        const estimatedEphemerisPoints = estimateClassicalPoints(rawRecords);
        const resourceWarnings = await checkPlannedBudget(names.length, estimatedEphemerisPoints);
        const commands = [
          ...names.map((name) => ({ command: 'New', param: `/ Satellite ${name}` })),
          ...rawRecords.map((entry) => ({ command: 'SetState', param: classicalStateParameters(entry) })),
        ];
        const context = currentToolExecutionContext();
        const result = await manager.sendBatch(commands, { timeoutMs: context?.timeoutMs, signal: context?.signal, stopOnError: true });
        const orbitVerification = result.success ? await verifyConfiguredOrbits(names) : [];
        const verified = result.success && orbitVerification.every((entry) => entry.verified);
        let rolledBack = false;
        if (!result.success && params.rollback_on_failure === true && activeTransaction) { await rollbackActiveTransaction(); rolledBack = true; }
        return JSON.stringify({ status: verified ? 'success' : result.success ? 'verification_failed' : 'partial_failure', ...result, catalogObjects: names.length, estimatedEphemerisPoints, orbitVerification, rolledBack, verification: verified, warnings: resourceWarnings });
      },
    },
    {
      name: 'save_scenario_with_policy',
      description: '按 never/checkpoint/overwrite/save_as/autosave 策略保存场景；自动兼容中文路径。',
      metadata: { category: 'save', defaultTimeoutMs: 120_000 },
      parameters: {
        type: 'object', properties: {
          mode: { type: 'string', description: '保存策略', enum: ['never', 'checkpoint', 'overwrite', 'save_as', 'autosave'] },
          target_path: { type: 'string', description: 'save_as/autosave 的目标路径' },
          label: { type: 'string', description: 'checkpoint 标签' },
        }, required: ['mode'],
      },
      execute: async (params) => {
        const mode = String(params.mode);
        if (mode === 'never') return JSON.stringify({ status: 'success', saved: false, mode });
        if (mode === 'overwrite') {
          if (!currentToolExecutionContext()?.allowDestructive) throw new Error('overwrite 需要显式 allowDestructive 授权');
          await send('Save', '/ *');
          return JSON.stringify({ status: 'success', saved: true, mode, unsavedChangesBeforeSave: null, verification: true, warnings: ['ATK 4.0 CONNECT 未提供可靠的未保存修改查询，状态返回 null'] });
        }
        if (mode === 'checkpoint') {
          const label = params.label === undefined ? `Checkpoint_${Date.now()}` : safeName(params.label);
          const path = resolve(session.sessionDir, 'checkpoints', `${label}.xml`);
          if (existsSync(path)) throw new Error(`检查点已存在: ${label}`);
          const workspace = await createASCIIStagingWorkspace(session.sessionId, 'checkpoint');
          const staging = workspace.path(`${label}.xml`);
          try {
            await send('SaveAs', `/ * "${safeQuotedPath(staging)}"`);
            if (!existsSync(staging)) throw new Error('检查点暂存保存后读回验证失败');
            await copyFileAtomically(staging, path, false);
            return JSON.stringify({ status: 'success', saved: true, mode, path, asciiStaging: true, verification: existsSync(path), artifacts: [{ type: 'checkpoint', path }] });
          } finally {
            await workspace.cleanup();
          }
        }
        if (typeof params.target_path !== 'string' || !params.target_path.trim()) throw new Error(`${mode} 需要 target_path`);
        const target = resolve(params.target_path);
        if (existsSync(target) && !currentToolExecutionContext()?.allowDestructive) throw new Error('目标文件已存在，覆盖需要显式 allowDestructive 授权');
        const extension = extname(target) || '.xml';
        const workspace = await createASCIIStagingWorkspace(session.sessionId, 'scenario-save');
        const staging = workspace.path(`scenario${/^[.][A-Za-z0-9]+$/.test(extension) ? extension : '.xml'}`);
        try {
          await send('SaveAs', `/ * "${safeQuotedPath(staging)}"`);
          if (!existsSync(staging)) throw new Error('ATK 暂存保存后未找到文件');
          await copyFileAtomically(staging, target, existsSync(target));
          return JSON.stringify({ status: 'success', saved: true, mode, targetPath: target, asciiStaging: true, unicodeCompatible: true, verification: existsSync(target), artifacts: [{ type: 'scenario', path: target }] });
        } finally {
          await workspace.cleanup();
        }
      },
    },
    {
      name: 'load_scenario_unicode_safe',
      description: '通过英文暂存目录加载包含中文或特殊字符路径的场景。会替换当前场景。',
      metadata: { destructive: true, category: 'save', defaultTimeoutMs: 180_000 },
      parameters: { type: 'object', properties: { source_path: { type: 'string', description: '场景 XML 文件路径' } }, required: ['source_path'] },
      execute: async (params) => {
        if (typeof params.source_path !== 'string' || !existsSync(params.source_path)) throw new Error('source_path 不存在');
        const source = resolve(params.source_path);
        const workspace = await createASCIIStagingWorkspace(session.sessionId, 'scenario-load');
        const staging = workspace.path(`scenario${asciiExtension(source)}`);
        try {
          await copyFile(source, staging);
          await send('Unload', '/ *').catch(() => '');
          await send('Load', `/ Scenario "${safeQuotedPath(staging)}"`);
          const objects = parseObjectPaths(await send('AllInstanceNames', '/'));
          const scenarioPath = findRootScenarioPath(objects);
          if (!scenarioPath) throw new Error('Unicode 兼容加载后未发现场景，读回验证失败');
          manager.currentScenario = scenarioPath.split('/').pop() ?? null;
          return JSON.stringify({ status: 'success', sourcePath: source, asciiStaging: true, currentScenario: manager.currentScenario, unicodeCompatible: true, verification: true });
        } finally {
          await workspace.cleanup();
        }
      },
    },
    {
      name: 'get_atk_runtime_state',
      description: '从 ATK 读取真实运行状态、版本、当前场景、对象树和分析时间；不依赖 Agent 内存缓存。',
      metadata: { readOnly: true, concurrencySafe: false, category: 'runtime', defaultTimeoutMs: 60_000 },
      parameters: {
        type: 'object',
        properties: { connect: { type: 'boolean', description: '是否在未连接时自动连接或启动 ATK', default: true } },
        required: [],
      },
      execute: async (params) => {
        const connect = params.connect !== false;
        if (!connect && !manager.isConnected()) {
          return JSON.stringify({
            status: 'success', connected: false, connectionState: manager.getState(),
            startedByAgent: manager.wasStartedByAgent(), pid: manager.getManagedPid(),
          });
        }
        const version = await send('GetATKVersion', '/');
        const objectText = await send('AllInstanceNames', '/');
        const timePeriod = await send('GetAnimationData', '* TimePeriod').catch(() => '');
        const currentTime = await send('GetAnimationData', '* CurrentTime').catch(() => '');
        const timeStep = await send('GetAnimationData', '* TimeStep').catch(() => '');
        const scenarioDirectory = await send('GetDirectory', '/ Scenario').catch(() => '');
        const objects = parseObjectPaths(objectText);
        const scenarioPath = findRootScenarioPath(objects);
        const scenario = scenarioPath?.split('/').pop() ?? manager.currentScenario;
        manager.currentScenario = scenario ?? null;
        const binding = manager.getBinding();
        const sceneFingerprint = createHash('sha256').update(JSON.stringify({
          atkPid: binding?.pid ?? null,
          atkStartTime: binding?.startTime ?? null,
          version,
          currentScenario: manager.currentScenario,
          scenarioPath,
          timePeriod,
          objectCount: objects.length,
          objects,
        })).digest('hex');
        await session.updateRuntimeState({
          currentScenario: manager.currentScenario,
          atk: manager.getBinding(),
        });
        await session.updateSceneFingerprint(sceneFingerprint);
        const resources = await getResourceSnapshot(manager.getManagedPid());
        return JSON.stringify({
          status: 'success', connected: true, connectionState: manager.getState(), version,
          currentScenario: manager.currentScenario, scenarioPath, analysisTimePeriod: timePeriod,
          currentAnimationTime: currentTime, animationTimeStep: timeStep,
          scenarioDirectory, sceneFingerprint, objectCount: objects.length, objects,
          startedByAgent: manager.wasStartedByAgent(), pid: manager.getManagedPid(),
          windowTitle: binding?.windowTitle ?? null, isCalculating: false,
          unsavedChanges: null, resources,
        });
      },
    },
    {
      name: 'atk_object_exists',
      description: '查询指定 ATK 对象路径是否真实存在。',
      metadata: { readOnly: true, concurrencySafe: false, category: 'query' },
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'ATK 对象路径，例如 */Satellite/Sat1' } },
        required: ['path'],
      },
      execute: async (params) => {
        const path = safeObjectPath(params.path);
        return JSON.stringify({ status: 'success', path, exists: await exists(path) });
      },
    },
    {
      name: 'ensure_scenario',
      description: '幂等地确保场景存在；已存在则复用，不存在才创建，并读回验证。',
      metadata: { idempotent: true, category: 'scenario', defaultTimeoutMs: 60_000 },
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '英文场景名' },
          central_body: { type: 'string', description: '中心天体', enum: ['Earth', 'Moon', 'Mars'], default: 'Earth' },
        },
        required: ['name'],
      },
      execute: async (params) => {
        const name = safeName(params.name);
        const path = `*/Scenario/${name}`;
        let created = false;
        if (!await exists(path)) {
          const centralBody = params.central_body ?? 'Earth';
          if (!['Earth', 'Moon', 'Mars'].includes(String(centralBody))) throw new Error('central_body 无效');
          await send('New', centralBody === 'Earth' ? `/ Scenario ${name}` : `/ Scenario ${name} CentralBody ${centralBody}`);
          created = true;
        }
        const verified = await exists(path);
        if (!verified) throw new Error(`场景 ${name} 创建后读回验证失败`);
        manager.currentScenario = name;
        await session.updateRuntimeState({
          currentScenario: name,
          atk: manager.getBinding(),
        });
        return JSON.stringify({ status: 'success', name, path, created, verification: true });
      },
    },
    {
      name: 'ensure_atk_object',
      description: '幂等地确保一个官方 ATK 对象存在，支持 Satellite、Facility、Sensor、Aircraft、Ship、GroundVehicle、Constellation、CoverageDefinition。',
      metadata: { idempotent: true, category: 'object', defaultTimeoutMs: 60_000 },
      parameters: {
        type: 'object',
        properties: {
          class_name: {
            type: 'string', description: 'ATK 对象类别',
            enum: ['Satellite', 'Facility', 'Sensor', 'Aircraft', 'Ship', 'GroundVehicle', 'Constellation', 'CoverageDefinition'],
          },
          name: { type: 'string', description: '英文对象名' },
          parent_path: { type: 'string', description: '父对象路径；顶层对象省略，Sensor 等子对象需要填写' },
        },
        required: ['class_name', 'name'],
      },
      execute: async (params) => {
        const className = String(params.class_name);
        const allowed = ['Satellite', 'Facility', 'Sensor', 'Aircraft', 'Ship', 'GroundVehicle', 'Constellation', 'CoverageDefinition'];
        if (!allowed.includes(className)) throw new Error('class_name 无效');
        const name = safeName(params.name);
        const parent = params.parent_path ? safeObjectPath(params.parent_path) : '*';
        const path = parent === '*' ? `*/${className}/${name}` : `${parent}/${className}/${name}`;
        let created = false;
        if (!await exists(path)) {
          await send('New', parent === '*' ? `/ ${className} ${name}` : `${parent} ${className} ${name}`);
          created = true;
        }
        const verified = await exists(path);
        if (!verified) throw new Error(`对象 ${path} 创建后读回验证失败`);
        return JSON.stringify({ status: 'success', className, name, path, created, verification: true });
      },
    },
    {
      name: 'delete_atk_object_if_exists',
      description: '如果对象存在则卸载它；这是破坏性操作。',
      metadata: { idempotent: true, destructive: true, category: 'object' },
      parameters: {
        type: 'object', properties: { path: { type: 'string', description: '要删除的 ATK 对象路径' } }, required: ['path'],
      },
      execute: async (params) => {
        const path = safeObjectPath(params.path);
        const existed = await exists(path);
        if (existed) await send('Unload', `/ ${path}`);
        const verified = !await exists(path);
        if (!verified) throw new Error(`对象 ${path} 删除后读回验证失败`);
        return JSON.stringify({ status: 'success', path, existed, deleted: existed, verification: true });
      },
    },
    {
      name: 'create_scenario_checkpoint',
      description: '把当前 ATK 场景保存为会话检查点，返回可恢复的场景文件路径。',
      metadata: { category: 'checkpoint', defaultTimeoutMs: 120_000 },
      parameters: {
        type: 'object', properties: { label: { type: 'string', description: '检查点英文标签' } }, required: ['label'],
      },
      execute: async (params) => {
        const label = safeName(params.label);
        const path = resolve(session.sessionDir, 'checkpoints', `${label}.xml`);
        const context = currentToolExecutionContext();
        if (existsSync(path) && !context?.allowDestructive) {
          throw new Error(`检查点 ${label} 已存在，覆盖它需要显式授权 allowDestructive`);
        }
        const workspace = await createASCIIStagingWorkspace(session.sessionId, 'checkpoint');
        const staging = workspace.path(`${label}.xml`);
        try {
          await send('SaveAs', `/ * "${safeQuotedPath(staging)}"`);
          if (!existsSync(staging)) throw new Error('ATK 返回成功，但未找到 ASCII 暂存检查点');
          await copyFileAtomically(staging, path, existsSync(path));
          const verified = existsSync(path);
          return JSON.stringify({
            status: 'success', checkpoint: label, path, asciiStaging: true,
            artifacts: [{ type: 'checkpoint', path, description: `ATK scenario checkpoint ${label}` }],
            verification: verified,
          });
        } finally {
          await workspace.cleanup();
        }
      },
    },
    {
      name: 'restore_scenario_checkpoint',
      description: '卸载当前场景并从会话检查点恢复；这是破坏性操作。',
      metadata: { idempotent: true, destructive: true, category: 'checkpoint', defaultTimeoutMs: 120_000 },
      parameters: {
        type: 'object', properties: { label: { type: 'string', description: '要恢复的检查点英文标签' } }, required: ['label'],
      },
      execute: async (params) => {
        const label = safeName(params.label);
        const path = resolve(session.sessionDir, 'checkpoints', `${label}.xml`);
        if (!existsSync(path)) throw new Error(`检查点不存在: ${path}`);
        const workspace = await createASCIIStagingWorkspace(session.sessionId, 'checkpoint-load');
        const staging = workspace.path(`${label}.xml`);
        try {
          await copyFile(path, staging);
          await send('Unload', '/ *').catch(() => '');
          await send('Load', `/ Scenario "${safeQuotedPath(staging)}"`);
          const objects = parseObjectPaths(await send('AllInstanceNames', '/'));
          const scenarioPath = findRootScenarioPath(objects);
          manager.currentScenario = scenarioPath?.split('/').pop() ?? null;
          if (!scenarioPath) throw new Error('检查点加载后未发现场景，读回验证失败');
          return JSON.stringify({
            status: 'success', checkpoint: label, path, asciiStaging: true, currentScenario: manager.currentScenario,
            verification: true,
          });
        } finally {
          await workspace.cleanup();
        }
      },
    },
  ];
}

function assertSuccess(command: string, result: ATKCommandResult): void {
  const normalized = result.response.trim().toUpperCase();
  if (!result.success || normalized.startsWith('NACK') || normalized.startsWith('ERROR')) {
    throw new Error(`${command} 执行失败: ${result.response}`);
  }
}

function safeName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('名称必须以英文字母开头，且只能包含字母、数字和下划线');
  }
  return value;
}

function safeObjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n"\0]/.test(value)) throw new Error('ATK 对象路径无效');
  const path = value.trim();
  if (!(path === '*' || path.startsWith('*/'))) throw new Error('ATK 对象路径必须是 * 或以 */ 开头');
  return path;
}

function safeQuotedPath(path: string): string {
  assertASCIIATKPath(path);
  return path;
}

function asciiExtension(path: string): string {
  const extension = extname(path);
  return /^[.][A-Za-z0-9]{1,10}$/.test(extension) ? extension : '.xml';
}

async function copyFileAtomically(source: string, target: string, allowOverwrite: boolean): Promise<void> {
  if (existsSync(target) && !allowOverwrite) throw new Error(`目标文件已存在: ${target}`);
  const targetDirectory = dirname(target);
  await mkdir(targetDirectory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const temporary = resolve(targetDirectory, `.${basename(target)}.atk-agent-${nonce}.tmp`);
  const backup = resolve(targetDirectory, `.${basename(target)}.atk-agent-${nonce}.bak`);
  await copyFile(source, temporary);
  let backedUp = false;
  try {
    if (existsSync(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(temporary, target);
    if (backedUp) await unlink(backup).catch(() => undefined);
  } catch (cause) {
    if (backedUp && !existsSync(target) && existsSync(backup)) await rename(backup, target).catch(() => undefined);
    throw cause;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function parseObjectPaths(response: string): string[] {
  // ATK may return every instance on one whitespace-delimited line rather than
  // one path per line. Object names created by this product cannot contain
  // whitespace, so tokenising paths is both deterministic and lossless here.
  return (response.match(/\*?\/[^\s,;]+/g) ?? [])
    .map((value) => value.startsWith('*/') ? value : `*${value}`);
}

function findRootScenarioPath(objects: string[]): string | null {
  return objects.find((path) => /^\*\/Scenario\/[^/]+$/i.test(path)) ?? null;
}

function stringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('names 必须是非空数组');
  if (value.length > max) throw new Error(`单批对象数不能超过 ${max}`);
  if (!value.every((entry) => typeof entry === 'string')) throw new Error('names 中每一项都必须是字符串');
  return value;
}

function recordArray(value: unknown, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('satellites 必须是非空数组');
  if (value.length > max) throw new Error(`单批对象数不能超过 ${max}`);
  if (!value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) throw new Error('satellites 每项必须是对象');
  return value as Record<string, unknown>[];
}

function classicalStateParameters(entry: Record<string, unknown>): string {
  const name = safeName(entry.name);
  const propagator = String(entry.propagator ?? 'TwoBody');
  if (!['TwoBody', 'J2Perturbation', 'J4Perturbation', 'HPOP', 'LOP'].includes(propagator)) throw new Error(`卫星 ${name} propagator 无效`);
  const coord = String(entry.coord_system ?? 'J2000');
  if (!['J2000', 'Fixed'].includes(coord)) throw new Error(`卫星 ${name} coord_system 无效`);
  const required = ['start_time', 'end_time', 'orbit_epoch'];
  for (const key of required) if (typeof entry[key] !== 'string' || !entry[key]) throw new Error(`卫星 ${name} 缺少 ${key}`);
  const numeric = ['step_seconds', 'sma', 'ecc', 'inc', 'argp', 'raan', 'ma'];
  for (const key of numeric) if (!Number.isFinite(Number(entry[key]))) throw new Error(`卫星 ${name} 的 ${key} 必须是数值`);
  return [
    `*/Satellite/${name}`, 'Classical', propagator,
    `"${String(entry.start_time)}"`, `"${String(entry.end_time)}"`, Number(entry.step_seconds), coord,
    `"${String(entry.orbit_epoch)}"`, Number(entry.sma), Number(entry.ecc), Number(entry.inc), Number(entry.argp), Number(entry.raan), Number(entry.ma),
  ].join(' ');
}

function onOff(value: unknown): 'On' | 'Off' {
  if (typeof value !== 'boolean') throw new Error('显示开关必须是 boolean');
  return value ? 'On' : 'Off';
}

function safeColor(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z]+|\d{1,3}|%\d{9})$/.test(value)) throw new Error('color 格式无效');
  return value;
}

function parseSimpleCsv(content: string): Record<string, unknown>[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('CSV 至少需要表头和一条数据');
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line, lineIndex) => {
    const values = splitCsvLine(line);
    if (values.length !== headers.length) throw new Error(`CSV 第 ${lineIndex + 2} 行列数不一致`);
    return Object.fromEntries(headers.map((header, index) => [header, numericCsvFields.has(header) ? Number(values[index]) : values[index]]));
  });
}

const numericCsvFields = new Set(['step_seconds', 'sma', 'ecc', 'inc', 'argp', 'raan', 'ma']);

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) { current += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { values.push(current.trim()); current = ''; }
    else current += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  values.push(current.trim());
  return values;
}

async function sendBatch(manager: ATKManager, commands: Array<{ command: string; param: string }>) {
  const context = currentToolExecutionContext();
  return manager.sendBatch(commands, {
    timeoutMs: context?.timeoutMs,
    signal: context?.signal,
    stopOnError: false,
  });
}

function visualizationMutationResult(
  result: Awaited<ReturnType<ATKManager['sendBatch']>>,
  objectCount: number,
  warnings: string[] = [],
): string {
  return JSON.stringify({
    status: result.success ? 'success' : 'partial_failure',
    ...result,
    objectCount,
    commandAccepted: result.success,
    warnings,
  });
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  return number;
}

function parseDisplayState(xml: string, path: string): {
  show2d: boolean | null;
  showLabel: boolean | null;
  showOrbit: boolean | null;
  color: number | null;
  showModel: boolean | null;
  showPoint: boolean | null;
  pointSize: number | null;
  hasConfiguredOrbitState: boolean;
} {
  const objectXml = extractObjectXml(xml, path) ?? xml;
  const numberTag = (tag: string): number | null => {
    const match = new RegExp(`<${tag}>(-?[\\d.]+)</${tag}>`, 'i').exec(objectXml);
    return match ? Number(match[1]) : null;
  };
  const model = /<GfxModel\b([^>]*)\/?\s*>/i.exec(objectXml)?.[1] ?? '';
  const attribute = (name: string): number | null => {
    const match = new RegExp(`\\b${name}="(-?\\d+)"`, 'i').exec(model);
    return match ? Number(match[1]) : null;
  };
  const boolean = (value: number | null): boolean | null => value === null ? null : value !== 0;
  return {
    show2d: boolean(numberTag('GfxShow')),
    showLabel: boolean(numberTag('GfxShowLabel')),
    showOrbit: boolean(numberTag('GfxShowOrbit')),
    color: numberTag('GfxColor'),
    showModel: boolean(attribute('ShowModel')),
    showPoint: boolean(attribute('ShowPoint')),
    pointSize: attribute('PointSize'),
    hasConfiguredOrbitState: hasNonZeroSavedPosition(objectXml),
  };
}

function extractObjectXml(xml: string, path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const className = segments.at(-2);
  const name = segments.at(-1);
  if (!className || !name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(className) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${className}\\s+Name="${escaped}"[^>]*>[\\s\\S]*?</${className}>`, 'i').exec(xml)?.[0] ?? null;
}

function hasNonZeroSavedPosition(xml: string): boolean {
  const values = [...xml.matchAll(/<Position[XYZ]>(-?[\d.]+)</gi)].map((match) => Number(match[1]));
  return values.some((value) => Number.isFinite(value) && Math.abs(value) > 1e-6);
}

function hasNonZeroPosition(response: string): boolean {
  const values = response.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  return values.length >= 3 && values.slice(0, 3).some((value) => Math.abs(value) > 1e-6);
}

function estimateClassicalPoints(entries: Record<string, unknown>[]): number | undefined {
  let total = 0;
  for (const entry of entries) {
    const start = Date.parse(String(entry.start_time ?? ''));
    const stop = Date.parse(String(entry.end_time ?? ''));
    const step = Number(entry.step_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start || !Number.isFinite(step) || step <= 0) return undefined;
    total += Math.floor((stop - start) / 1000 / step) + 1;
  }
  return total;
}
