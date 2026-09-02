import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ATKAgentError } from '../core/errors.js';

const ASCII_PATH = /^[\x20-\x7e]+$/;

export interface ASCIIStagingWorkspace {
  directory: string;
  path(name: string): string;
  cleanup(): Promise<void>;
}

export async function createASCIIStagingWorkspace(sessionId: string, purpose: string): Promise<ASCIIStagingWorkspace> {
  const root = await ensureASCIIStagingRoot();
  const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const safePurpose = purpose.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'io';
  const sessionRoot = resolve(root, sessionHash);
  await mkdir(sessionRoot, { recursive: true });
  const directory = await mkdtemp(join(sessionRoot, `${safePurpose}-`));
  assertASCIIATKPath(directory);
  return {
    directory,
    path(name: string): string {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new ATKAgentError('INVALID_INPUT', 'ASCII 暂存文件名包含非 ASCII 或路径字符');
      const output = resolve(directory, name);
      if (!output.startsWith(`${directory}${sep}`)) throw new ATKAgentError('INVALID_INPUT', 'ASCII 暂存路径越界');
      assertASCIIATKPath(output);
      return output;
    },
    async cleanup(): Promise<void> {
      if (directory.startsWith(`${sessionRoot}${sep}`)) await rm(directory, { recursive: true, force: true });
    },
  };
}

export function assertASCIIATKPath(path: string): void {
  if (!isAbsolute(path) || !ASCII_PATH.test(path) || /["\r\n\0]/.test(path)) {
    throw new ATKAgentError('INVALID_INPUT', '传给 ATK 的文件路径必须是无引号、无控制字符的纯 ASCII 绝对路径', { path });
  }
}

export function isASCIIATKPath(path: string): boolean {
  return isAbsolute(path) && ASCII_PATH.test(path) && !/["\r\n\0]/.test(path);
}

async function ensureASCIIStagingRoot(): Promise<string> {
  const configured = process.env.ATK_AGENT_ASCII_TEMP?.trim();
  const candidates = [
    configured,
    resolve(tmpdir(), 'atk-agent'),
    process.platform === 'win32' ? resolve(process.env.SystemDrive || 'C:', '\\atk-agent-temp') : undefined,
  ].filter((value): value is string => Boolean(value));
  const failures: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (!isASCIIATKPath(path)) {
      failures.push({ path, reason: 'not_ascii' });
      continue;
    }
    try {
      await mkdir(path, { recursive: true });
      await access(path, constants.R_OK | constants.W_OK);
      return path;
    } catch (cause) {
      failures.push({ path, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  throw new ATKAgentError('CONFIGURATION_ERROR', '找不到可写的纯 ASCII ATK 暂存目录；请设置 ATK_AGENT_ASCII_TEMP', { failures });
}
