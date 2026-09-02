/**
 * 启动横幅
 */

import chalk from 'chalk';
import { theme } from './colors.js';

export function printBanner(version: string): void {
  const logo = [
    '',
    '    ___   _____ _____ _____   ',
    '   / _ \\ |  ___|_   _|_   _|  ',
    '  / /_\\ \\| |__   | |   | |    ',
    '  |  _  ||  __|  | |   | |    ',
    '  | | | || |___ _| |_ _| |_   ',
    '  \\_| |_/\\____/ \\___/ \\___/   ',
    '                               ',
  ];

  for (const line of logo) {
    console.log(theme.brand(line));
  }

  console.log(`  ${theme.dim('AI Agent for ATK (Aerospace Tool Kit)')}`);
  console.log(`  ${theme.dim(`v${version}`)}`);
  console.log();
  console.log(`  ${theme.bullet} 输入自然语言描述你的需求，Agent 自动调用 ATK 工具`);
  console.log(`  ${theme.bullet} 输入 ${chalk.cyan('/help')} 查看帮助，${chalk.cyan('/quit')} 退出`);
  console.log();
}
