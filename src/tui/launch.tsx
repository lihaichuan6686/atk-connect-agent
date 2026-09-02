import React from 'react';
import { render } from 'ink';
import type { AppConfig } from '../config.js';
import { createProvider, AIClient } from '../provider/provider.js';
import { Agent } from '../agent/agent.js';
import { buildSystemPrompt } from '../system/prompt.js';
import { ChatApp, type ChatExitReason } from './ChatApp.js';
import { createDaemonToolClient } from '../daemon/tools.js';

export async function launchTUI(config: AppConfig, options: { allowNewATK?: boolean } = {}): Promise<ChatExitReason> {
  const provider = createProvider(config.llm);
  const sessionId = process.env.ATK_AGENT_SESSION || 'tui-main';
  const client = await createDaemonToolClient(config, sessionId, {
    allowNewATK: options.allowNewATK === true || process.env.ATK_TUI_ALLOW_NEW_ATK === '1',
    context: { caller: 'tui', sessionId },
  });
  const agent = new Agent(new AIClient(provider), {
    systemPrompt: buildSystemPrompt(),
    model: config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model,
    temperature: 0.1,
    maxTokens: 4096,
    maxSteps: 15,
    tools: client.tools,
  });

  let reason: ChatExitReason = 'quit';
  try {
    const instance = render(
      <ChatApp
        agent={agent}
        getATKState={client.getATKState}
        sessionId={sessionId}
        config={config}
        onExit={(value) => { reason = value; }}
      />,
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
    return reason;
  } finally {
    // TUI 退出只 detach 客户端；daemon、sidecar 和 ATK 保持运行。
  }
}
