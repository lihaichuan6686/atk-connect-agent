import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonStatus } from '../src/daemon/client.js';

describe('Windows daemon permission boundary', () => {
  it.skipIf(process.platform !== 'win32')('does not start over a live but inaccessible daemon', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'atk-daemon-permission-'));
    const sessionId = 'permission-test';
    const sessionDir = join(dataRoot, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'daemon.json'), JSON.stringify({
      pid: process.pid,
      endpoint: '\\\\.\\pipe\\atk-agent-deliberately-missing',
    }));
    await writeFile(join(sessionDir, '.lock'), JSON.stringify({ pid: process.pid }));

    await expect(daemonStatus(dataRoot, sessionId)).rejects.toMatchObject({
      code: 'DAEMON_PERMISSION_MISMATCH',
      details: { sessionId, daemonPid: process.pid },
    });
    await expect(daemonStatus(dataRoot, sessionId, process.pid)).resolves.toBeNull();
  });
});
