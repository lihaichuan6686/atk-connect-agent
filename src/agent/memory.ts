/**
 * 对话记忆管理
 *
 * 借鉴 ai-agent-starter 的 MemoryManager，增加 CJK token 估算优化。
 * 当对话历史接近 token 上限时，自动裁剪最旧的消息（保留 system prompt）。
 */

import type { AIMessage } from '../types.js';

export interface MemoryOptions {
  /** 最大 token 数（默认 8000） */
  maxTokens?: number;
}

export class MemoryManager {
  private messages: AIMessage[] = [];
  private maxTokens: number;

  constructor(options: MemoryOptions = {}) {
    this.maxTokens = options.maxTokens || 8000;
  }

  add(message: AIMessage): void {
    this.messages.push(message);
    this.prune();
  }

  addMany(messages: AIMessage[]): void {
    for (const m of messages) {
      this.messages.push(m);
    }
    this.prune();
  }

  getAll(): AIMessage[] {
    return [...this.messages];
  }

  setSystemPrompt(prompt: string): void {
    this.messages = this.messages.filter((m) => m.role !== 'system');
    this.messages.unshift({ role: 'system', content: prompt });
  }

  clear(keepSystem = true): void {
    if (keepSystem) {
      this.messages = this.messages.filter((m) => m.role === 'system');
    } else {
      this.messages = [];
    }
  }

  tokenCount(): number {
    return estimateTokens(this.messages);
  }

  /** 获取最近 N 条消息 */
  recent(maxMessages: number): AIMessage[] {
    return this.messages.slice(-maxMessages);
  }

  // ---- 内部 ----

  private prune(): void {
    while (this.tokenCount() > this.maxTokens && this.messages.length > 2) {
      // 保留 index 0 的 system prompt
      const startIdx = this.messages[0]?.role === 'system' ? 1 : 0;
      const laterUserIndex = this.messages.findIndex(
        (message, index) => index > startIdx && message.role === 'user',
      );
      // 以完整 turn 为单位裁剪，避免拆散 assistant.tool_calls 与对应 tool_result。
      // 只剩最后一个 turn 时宁可暂时超预算，也不制造非法消息序列。
      if (laterUserIndex < 0) break;
      this.messages.splice(startIdx, laterUserIndex - startIdx);
    }
  }
}

// ============================================================
// Token 估算
// ============================================================

/**
 * 估算消息列表的 token 数。
 * 区分 CJK 和 ASCII：CJK 约 0.7 token/字符，ASCII 约 0.25 token/字符。
 */
export function estimateTokens(messages: AIMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += countTokens(msg.content);
    total += 1; // role 开销
    if (msg.name) total += countTokens(msg.name);
    if (msg.tool_call_id) total += 2;
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += countTokens(tc.name);
        total += countTokens(JSON.stringify(tc.arguments));
        total += 2;
      }
    }
  }
  return total;
}

function countTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // CJK 范围（简体中文、日文、韩文）
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      tokens += 0.7;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}
