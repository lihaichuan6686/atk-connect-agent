import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Brand } from '../src/tui/brand.js';
import { SetupWizard } from '../src/tui/SetupWizard.js';
import type { AppConfig } from '../src/config.js';
import { ChatApp } from '../src/tui/ChatApp.js';
import type { Agent } from '../src/agent/agent.js';

const config: AppConfig = {
  llm: {
    provider: 'deepseek',
    apiKey: '',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    ollamaBaseURL: 'http://localhost:11434',
    ollamaModel: 'qwen2.5',
  },
  atk: {
    exePath: 'D:\\ATK\\ATK.exe',
    host: '127.0.0.1',
    port: 6655,
    startupWait: 8,
    pythonModulePath: 'D:\\ATK\\Python',
    pythonExe: 'python.exe',
  },
  debug: false,
};

describe('TUI', () => {
  it('renders the original Orbitling identity', () => {
    const view = render(<Brand />);
    expect(view.lastFrame()).toContain('ATK ORBITLING · 小轨');
    expect(view.lastFrame()).toContain('航天任务设计搭档');
    view.unmount();
  });

  it('starts onboarding with a provider selector', () => {
    const view = render(<SetupWizard initial={config} onComplete={() => undefined} />);
    expect(view.lastFrame()).toContain('首次启动配置');
    expect(view.lastFrame()).toContain('DeepSeek');
    expect(view.lastFrame()).toContain('Ollama 本地模型');
    view.unmount();
  });

  it('accepts slash commands without invoking the model', async () => {
    const agent = {
      clearMemory: () => undefined,
      tokenCount: () => 0,
      async *run() { return; },
    } as unknown as Agent;
    const view = render(
      <ChatApp
        agent={agent}
        getATKState={async () => 'disconnected'}
        sessionId="test-session"
        config={config}
        onExit={() => undefined}
      />,
    );

    view.stdin.write('/help');
    await nextTurn();
    view.stdin.write('\r');
    await nextTurn();

    expect(view.lastFrame()).toContain('/status 状态');
    expect(view.lastFrame()).toContain('/config 重新配置模型');
    view.unmount();
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
