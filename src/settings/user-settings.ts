import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ProviderName = 'deepseek' | 'qwen' | 'openai' | 'ollama';

interface StoredSecret {
  storage: 'dpapi';
  payload: string;
}

interface StoredSettings {
  version: 1;
  provider: ProviderName;
  baseURL: string;
  model: string;
  apiKey?: StoredSecret;
}

export interface UserSettings {
  provider: ProviderName;
  baseURL: string;
  model: string;
  apiKey: string;
}

export function getUserSettingsPath(): string {
  const override = process.env.ATK_AGENT_CONFIG_DIR;
  const base = override || process.env.APPDATA || process.env.LOCALAPPDATA;
  if (!base) {
    throw new Error('无法确定用户配置目录，请设置 ATK_AGENT_CONFIG_DIR');
  }
  return join(base, 'ATK Agent', 'config.json');
}

export function hasUserSettings(): boolean {
  return existsSync(getUserSettingsPath());
}

export function loadUserSettings(): UserSettings | null {
  const path = getUserSettingsPath();
  if (!existsSync(path)) return null;

  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredSettings;
    if (stored.version !== 1 || !stored.provider || !stored.baseURL || !stored.model) {
      return null;
    }
    return {
      provider: stored.provider,
      baseURL: stored.baseURL,
      model: stored.model,
      apiKey: stored.apiKey ? unprotectSecret(stored.apiKey.payload) : '',
    };
  } catch {
    return null;
  }
}

export function saveUserSettings(settings: UserSettings): void {
  const path = getUserSettingsPath();
  mkdirSync(dirname(path), { recursive: true });

  const stored: StoredSettings = {
    version: 1,
    provider: settings.provider,
    baseURL: settings.baseURL,
    model: settings.model,
  };
  if (settings.apiKey) {
    stored.apiKey = { storage: 'dpapi', payload: protectSecret(settings.apiKey) };
  }

  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function protectSecret(secret: string): string {
  assertWindows();
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$value = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($value)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
    '[Console]::Out.Write([Convert]::ToBase64String($encrypted))',
  ].join('; ');
  return runPowerShell(script, secret);
}

function unprotectSecret(payload: string): string {
  assertWindows();
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$value = [Console]::In.ReadToEnd()',
    '$bytes = [Convert]::FromBase64String($value)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
  ].join('; ');
  return runPowerShell(script, payload);
}

function runPowerShell(script: string, input: string): string {
  return execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input, encoding: 'utf8', windowsHide: true },
  ).trim();
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('当前安全存储实现需要 Windows DPAPI');
  }
}
