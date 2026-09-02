import { createHash } from 'node:crypto';
import type { ATKManager } from './manager.js';

export interface SceneIdentity {
  atkPid: number | null;
  atkStartTime: string | null;
  version: string;
  currentScenario: string | null;
  scenarioPath: string | null;
  timePeriod: string;
  objectCount: number;
  objects: string[];
  fingerprint: string;
}

export async function readSceneIdentity(manager: ATKManager): Promise<SceneIdentity> {
  await manager.ensureConnected();
  const version = clean(await manager.sendCommand('GetATKVersion', '/'));
  const objectText = clean(await manager.sendCommand('AllInstanceNames', '/'));
  const time = await manager.sendCommand('GetAnimationData', '* TimePeriod');
  const timePeriod = time.success ? time.response.trim() : '';
  const objects = parseObjectPaths(objectText);
  const scenarioPath = objects.find((path) => /^\*\/Scenario\/[^/]+$/i.test(path)) ?? null;
  const currentScenario = scenarioPath?.split('/').pop() ?? null;
  const binding = manager.getBinding();
  const core = {
    atkPid: binding?.pid ?? null,
    atkStartTime: binding?.startTime ?? null,
    version,
    currentScenario,
    scenarioPath,
    timePeriod,
    objectCount: objects.length,
    objects,
  };
  return { ...core, fingerprint: createHash('sha256').update(JSON.stringify(core)).digest('hex') };
}

function clean(result: { success: boolean; response: string }): string {
  if (!result.success) throw new Error(result.response || 'ATK 状态读取失败');
  return result.response.trim();
}

export function parseObjectPaths(response: string): string[] {
  return (response.match(/\*?\/[^\s,;]+/g) ?? [])
    .map((value) => value.startsWith('*/') ? value : `*${value}`);
}
