#!/usr/bin/env node
/**
 * atk-agent — 全局 CLI 入口
 * 用法: atk-agent chat / atk-agent run "..." / atk-agent connect
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, '..');

const distEntry = resolve(projectDir, 'dist/index.js');
const args = existsSync(distEntry)
  ? [distEntry, ...process.argv.slice(2)]
  : ['--import', 'tsx/esm', resolve(projectDir, 'src/index.ts'), ...process.argv.slice(2)];

// 发布包运行 dist；源码开发环境在尚未 build 时回退到 tsx。
const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  cwd: projectDir,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
