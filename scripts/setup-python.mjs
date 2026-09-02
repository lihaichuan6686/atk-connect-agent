import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const localPython = resolve('.venv', 'Scripts', 'python.exe');
if (!existsSync(localPython)) {
  const base = process.env.PYTHON_BASE_EXE || 'py';
  const args = base.toLowerCase().endsWith('py.exe') || base.toLowerCase() === 'py'
    ? ['-3.12', '-m', 'venv', '.venv'] : ['-m', 'venv', '.venv'];
  const created = spawnSync(base, args, { stdio: 'inherit' });
  if (created.status !== 0) {
    console.error('无法创建 .venv。请设置 PYTHON_BASE_EXE 为兼容的 CPython 3.12 路径后重试。');
    process.exit(created.status ?? 1);
  }
}

const env = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const modulePath = process.env.ATK_PYTHON_PATH || env.ATK_PYTHON_PATH;
const probe = modulePath
  ? `import sys; sys.path.insert(0, r'''${modulePath}'''); import ATKConnectModule; print('ATKConnectModule OK')`
  : `import sys; print(sys.version); print('提示：配置 ATK_PYTHON_PATH 后可验证 ATKConnectModule')`;
const checked = spawnSync(localPython, ['-c', probe], { stdio: 'inherit' });
if (checked.status !== 0) process.exit(checked.status ?? 1);
console.log(`Python sidecar 环境可用: ${localPython}`);

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
}
