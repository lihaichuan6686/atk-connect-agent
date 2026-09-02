/**
 * ReAct Agent — 核心推理循环
 *
 * 借鉴 ai-agent-starter 的 Agent 类 + CCB 的 async generator 事件流模式。
 *
 * 循环流程：
 *   1. 用户消息入记忆
 *   2. 调用 LLM（流式），yield text 事件
 *   3. 若 LLM 返回 tool_calls → 执行工具 → yield tool_call/tool_result 事件
 *   4. 工具结果入记忆 → 回到步骤 2
 *   5. LLM 无 tool_calls → 任务完成，yield done 事件
 *   6. 最大步数限制（默认 15）
 */

import { AIClient } from '../provider/provider.js';
import { MemoryManager } from './memory.js';
import type {
  AgentEvent,
  AgentOptions,
  AIMessage,
  AITool,
  AIToolCall,
  ToolExecutionContext,
} from '../types.js';

export class Agent {
  private client: AIClient;
  private tools: Map<string, AITool>;
  private toolList: AITool[];
  private memory: MemoryManager;
  private options: Required<Omit<AgentOptions, 'tools'>>;

  constructor(client: AIClient, options: AgentOptions = {}) {
    this.client = client;
    this.tools = new Map();
    this.toolList = [];

    this.options = {
      systemPrompt: options.systemPrompt || 'You are a helpful AI assistant.',
      model: options.model || '',
      temperature: options.temperature ?? 0.1,
      maxTokens: options.maxTokens ?? 4096,
      maxMemoryTokens: options.maxMemoryTokens ?? 8000,
      maxSteps: options.maxSteps ?? 15,
    };

    this.memory = new MemoryManager({
      maxTokens: this.options.maxMemoryTokens,
    });
    this.memory.setSystemPrompt(this.options.systemPrompt);

    if (options.tools) {
      for (const tool of options.tools) {
        this.addTool(tool);
      }
    }
  }

  // ---- 工具管理 ----

  addTool(tool: AITool): this {
    this.tools.set(tool.name, tool);
    this.toolList.push(tool);
    return this;
  }

  removeTool(name: string): this {
    this.tools.delete(name);
    this.toolList = this.toolList.filter((t) => t.name !== name);
    return this;
  }

  getTools(): AITool[] {
    return [...this.toolList];
  }

  // ---- 对话 ----

  /**
   * 运行 Agent（流式，yield 事件供 UI 渲染）
   */
  async *run(
    userInput: string,
    runOptions: { signal?: AbortSignal; toolContext?: ToolExecutionContext } = {},
  ): AsyncGenerator<AgentEvent> {
    this.memory.add({ role: 'user', content: userInput });

    const maxSteps = this.options.maxSteps;

    for (let step = 1; step <= maxSteps; step++) {
      if (runOptions.signal?.aborted) {
        yield { type: 'cancelled', message: '任务已取消' };
        return;
      }
      yield { type: 'step', step, maxSteps };

      const providerOptions = {
        model: this.options.model || undefined,
        temperature: this.options.temperature,
        maxTokens: this.options.maxTokens,
        tools: this.toolList.length > 0 ? this.toolList : undefined,
        signal: runOptions.signal,
      };

      // 调用 LLM（流式）
      let fullContent = '';
      let toolCalls: AIToolCall[] | undefined;

      try {
        for await (const chunk of this.client.stream(
          this.memory.getAll(),
          providerOptions,
        )) {
          if (chunk.content) {
            fullContent += chunk.content;
            yield { type: 'text', content: chunk.content };
          }
          if (chunk.toolCalls) {
            toolCalls = chunk.toolCalls;
          }
        }
      } catch (err) {
        if (runOptions.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          yield { type: 'cancelled', message: '任务已取消' };
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: `LLM 调用失败: ${message}` };
        return;
      }

      // 处理工具调用
      if (toolCalls && toolCalls.length > 0) {
        // 将 assistant 消息（含 tool_calls）入记忆
        this.memory.add({
          role: 'assistant',
          content: fullContent,
          tool_calls: toolCalls,
        });

        // 执行每个工具调用
        for (const tc of toolCalls) {
          yield { type: 'tool_call', toolName: tc.name, args: tc.arguments };

          const result = await this.executeTool(tc, runOptions.toolContext);
          const success = !result.startsWith('Error:');

          yield {
            type: 'tool_result',
            toolName: tc.name,
            result,
            success,
          };

          // 工具结果入记忆
          this.memory.add({
            role: 'tool',
            content: result,
            name: tc.name,
            tool_call_id: tc.id,
          });
        }

        // 工具执行完毕，继续循环让 LLM 处理结果
        continue;
      }

      // 没有工具调用 → 任务完成
      this.memory.add({
        role: 'assistant',
        content: fullContent,
      });

      yield { type: 'done', content: fullContent };
      return;
    }

    // 超过最大步数
    yield {
      type: 'error',
      message: `任务执行超过最大步数(${maxSteps})，可能未完成。`,
    };
  }

  /**
   * 执行单个工具调用
   */
  private async executeTool(tc: AIToolCall, context?: ToolExecutionContext): Promise<string> {
    const tool = this.tools.get(tc.name);
    if (!tool) {
      return `Error: 未知工具 "${tc.name}"`;
    }

    try {
      const result = await tool.execute(tc.arguments, context);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: 执行工具 ${tc.name} 失败: ${message}`;
    }
  }

  // ---- 记忆管理 ----

  getMemory(): AIMessage[] {
    return this.memory.getAll();
  }

  clearMemory(): void {
    this.memory.clear(true);
  }

  tokenCount(): number {
    return this.memory.tokenCount();
  }

  setSystemPrompt(prompt: string): void {
    this.options.systemPrompt = prompt;
    this.memory.setSystemPrompt(prompt);
  }
}
