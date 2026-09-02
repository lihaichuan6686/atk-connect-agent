/**
 * 终端彩色输出主题
 */

import chalk from 'chalk';

export const theme = {
  // 品牌
  brand: chalk.cyan.bold,
  brandDim: chalk.cyan,
  cyan: chalk.cyan,

  // 用户/AI
  user: chalk.green.bold,
  assistant: chalk.cyan,

  // 工具调用
  toolName: chalk.yellow.bold,
  toolArgs: chalk.gray,
  toolSuccess: chalk.green,
  toolFail: chalk.red,

  // 状态
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red.bold,
  info: chalk.blue,
  dim: chalk.gray,
  bold: chalk.bold,
  fail: chalk.red,

  // 特殊
  arrow: chalk.cyan('❯'),
  checkmark: chalk.green('✓'),
  crossmark: chalk.red('✗'),
  gear: chalk.yellow('⚙'),
  bullet: chalk.gray('•'),
};

/** 截断长字符串用于显示 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/** 格式化 JSON 用于紧凑显示 */
export function formatArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return truncate(json, 120);
}
