import { appendFile, mkdir, open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ArtifactRecord, ProductEvent, ToolExecutionEnvelope } from './contracts.js';
import { EVENT_SCHEMA_VERSION } from './contracts.js';

export interface SessionManifest {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'completed' | 'failed' | 'closed';
  agentVersion: string;
  atkVersion?: string;
  currentScenario?: string | null;
  atk?: ATKInstanceBinding;
  operation?: SessionOperationState;
  sceneFingerprint?: string | null;
  artifacts: ArtifactRecord[];
  runs: Array<{ runId: string; status: string; updatedAt: string }>;
}

export interface ATKInstanceBinding {
  startedByAgent: boolean;
  pid: number | null;
  startTime?: string | null;
  executablePath?: string | null;
  connectPort?: number;
  windowTitle?: string | null;
}

export interface SessionOperationState {
  status: 'idle' | 'busy' | 'cancelling' | 'failed';
  operationId?: string | null;
  tool?: string | null;
  startedAt?: string | null;
  cancelRequested?: boolean;
  atkTerminationConfirmed?: boolean | null;
  progress?: { completed: number; total: number; succeeded?: number; failed?: number; percent: number };
  resourceSnapshot?: Record<string, unknown>;
}

export class SessionStore {
  private sequence = 0;
  private sequenceHydrated = false;
  readonly sessionDir: string;
  readonly eventsPath: string;
  readonly commandsPath: string;
  readonly manifestPath: string;
  private lockHandle: FileHandle | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private manifestTail: Promise<void> = Promise.resolve();

  constructor(
    rootDir: string,
    readonly sessionId: string,
    private readonly agentVersion: string,
  ) {
    assertSessionId(sessionId);
    this.sessionDir = resolve(rootDir, 'sessions', sessionId);
    this.eventsPath = resolve(this.sessionDir, 'events.jsonl');
    this.commandsPath = resolve(this.sessionDir, 'commands.jsonl');
    this.manifestPath = resolve(this.sessionDir, 'manifest.json');
  }

