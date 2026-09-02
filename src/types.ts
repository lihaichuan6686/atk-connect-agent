/**
 * ATK Agent CLI — 核心类型定义
 *
 * 借鉴 ai-agent-starter 的类型架构，适配 ATK 场景。
 */

// ============================================================
// 消息类型
// ============================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIMessage {
  role: MessageRole;
  content: string;
  /** 工具调用时关联的函数名（role='tool' 时使用） */
  name?: string;
  /** 工具调用 ID（role='tool' 时关联 assistant 的 tool_call） */
  tool_call_id?: string;
  /** assistant 消息携带的工具调用列表 */
  tool_calls?: AIToolCall[];
}

export interface AIResponse {
  content: string;
  usage?: AIUsage;
  toolCalls?: AIToolCall[];
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ============================================================
// 工具类型
// ============================================================

export interface AITool {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  metadata?: ToolMetadata;
  execute(
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> | string;
}

export interface ToolMetadata {
  readOnly?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  concurrencySafe?: boolean;
  defaultTimeoutMs?: number;
  category?: string;
}

export interface ToolExecutionContext {
  sessionId?: string;
  runId?: string;
  caller?: 'agent' | 'cli' | 'mcp' | 'tui' | 'test';
  signal?: AbortSignal;
  dryRun?: boolean;
  allowDestructive?: boolean;
  recordToolEvent?: boolean;
  /** End-to-end budget propagated to long-running ATK CONNECT calls. */
  timeoutMs?: number;
}

export interface ToolParameterSchema {
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ============================================================
// Provider 类型
// ============================================================

export interface AIProvider {
  /** Provider 名称（deepseek/qwen/openai/ollama） */
  name: string;
  /** 非流式对话 */
  chat(messages: AIMessage[], options?: ProviderChatOptions): Promise<AIResponse>;
  /** 流式对话 */
  stream?(messages: AIMessage[], options?: ProviderChatOptions): AsyncIterable<StreamChunk>;
}

export interface ProviderChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AITool[];
  toolChoice?: 'auto' | 'none' | { name: string };
  signal?: AbortSignal;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  usage?: AIUsage;
  toolCalls?: AIToolCall[];
}

// ============================================================
// Agent 事件类型（供 UI 层渲染）
// ============================================================

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; result: string; success: boolean }
  | { type: 'step'; step: number; maxSteps: number }
  | { type: 'done'; content: string }
  | { type: 'cancelled'; message: string }
  | { type: 'error'; message: string };

export interface AgentOptions {
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxMemoryTokens?: number;
  maxSteps?: number;
  tools?: AITool[];
}

// ============================================================
// ATK 连接类型
// ============================================================

export interface ATKConnectionOptions {
  host: string;
  port: number;
  /** ATK.exe 完整路径 */
  exePath: string;
  /** ATK 启动等待时间（秒） */
  startupWait: number;
}

export interface ATKCommandResult {
  success: boolean;
  response: string;
  /** 原始命令（调试用） */
  command?: string;
  param?: string;
}

export type ATKConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
