import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertASCIIATKPath, createASCIIStagingWorkspace, isASCIIATKPath } from '../src/atk/ascii-staging.js';

const original = process.env.ATK_AGENT_ASCII_TEMP;

afterEach(() => {
  if (original === undefined) delete process.env.ATK_AGENT_ASCII_TEMP;
  else process.env.ATK_AGENT_ASCII_TEMP = original;
});

describe('ASCII ATK staging', () => {
  it('hashes a Unicode Session id and produces an ASCII-only ATK path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atk-ascii-test-'));
    expect(isASCIIATKPath(root)).toBe(true);
    process.env.ATK_AGENT_ASCII_TEMP = root;
    const workspace = await createASCIIStagingWorkspace('空间轨道设计竞赛/会话', '显示验证');
    try {
      const path = workspace.path('object.xml');
      expect(isASCIIATKPath(path)).toBe(true);
      expect(path).not.toContain('空间');
      expect(path.startsWith(resolve(root))).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });

  it('rejects Unicode or relative paths before they reach ATK', () => {
    expect(() => assertASCIIATKPath('D:\\空间轨道设计竞赛\\scene.xml')).toThrow('纯 ASCII');
    expect(() => assertASCIIATKPath('.\\scene.xml')).toThrow('纯 ASCII');
  });
});
