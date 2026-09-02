/**
 * LLM Provider 抽象层 + 统一客户端
 *
 * 借鉴 ai-agent-starter 的 Provider 架构。
 * DeepSeek / 通义千问 / OpenAI 均走 OpenAI 兼容接口，共用 OpenAICompatibleProvider。
 * Ollama 走自有 /api/chat 接口。
 */

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AITool,
  AIToolCall,
  ProviderChatOptions,
  StreamChunk,
  AIUsage,
} from '../types.js';

// ============================================================
// OpenAI 兼容 Provider（DeepSeek / 通义千问 / OpenAI / vLLM）
// ============================================================

export class OpenAICompatibleProvider implements AIProvider {
  name: string;
  private apiKey: string;
  private baseURL: string;

  constructor(name: string, config: { apiKey: string; baseURL: string }) {
    this.name = name;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL.replace(/\/+$/, '');
  }

  async chat(
    messages: AIMessage[],
    options: ProviderChatOptions = {},
  ): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: options.model || '',
      messages: toOpenAIMessages(messages),
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toolToOpenAI);
      body.tool_choice = options.toolChoice || 'auto';
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`[${this.name}] API 错误 ${response.status}: ${err}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices[0];
    const msg = choice.message;

    const toolCalls: AIToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
    }));

    return {
      content: msg.content || '',
      usage: toUsage(data.usage),
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async *stream(
    messages: AIMessage[],
    options: ProviderChatOptions = {},
  ): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: options.model || '',
      messages: toOpenAIMessages(messages),
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toolToOpenAI);
      body.tool_choice = options.toolChoice || 'auto';
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`[${this.name}] 流式请求错误 ${response.status}: ${err}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 累积流式 tool_calls（分片到达，需要拼接）
    const toolCallAccumulator: Map<number, { id: string; name: string; args: string }> = new Map();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const json = trimmed.slice(6);
        if (json === '[DONE]') {
          // 如果有累积的 tool_calls，在结束前 yield
          if (toolCallAccumulator.size > 0) {
            const toolCalls: AIToolCall[] = [];
            for (const [, tc] of toolCallAccumulator) {
              toolCalls.push({
                id: tc.id,
                name: tc.name,
                arguments: safeParseArgs(tc.args),
              });
            }
            yield { content: '', done: false, toolCalls };
          }
          yield { content: '', done: true };
          return;
        }
        try {
          const parsed = JSON.parse(json);
          const delta = parsed.choices?.[0]?.delta;
          const content = delta?.content || '';

          // 处理流式 tool_calls 分片
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, { id: tc.id || '', name: '', args: '' });
              }
              const acc = toolCallAccumulator.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }

          if (parsed.usage) {
            yield { content, done: false, usage: toUsage(parsed.usage) };
          } else if (content) {
            yield { content, done: false };
          }
        } catch {
          // 跳过无法解析的 chunk
        }
      }
    }
  }
}

// ============================================================
// Ollama Provider（本地模型）
// ============================================================

export class OllamaProvider implements AIProvider {
  name = 'ollama';
  private baseURL: string;

  constructor(config: { baseURL?: string }) {
    this.baseURL = config.baseURL || 'http://localhost:11434';
  }

  async chat(
    messages: AIMessage[],
    options: ProviderChatOptions = {},
  ): Promise<AIResponse> {
    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || 'qwen2.5',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          temperature: options.temperature ?? 0.1,
          num_predict: options.maxTokens ?? 4096,
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`[ollama] API 错误 ${response.status}: ${err}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    return {
      content: data.message?.content || '',
    };
  }

  async *stream(
    messages: AIMessage[],
    options: ProviderChatOptions = {},
  ): AsyncIterable<StreamChunk> {
    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || 'qwen2.5',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          temperature: options.temperature ?? 0.1,
          num_predict: options.maxTokens ?? 4096,
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`[ollama] 流式请求错误 ${response.status}: ${err}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.done) {
            yield { content: '', done: true };
            return;
          }
          yield {
            content: parsed.message?.content || '',
            done: false,
          };
        } catch {
          // 跳过
        }
      }
    }
  }
}

// ============================================================
// AIClient — 统一接口
// ============================================================

export class AIClient {
  private provider: AIProvider;

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  async ask(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: AIMessage[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const resp = await this.provider.chat(messages);
    return resp.content;
  }

  async chat(
    messages: AIMessage[],
    options?: ProviderChatOptions,
  ): Promise<AIResponse> {
    return this.provider.chat(messages, options);
  }

  stream(
    messages: AIMessage[],
    options?: ProviderChatOptions,
  ): AsyncIterable<StreamChunk> {
    if (!this.provider.stream) {
      throw new Error(`Provider ${this.provider.name} 不支持流式输出`);
    }
    return this.provider.stream(messages, options);
  }

  setProvider(provider: AIProvider): void {
    this.provider = provider;
  }

  getProviderName(): string {
    return this.provider.name;
  }
}

// ============================================================
// Provider 工厂
// ============================================================

import type { LLMConfig } from '../config.js';

export function createProvider(config: LLMConfig): AIProvider {
  switch (config.provider.toLowerCase()) {
    case 'ollama':
      return new OllamaProvider({ baseURL: config.ollamaBaseURL });

    case 'deepseek':
      return new OpenAICompatibleProvider('deepseek', {
        apiKey: config.apiKey,
        baseURL: config.baseURL || 'https://api.deepseek.com/v1',
      });

    case 'qwen':
      return new OpenAICompatibleProvider('qwen', {
        apiKey: config.apiKey,
        baseURL: config.baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      });

    case 'openai':
      return new OpenAICompatibleProvider('openai', {
        apiKey: config.apiKey,
        baseURL: config.baseURL || 'https://api.openai.com/v1',
      });

    default:
      throw new Error(
        `未知的 AI_PROVIDER: "${config.provider}"。支持: deepseek | qwen | openai | ollama`,
      );
  }
}

// ============================================================
// 辅助函数
// ============================================================

function toUsage(raw: OpenAIUsage | undefined): AIUsage | undefined {
  if (!raw) return undefined;
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
  };
}

function toOpenAIMessages(messages: AIMessage[]) {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) out.name = m.name;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
    }
    return out;
  });
}

function toolToOpenAI(tool: AITool) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function safeParseArgs(args: string): Record<string, unknown> {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

// ============================================================
// API 响应类型（OpenAI 兼容）
// ============================================================

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OllamaChatResponse {
  message?: { content: string };
  done: boolean;
}
