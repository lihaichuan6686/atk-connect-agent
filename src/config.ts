/**
 * ATK Agent CLI — 配置管理
 *
 * 从环境变量加载配置，支持 .env 文件和默认值。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUserSettings } from './settings/user-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 手动加载 .env 文件（不引入 dotenv 依赖）
 * 仅在环境变量未设置时填充
 */
const fileEnv: Record<string, string> = {};

function loadEnvFile(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去除引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fileEnv[key] = value;
  }
}

loadEnvFile();

function getEnv(key: string, userValue = '', defaultValue = ''): string {
  return process.env[key] || userValue || fileEnv[key] || defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key] || fileEnv[key];
  if (!val) return defaultValue;
  const num = parseInt(val, 10);
  return isNaN(num) ? defaultValue : num;
}

// ============================================================
// 配置接口
// ============================================================

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
  /** Ollama 专用 */
  ollamaBaseURL: string;
  ollamaModel: string;
}

export interface ATKConfig {
  exePath: string;
  host: string;
  port: number;
  startupWait: number;
  /** ATK Python 模块路径（sidecar 过渡阶段） */
  pythonModulePath: string;
  /** Python 解释器 */
  pythonExe: string;
  resourceLimits: ResourceLimits;
}

export interface ResourceLimits {
  maxAtkMemoryGB: number;
  minSystemFreeMemoryGB: number;
  maxGpuMemoryPercent: number;
  maxObjectCount: number;
  maxEstimatedEphemerisPoints: number;
}

export interface AppConfig {
  llm: LLMConfig;
  atk: ATKConfig;
  debug: boolean;
}

// ============================================================
// 配置加载
// ============================================================

export function loadConfig(): AppConfig {
  const user = loadUserSettings();
  return {
    llm: {
      provider: getEnv('AI_PROVIDER', user?.provider, 'deepseek'),
      apiKey: getEnv('AI_API_KEY', user?.apiKey),
      model: getEnv('AI_MODEL', user?.model, 'deepseek-chat'),
      baseURL: getEnv('AI_BASE_URL', user?.baseURL, 'https://api.deepseek.com/v1'),
      ollamaBaseURL: getEnv('OLLAMA_BASE_URL', user?.baseURL, 'http://localhost:11434'),
      ollamaModel: getEnv('OLLAMA_MODEL', user?.model, 'qwen2.5'),
    },
    atk: {
      exePath: getEnv('ATK_EXE_PATH'),
      host: getEnv('ATK_HOST', '', '127.0.0.1'),
      port: getEnvInt('ATK_PORT', 6655),
      startupWait: getEnvInt('ATK_STARTUP_WAIT', 8),
      pythonModulePath: getEnv('ATK_PYTHON_PATH'),
      pythonExe: getEnv('PYTHON_EXE', '', 'python'),
      resourceLimits: {
        maxAtkMemoryGB: getEnvNumber('ATK_MAX_MEMORY_GB', 6),
        minSystemFreeMemoryGB: getEnvNumber('ATK_MIN_SYSTEM_FREE_MEMORY_GB', 4),
        maxGpuMemoryPercent: getEnvNumber('ATK_MAX_GPU_MEMORY_PERCENT', 80),
        maxObjectCount: getEnvInt('ATK_MAX_OBJECT_COUNT', 1000),
        maxEstimatedEphemerisPoints: getEnvInt('ATK_MAX_ESTIMATED_EPHEMERIS_POINTS', 2_000_000),
      },
    },
    debug: getEnv('DEBUG', '', 'false').toLowerCase() === 'true',
  };
}

function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key] || fileEnv[key];
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}
