import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getUserSettingsPath,
  hasUserSettings,
  loadUserSettings,
  saveUserSettings,
} from '../src/settings/user-settings.js';

let testDirectory: string | null = null;

afterEach(() => {
  delete process.env.ATK_AGENT_CONFIG_DIR;
  if (testDirectory) rmSync(testDirectory, { recursive: true, force: true });
  testDirectory = null;
});

describe('user settings', () => {
  it('round-trips settings while keeping the API key out of plaintext JSON', () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'atk-agent-settings-'));
    process.env.ATK_AGENT_CONFIG_DIR = testDirectory;

    saveUserSettings({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'secret-test-key',
    });

    expect(hasUserSettings()).toBe(true);
    expect(loadUserSettings()).toEqual({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'secret-test-key',
    });
    expect(readFileSync(getUserSettingsPath(), 'utf8')).not.toContain('secret-test-key');
  });
});
