/**
 * 终端渲染器 — 将 Agent 事件渲染为终端输出
 */

import chalk from 'chalk';
import type { AgentEvent } from '../types.js';
import { theme, formatArgs, truncate } from './colors.js';

/** 渲染用户消息 */
export function renderUserMessage(text: string): void {
  console.log(`\n${theme.user('你')} ${theme.dim('›')} ${text}`);
}

/** 渲染 AI 消息前缀 */
export function renderAssistantPrefix(): void {
  process.stdout.write(`\n${theme.assistant('ATK Agent')} ${theme.dim('›')} `);
}

/** 渲染流式文本 chunk */
export function renderTextChunk(content: string): void {
  process.stdout.write(content);
}

/** 渲染 AI 消息结束 */
export function renderAssistantEnd(): void {
  process.stdout.write('\n');
}

/** 渲染工具调用开始 */
export function renderToolCall(toolName: string, args: Record<string, unknown>): void {
  console.log(
    `  ${theme.gear} ${theme.toolName(toolName)}${theme.toolArgs(`(${formatArgs(args)})`)}`,
  );
}

/** 渲染工具调用结果 */
export function renderToolResult(toolName: string, result: string, success: boolean): void {
  const icon = success ? theme.checkmark : theme.crossmark;
  const status = success ? theme.success('成功') : theme.fail('失败');
  const preview = truncate(result.replace(/\n/g, ' '), 100);
  console.log(`    ${icon} ${status} ${theme.dim(preview)}`);
}

/** 渲染步骤指示 */
export function renderStep(step: number, maxSteps: number): void {
  if (step > 1) {
    console.log(theme.dim(`\n  ── 步骤 ${step}/${maxSteps} ──`));
  }
}

/** 渲染错误 */
export function renderError(message: string): void {
  console.error(`\n  ${theme.crossmark} ${theme.error(message)}`);
}

/** 渲染信息 */
export function renderInfo(message: string): void {
  console.log(`  ${theme.bullet} ${theme.dim(message)}`);
}

/** 渲染分隔线 */
export function renderSeparator(): void {
  console.log(theme.dim('  ' + '─'.repeat(50)));
}

/**
 * 消费 Agent 事件流并渲染到终端
 */
export async function consumeAgentEvents(
  events: AsyncGenerator<AgentEvent>,
  spinner: { start: (msg: string) => void; stop: (msg?: string) => void; setMessage: (msg: string) => void } | null,
): Promise<string> {
  let finalContent = '';
  let hasText = false;
  let currentTool = '';

  for await (const event of events) {
    switch (event.type) {
      case 'step':
        renderStep(event.step, event.maxSteps);
        if (spinner && event.step > 0) {
          spinner.setMessage('思考中...');
        }
        break;

      case 'text':
        if (spinner && !hasText) {
          spinner.stop();
          renderAssistantPrefix();
          hasText = true;
        }
        renderTextChunk(event.content);
        finalContent += event.content;
        break;

      case 'tool_call':
        if (spinner) {
          spinner.stop();
        }
        if (hasText) {
          renderAssistantEnd();
          hasText = false;
        }
        currentTool = event.toolName;
        renderToolCall(event.toolName, event.args);
        if (spinner) {
          spinner.start(`执行 ${event.toolName}...`);
        }
        break;

      case 'tool_result':
        if (spinner) {
          spinner.stop();
        }
        renderToolResult(event.toolName, event.result, event.success);
        if (spinner) {
          spinner.start('思考中...');
        }
        break;

      case 'done':
        if (hasText) {
          renderAssistantEnd();
        }
        finalContent = event.content;
        break;

      case 'error':
        if (spinner) {
          spinner.stop();
        }
        if (hasText) {
          renderAssistantEnd();
        }
        renderError(event.message);
        break;
    }
  }

  return finalContent;
}
