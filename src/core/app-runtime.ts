import { resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../config.js';
import { ATKManager } from '../atk/manager.js';
import { createATKTools, utilityTools } from '../atk/tools/index.js';
import { ToolRegistry } from './tool-registry.js';
import { SessionStore } from './session-store.js';
import { VERSION } from '../version.js';
import type { AITool, ToolExecutionContext } from '../types.js';
import type { ToolExecutionEnvelope } from './contracts.js';
import { createProductATKTools } from '../atk/tools/product.js';
import { assessResourceBudget, enforceResourceBudget, getResourceSnapshot } from '../atk/resources.js';
import { readSceneIdentity } from '../atk/scene-fingerprint.js';
import { ATKAgentError } from './errors.js';

export interface ProductRuntimeOptions {
  config?: AppConfig;
  sessionId?: string;
  dataRoot?: string;
  allowNewATK?: boolean;
}

export class ProductRuntime {
  readonly config: AppConfig;
  readonly manager: ATKManager;
  readonly registry: ToolRegistry;
  readonly session: SessionStore;

  constructor(options: ProductRuntimeOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.manager = new ATKManager(this.config.atk, { allowNewATK: options.allowNewATK });
    const sessionId = options.sessionId ?? SessionStore.createId();
    this.session = new SessionStore(options.dataRoot ?? getAgentDataRoot(), sessionId, VERSION);
    this.registry = new ToolRegistry(
      [...utilityTools, ...createATKTools(this.manager), ...createProductATKTools(this.manager, this.session, this.config.atk.resourceLimits)],
      this.manager,
    );
  }

  async initialize(): Promise<void> {
    await this.session.acquireLock();
    try {
      const manifest = await this.session.initialize();
      this.manager.setBinding(manifest.atk);
    } catch (cause) {
      await this.session.releaseLock();
      throw cause;
    }
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext & { timeoutMs?: number } = {},
  ): Promise<ToolExecutionEnvelope> {
    const tool = this.registry.get(name);
    const metadata = this.registry.metadata(name);
    let resourceWarnings: string[] = [];
    if (tool && metadata && !context.dryRun && !metadata.readOnly && metadata.category !== 'safety') {
      await this.manager.ensureConnected();
      const manifest = await this.session.readManifest();
      if (manifest?.sceneFingerprint) {
        const actual = await readSceneIdentity(this.manager);
        this.manager.currentScenario = actual.currentScenario;
        if (actual.fingerprint !== manifest.sceneFingerprint) {
          throw new ATKAgentError('ATTACH_FAILED', 'ATK 场景指纹与 Session 记录不一致，拒绝向可能错误的窗口发送写命令', {
            expected: manifest.sceneFingerprint, actual,
          });
        }
      }
      const objectsResult = await this.manager.sendCommand('AllInstanceNames', '/', { timeoutMs: 10_000, signal: context.signal });
      const objectCount = objectsResult.success
        ? (objectsResult.response.match(/\*?\/[^\s,;]+/g) ?? []).length
        : 0;
      const snapshot = await getResourceSnapshot(this.manager.getManagedPid());
      const assessment = assessResourceBudget(snapshot, this.config.atk.resourceLimits, { objectCount });
      enforceResourceBudget(assessment);
      resourceWarnings = assessment.warnings;
    }
    const result = await this.registry.execute(name, input, context);
    if (resourceWarnings.length > 0) result.warnings.unshift(...resourceWarnings);
    if (result.success && metadata && !metadata.readOnly && !context.dryRun && this.manager.isConnected()) {
      const identity = await readSceneIdentity(this.manager);
      this.manager.currentScenario = identity.currentScenario;
      await this.session.updateSceneFingerprint(identity.fingerprint);
      await this.session.updateRuntimeState({ currentScenario: identity.currentScenario, atk: this.manager.getBinding() });
    }
    if (context.runId) {
      if (context.recordToolEvent !== false) await this.session.recordToolResult(context.runId, result);
      else if (result.rawCommands.length > 0) await this.session.recordCommands(context.runId, result.rawCommands);
      await this.session.addArtifacts(result.artifacts);
    }
    return result;
  }

  agentTools(context: ToolExecutionContext = {}): AITool[] {
    return this.registry.list().map((tool) => ({
      ...tool,
      execute: async (input, callContext) => {
        const result = await this.executeTool(tool.name, input, { ...context, ...callContext });
        const serialized = JSON.stringify(result);
        return result.success ? serialized : `Error: ${serialized}`;
      },
    }));
  }

  async dispose(options: { keepATKAlive?: boolean } = {}): Promise<void> {
    try {
      await this.manager.dispose(options);
    } finally {
      await this.session.releaseLock();
    }
  }

  setAllowNewATK(allow: boolean): void {
    this.manager.setAllowNewATK(allow);
  }
}

export function getAgentDataRoot(): string {
  const configured = process.env.ATK_AGENT_HOME;
  if (configured) return resolve(configured);
  // 会话、命令日志和产物属于当前任务目录，默认采用项目本地存储。
  return resolve(process.cwd(), '.atk-agent');
}
