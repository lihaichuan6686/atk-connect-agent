import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/session-store.js';

describe('SessionStore', () => {
  it('persists append-only JSONL events and a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-agent-session-'));
    const store = new SessionStore(root, 'acceptance-test', 'test');
    const manifest = await store.initialize();
    expect(manifest.status).toBe('active');
    const event = await store.appendEvent('run-1', 'run.started', {
      apiKey: 'must-not-leak',
      prompt: 'hello',
    });
    expect(event.sequence).toBe(1);
    const raw = await readFile(store.eventsPath, 'utf8');
    expect(raw).toContain('"apiKey":"[REDACTED]"');
    expect(raw).not.toContain('must-not-leak');
  });

  it('rejects path-like session ids', () => {
    expect(() => new SessionStore('C:\\tmp', '..\\escape', 'test')).toThrow('sessionId');
  });

  it('preserves ATK ownership when a later process only reconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-agent-session-'));
    const store = new SessionStore(root, 'ownership', 'test');
    await store.initialize();
    await store.updateRuntimeState({
      currentScenario: 'Demo', atk: { startedByAgent: true, pid: 1234 },
    });
    await store.updateRuntimeState({
      currentScenario: null, atk: { startedByAgent: false, pid: null },
    });
    expect(await store.readManifest()).toMatchObject({
      currentScenario: 'Demo', atk: { startedByAgent: true, pid: 1234 },
    });
  });

  it('continues event sequence numbers after a new process resumes the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-agent-session-'));
    const first = new SessionStore(root, 'resume', 'test');
    await first.appendEvent('run-1', 'run.started', {});
    const resumed = new SessionStore(root, 'resume', 'test');
    const event = await resumed.appendEvent('run-2', 'run.started', {});
    expect(event.sequence).toBe(2);
  });

  it('prevents two runtimes from mutating the same session concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-agent-session-'));
    const first = new SessionStore(root, 'locked', 'test');
    const second = new SessionStore(root, 'locked', 'test');
    await first.acquireLock();
    await expect(second.acquireLock()).rejects.toThrow('正被另一个进程使用');
    await first.releaseLock();
    await expect(second.acquireLock()).resolves.toBeUndefined();
    await second.releaseLock();
  });

  it('keeps concurrent events ordered and concurrent run updates lossless', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-agent-session-'));
    const store = new SessionStore(root, 'concurrent', 'test');
    await store.initialize();
    const events = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.appendEvent(`run-${index}`, 'run.started', { index })
    )));
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.recordRun(`run-${index}`, 'completed')
    )));
    expect((await store.readManifest())?.runs).toHaveLength(20);
  });
});
