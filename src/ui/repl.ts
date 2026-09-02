/**
 * 交互式 REPL 主循环
 */

import * as readline from 'node:readline';
import { Agent } from '../agent/agent.js';
import type { AITool } from '../types.js';
import { printBanner } from './banner.js';
import { Spinner } from './spinner.js';
import { consumeAgentEvents, renderUserMessage, renderInfo, renderError, renderSeparator } from './render.js';
import { theme } from './colors.js';

export interface REPOptions {
  agent: Agent;
  version: string;
  /** 可用工具列表（用于 /help 显示） */
  toolNames?: string[];
  /** 连接状态查询函数 */
  getStatus?: () => string;
}

export async function startREPL(options: REPOptions): Promise<void> {
  const { agent, version } = options;

  printBanner(version);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${theme.user('你')} ${theme.dim('›')} `,
  });

  console.log(`${theme.info('●')} ATK Agent 已就绪\n`);
  rl.prompt();

  return new Promise<void>((resolve) => {
  rl.on('line', async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // 斜杠命令
    if (trimmed.startsWith('/')) {
      const handled = handleSlashCommand(trimmed, agent, options);
      if (handled === 'quit') {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    // 自然语言对话
    renderUserMessage(trimmed);

    const spinner = new Spinner('思考中...');
    spinner.start();

    try {
      const events = agent.run(trimmed);
      await consumeAgentEvents(events, spinner);
    } catch (err) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      renderError(message);
    }

    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${theme.dim('再见！')}`);
    resolve();
  });

  // Ctrl+C 处理
  rl.on('SIGINT', () => {
    console.log(`\n${theme.dim('（输入 /quit 退出）')}`);
    rl.prompt();
  });
  });
}

// ============================================================
// 斜杠命令
// ============================================================

type SlashResult = 'continue' | 'quit';

function handleSlashCommand(input: string, agent: Agent, options: REPOptions): SlashResult {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'quit':
    case 'exit':
    case 'q':
      return 'quit';

    case 'clear':
      agent.clearMemory();
      renderInfo('对话历史已清空');
      break;

    case 'help':
    case 'h':
      printHelp(options.toolNames);
      break;

    case 'status':
      if (options.getStatus) {
        console.log(options.getStatus());
      } else {
        renderInfo('状态不可用');
      }
      break;

    case 'tools':
      printTools(agent.getTools().map((t: AITool) => t.name));
      break;

    case 'memory':
      const tokens = agent.tokenCount();
      const msgCount = agent.getMemory().length;
      renderInfo(`记忆: ${msgCount} 条消息, ~${tokens} tokens`);
      break;

    default:
      renderError(`未知命令: /${cmd}。输入 /help 查看可用命令。`);
  }

  return 'continue';
}

function printHelp(toolNames?: string[]): void {
  console.log();
  renderSeparator();
  console.log(`  ${theme.bold('可用命令')}`);
  renderSeparator();
  console.log(`  ${theme.cyan('/help')}     显示此帮助`);
  console.log(`  ${theme.cyan('/clear')}    清空对话历史`);
  console.log(`  ${theme.cyan('/tools')}    列出可用 ATK 工具`);
  console.log(`  ${theme.cyan('/status')}   显示 ATK 连接状态`);
  console.log(`  ${theme.cyan('/memory')}   显示对话记忆使用情况`);
  console.log(`  ${theme.cyan('/quit')}     退出`);
  renderSeparator();
  console.log();
  console.log(`  ${theme.bold('使用示例')}`);
  renderSeparator();
  console.log(`  ${theme.dim('•')} 创建一个名为 MyScenario 的场景，时间从 2022年11月5日 到 2022年11月8日`);
  console.log(`  ${theme.dim('•')} 创建一颗名为 Sat1 的卫星，半长轴 7128.1km，倾角 98.4度`);
  console.log(`  ${theme.dim('•')} 创建一个地面站，位于北京 (39.9, 116.4)`);
  console.log(`  ${theme.dim('•')} 运行仿真`);
  console.log(`  ${theme.dim('•')} 保存场景`);
  renderSeparator();
  console.log();
}

function printTools(names: string[]): void {
  console.log();
  renderSeparator();
  console.log(`  ${theme.bold('可用 ATK 工具')} (${names.length} 个)`);
  renderSeparator();
  for (const name of names) {
    console.log(`  ${theme.gear} ${theme.toolName(name)}`);
  }
  renderSeparator();
  console.log();
}