  static createId(): string {
    return `session-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  }

  async initialize(): Promise<SessionManifest> {
    await mkdir(resolve(this.sessionDir, 'artifacts'), { recursive: true });
    await mkdir(resolve(this.sessionDir, 'checkpoints'), { recursive: true });
    const existing = await this.readManifest();
    if (existing) {
      await this.hydrateSequence();
      return existing;
    }
    const now = new Date().toISOString();
    const manifest: SessionManifest = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      sessionId: this.sessionId,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      agentVersion: this.agentVersion,
      artifacts: [],
      runs: [],
    };
    await this.writeManifestNow(manifest);
    this.sequenceHydrated = true;
    return manifest;
  }

  async acquireLock(): Promise<void> {
    if (this.lockHandle) return;
    await mkdir(this.sessionDir, { recursive: true });
    const lockPath = resolve(this.sessionDir, '.lock');
    try {
      this.lockHandle = await open(lockPath, 'wx');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      const stale = await isStaleLock(lockPath);
      if (!stale) throw new Error(`会话 ${this.sessionId} 正被另一个进程使用`);
      await unlink(lockPath).catch(() => undefined);
      this.lockHandle = await open(lockPath, 'wx');
    }
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
  }

  async releaseLock(): Promise<void> {
    if (!this.lockHandle) return;
    const lockPath = resolve(this.sessionDir, '.lock');
    await this.lockHandle.close().catch(() => undefined);
    this.lockHandle = null;
    await unlink(lockPath).catch(() => undefined);
  }

  async appendEvent(
    runId: string,
    type: ProductEvent['type'],
    payload: Record<string, unknown>,
  ): Promise<ProductEvent> {
    return this.withQueue('event', async () => {
      await this.initialize();
      const event: ProductEvent = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        sequence: ++this.sequence,
        timestamp: new Date().toISOString(),
        runId,
        sessionId: this.sessionId,
        type,
        payload: sanitize(payload) as Record<string, unknown>,
      };
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
      return event;
    });
  }

  async recordToolResult(runId: string, result: ToolExecutionEnvelope): Promise<void> {
    await this.recordCommands(runId, result.rawCommands);
    await this.appendEvent(runId, 'tool.finished', {
      tool: result.tool,
      success: result.success,
      executionStatus: result.executionStatus,
      verificationStatus: result.verificationStatus,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  async recordCommands(runId: string, commands: ToolExecutionEnvelope['rawCommands']): Promise<void> {
    if (commands.length > 0) {
      const manifest = await this.readManifest();
      await appendFile(this.commandsPath, commands.map((entry) => JSON.stringify({
        schemaVersion: EVENT_SCHEMA_VERSION,
        runId,
        sessionId: this.sessionId,
        atkPid: manifest?.atk?.pid ?? null,
        scenario: manifest?.currentScenario ?? null,
        scenarioFingerprint: manifest?.sceneFingerprint ?? null,
        startedAt: entry.startedAt ?? entry.timestamp,
        completedAt: entry.completedAt ?? new Date(new Date(entry.timestamp).getTime() + entry.durationMs).toISOString(),
        atkStillBusy: manifest?.operation?.status === 'busy' || manifest?.operation?.status === 'cancelling',
        ...entry,
      })).join('\n') + '\n', 'utf8');
    }
  }

  async readManifest(): Promise<SessionManifest | null> {
    if (!existsSync(this.manifestPath)) return null;
    try {
      return JSON.parse(await readFile(this.manifestPath, 'utf8')) as SessionManifest;
    } catch {
      return null;
    }
  }

  async writeManifest(manifest: SessionManifest): Promise<void> {
    await this.withQueue('manifest', () => this.writeManifestNow(manifest));
  }

  private async writeManifestNow(manifest: SessionManifest): Promise<void> {
    await mkdir(dirname(this.manifestPath), { recursive: true });
    const next = { ...manifest, updatedAt: new Date().toISOString() };
    const temp = `${this.manifestPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await import('node:fs/promises').then(({ rename }) => rename(temp, this.manifestPath));
  }

  async recordRun(runId: string, status: string): Promise<void> {
    await this.mutateManifest((manifest) => {
      const runs = manifest.runs.filter((run) => run.runId !== runId);
      runs.push({ runId, status, updatedAt: new Date().toISOString() });
      return {
        ...manifest,
        status: status === 'failed' ? 'failed' : manifest.status,
        runs: runs.slice(-500),
      };
    });
  }

  async addArtifacts(artifacts: ArtifactRecord[]): Promise<void> {
    if (artifacts.length === 0) return;
    await this.mutateManifest((manifest) => {
      const byPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
      for (const artifact of artifacts) byPath.set(artifact.path, artifact);
      return { ...manifest, artifacts: [...byPath.values()] };
    });
  }

  async updateRuntimeState(state: Pick<SessionManifest, 'currentScenario' | 'atk'>): Promise<void> {
    await this.mutateManifest((manifest) => {
      const atk = manifest.atk?.startedByAgent && !state.atk?.startedByAgent
        ? manifest.atk
        : state.atk ?? manifest.atk;
      return {
        ...manifest,
        currentScenario: state.currentScenario ?? manifest.currentScenario,
        atk,
      };
    });
  }

  async updateOperation(operation: SessionOperationState): Promise<void> {
    await this.mutateManifest((manifest) => ({ ...manifest, operation }));
  }

  async updateSceneFingerprint(sceneFingerprint: string | null): Promise<void> {
    await this.mutateManifest((manifest) => ({ ...manifest, sceneFingerprint }));
  }

  async bindInstance(atk: ATKInstanceBinding | undefined): Promise<void> {
    await this.mutateManifest((manifest) => ({ ...manifest, atk }));
  }

  async close(status: 'completed' | 'failed' | 'closed' = 'closed'): Promise<void> {
    await this.mutateManifest((manifest) => ({ ...manifest, status }));
  }

  async sha256(path: string): Promise<string> {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  }

  private async hydrateSequence(): Promise<void> {
    if (this.sequenceHydrated) return;
    this.sequenceHydrated = true;
    if (!existsSync(this.eventsPath)) return;
    try {
      const lines = (await readFile(this.eventsPath, 'utf8')).trim().split('\n');
      const last = lines.at(-1);
      if (!last) return;
      const parsed = JSON.parse(last) as { sequence?: unknown };
      if (typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)) {
        this.sequence = parsed.sequence;
      }
    } catch {
      // 损坏的历史事件不阻止新事件追加；sequence 从 0 重新开始并由审计发现。
    }
  }

  private async mutateManifest(
    mutation: (manifest: SessionManifest) => SessionManifest,
  ): Promise<void> {
    await this.withQueue('manifest', async () => {
      const manifest = await this.initialize();
      await this.writeManifestNow(mutation(manifest));
    });
  }

  private async withQueue<T>(queue: 'event' | 'manifest', operation: () => Promise<T>): Promise<T> {
    const previous = queue === 'event' ? this.eventTail : this.manifestTail;
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    if (queue === 'event') this.eventTail = next;
    else this.manifestTail = next;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return true;
    try { process.kill(parsed.pid, 0); return false; } catch { return true; }
  } catch {
    return true;
  }
}

function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) {
    throw new Error('sessionId 只能包含字母、数字、点、下划线和连字符，长度不超过 128');
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /api.?key|authorization|token|secret|password/i.test(key) ? '[REDACTED]' : sanitize(child);
  }
  return output;
}
