/**
 * ATK Agent CLI — 入口
 *
 * 用法:
 *   atk-agent              交互式对话模式（默认）
 *   atk-agent chat         交互式对话模式
 *   atk-agent run "..."    单次执行模式
 *   atk-agent connect      测试 ATK 连接
 *   atk-agent --version    显示版本
 */

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { createProvider, AIClient } from './provider/provider.js';
import { Agent } from './agent/agent.js';
import { startREPL } from './ui/repl.js';
import { consumeAgentEvents, renderUserMessage, renderError, renderInfo } from './ui/render.js';
import { Spinner } from './ui/spinner.js';
import { buildSystemPrompt } from './system/prompt.js';
import { utilityTools, createATKTools } from './atk/tools/index.js';
import { ATKManager } from './atk/manager.js';
import { theme } from './ui/colors.js';
import { hasUserSettings } from './settings/user-settings.js';
import { runSetupWizard } from './tui/setup.js';
import { launchTUI } from './tui/launch.js';
import { atkCatalogStats, searchATKDocumentation } from './atk/catalog/catalog.js';
import { VERSION } from './version.js';
import { registerProductCommands } from './cli/product-commands.js';
import { runJsonMode, type JsonRunOptions } from './cli/run-json.js';
import { ProductRuntime } from './core/app-runtime.js';
import { registerDaemonCommands } from './cli/daemon-commands.js';
import { createDaemonToolClient } from './daemon/tools.js';


const program = new Command();

program
  .name('atk-agent')
  .description('AI Agent CLI for ATK (Aerospace Tool Kit) — 自然语言控制航天任务仿真')
  .version(VERSION);

registerProductCommands(program);
registerDaemonCommands(program);

// 默认：交互式对话模式
program
  .command('chat', { isDefault: true })
  .description('交互式 TUI 对话模式')
  .option('--classic', '使用旧版行式终端界面')
  .option('--allow-new-atk', 'Session 未绑定且没有实例时，明确允许启动新 ATK')
  .action(async (options: { classic?: boolean; allowNewAtk?: boolean }) => {
    if (options.classic) await chatMode();
    else await tuiMode(options.allowNewAtk === true);
  });

program
  .command('configure')
  .alias('config')
  .description('重新配置 Provider、API URL、API Key 和模型')
  .action(async () => {
    await configureMode();
  });

// 单次执行模式
program
  .command('run <prompt>')
  .description('单次执行模式')
  .option('--json', '以 JSONL 事件输出，stdout 不包含普通日志')
  .option('--no-color', '关闭颜色输出')
  .option('--session <id>', '持久会话 ID')
  .option('--timeout <ms>', '任务总超时（毫秒）', '600000')
  .option('--keep-atk-alive', '任务结束后保留由本次启动的 ATK')
  .option('--allow-new-atk', 'Session 未绑定且没有实例时，明确允许启动新 ATK')
  .action(async (prompt: string, options: JsonRunOptions & { json?: boolean }) => {
    if (options.json) await runJsonMode(prompt, options);
    else await runMode(prompt, options);
  });

// 连接测试
program
  .command('connect')
  .description('测试 LLM 和 ATK 连接')
  .action(async () => {
    await connectMode();
  });

program
  .command('commands [query]')
  .description('查看或检索内置离线官方 CONNECT 命令目录')
  .option('-c, --category <category>', '按分类过滤')
  .action((query: string | undefined, options: { category?: string }) => {
    if (!query) {
      console.log(`官方离线 CONNECT 目录：${atkCatalogStats.files} 个文档页，${atkCatalogStats.commandEntries} 个用法，${atkCatalogStats.uniqueCommands} 个命令首词。`);
      console.log(`分类：${atkCatalogStats.categories.join('、')}`);
      console.log(`命令：${atkCatalogStats.commands.join('、')}`);
      return;
    }
    const results = searchATKDocumentation(query, { category: options.category, limit: 20 });
    if (results.length === 0) {
      console.log(`没有找到“${query}”对应的离线官方条目。`);
      return;
    }
    for (const entry of results) {
      console.log(`\n[${entry.category}] ${entry.title}${entry.command ? ` · ${entry.command}` : ' · 参考资料'}`);
      if (entry.summary) console.log(entry.summary);
      if (entry.usage) console.log(`用法：${entry.usage}`);
      console.log(`来源：${entry.source}`);
    }
  });

// ============================================================
// 模式实现
// ============================================================

async function tuiMode(allowNewATK = false): Promise<void> {
  let forceConfigure = !hasUserSettings();
  while (true) {
    if (forceConfigure) {
      if (!process.stdin.isTTY) {
        throw new Error('首次配置需要交互式终端；也可以先设置 AI_PROVIDER、AI_API_KEY、AI_BASE_URL 和 AI_MODEL');
      }
      const settings = await runSetupWizard(loadConfig());
      if (!settings) return;
      forceConfigure = false;
    }

    const config = loadConfig();
    if (config.llm.provider !== 'ollama' && !config.llm.apiKey) {
      forceConfigure = true;
      continue;
    }

    const reason = await launchTUI(config, { allowNewATK });
    if (reason !== 'configure') return;
    forceConfigure = true;
  }
}

async function configureMode(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('配置向导需要交互式终端');
  }
  await runSetupWizard(loadConfig());
}

async function createAgent(): Promise<{
  agent: Agent;
  manager: ATKManager;
  tools: ReturnType<typeof createATKTools>;
  runtime: ProductRuntime;
}> {
  const config = loadConfig();

  // 验证 LLM 配置
  if (config.llm.provider !== 'ollama' && !config.llm.apiKey) {
    console.error(theme.error(`✗ 未配置 AI_API_KEY。请在 .env 文件中设置，或设置 AI_PROVIDER=ollama 使用本地模型。`));
    console.error(theme.dim('  参考 .env.example 配置文件。'));
    process.exit(1);
  }

  const provider = createProvider(config.llm);
  const client = new AIClient(provider);
  const runtime = new ProductRuntime({ config });
  await runtime.initialize();
  const manager = runtime.manager;
  const tools = runtime.agentTools({ caller: 'agent', sessionId: runtime.session.sessionId });

  const agent = new Agent(client, {
    systemPrompt: buildSystemPrompt(),
    model: config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model,
    temperature: 0.1,
    maxTokens: 4096,
    maxSteps: 15,
    tools,
  });

  return { agent, manager, tools, runtime };
}

async function chatMode(): Promise<void> {
  const config = loadConfig();
  const { agent, manager, tools, runtime } = await createAgent();

  try {
    await startREPL({
      agent,
      version: VERSION,
      toolNames: tools.map((t) => t.name),
      getStatus: () => {
        const atkState = manager.getState();
        const formatState = atkState === 'connected' ? theme.success(atkState) : theme.dim(atkState);
        const lines = [
          theme.bold('\n  状态:'),
          `  ${theme.bullet} LLM Provider: ${theme.cyan(config.llm.provider)}`,
          `  ${theme.bullet} Model: ${theme.cyan(config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model)}`,
          `  ${theme.bullet} ATK: ${formatState}`,
          `  ${theme.bullet} Memory: ${agent.tokenCount()} tokens`,
        ];
        return lines.join('\n');
      },
    });
  } finally {
    await runtime.dispose();
  }
}

async function runMode(prompt: string, options: JsonRunOptions): Promise<void> {
  const config = loadConfig();
  if (config.llm.provider !== 'ollama' && !config.llm.apiKey) throw new Error('未配置 AI_API_KEY');
  const sessionId = options.session ?? `run-${Date.now()}`;
  const controller = new AbortController();
  const timeoutMs = Number(options.timeout ?? 600_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout 必须是正整数毫秒数');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const daemon = await createDaemonToolClient(config, sessionId, {
    allowNewATK: options.allowNewAtk === true,
    context: { caller: 'agent', sessionId, signal: controller.signal },
  });
  const provider = createProvider(config.llm);
  const agent = new Agent(new AIClient(provider), {
    systemPrompt: buildSystemPrompt(),
    model: config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model,
    temperature: 0.1,
    maxTokens: 4096,
    maxSteps: 15,
    tools: daemon.tools,
  });

  renderUserMessage(prompt);

  const spinner = new Spinner('思考中...');
  spinner.start();

  try {
    const events = agent.run(prompt, { signal: controller.signal });
    await consumeAgentEvents(events, spinner);
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    renderError(message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }

  console.log();
}

async function connectMode(): Promise<void> {
  const config = loadConfig();
  console.log(theme.bold('\n  连接测试\n'));

  // 测试 LLM
  console.log(`  ${theme.gear} 测试 LLM 连接 (${config.llm.provider})...`);

  if (config.llm.provider !== 'ollama' && !config.llm.apiKey) {
    renderError('AI_API_KEY 未配置');
  } else {
    try {
      const provider = createProvider(config.llm);
      const client = new AIClient(provider);
      const model = config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model;
      const response = await client.chat(
        [
          { role: 'system', content: 'You are a test assistant. Reply concisely in Chinese.' },
          { role: 'user', content: '请回复 "LLM 连接正常"' },
        ],
        { model },
      );
      console.log(`  ${theme.checkmark} ${theme.success('LLM 连接成功')}`);
      renderInfo(`回复: ${response.content.slice(0, 100)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      renderError(`LLM 连接失败: ${message}`);
    }
  }

  // 测试 ATK（通过 Python sidecar）
  console.log(`\n  ${theme.gear} 测试 ATK 连接...`);

  if (!config.atk.pythonModulePath) {
    renderError('ATK_PYTHON_PATH 未配置（ATKConnectModule 所在目录）');
  } else {
    const manager = new ATKManager(config.atk);
    try {
      // 优先连接现有实例；必要时自动启动 ATK。
      await manager.ensureConnected();
      if (manager.isConnected()) {
        console.log(`  ${theme.checkmark} ${theme.success('ATK 连接成功')}`);
        renderInfo(`状态: ${manager.getState()}`);

        // 尝试发送测试命令
        const result = await manager.sendCommand('AllInstanceNames', '/');
        if (result.success) {
          console.log(`  ${theme.checkmark} ${theme.success('命令通信正常')}`);
          if (result.response) {
            renderInfo(`当前对象: ${result.response.slice(0, 100)}`);
          }
        }
      }
      await manager.dispose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      renderError(`ATK 连接失败: ${message}`);
      try {
        await manager.dispose();
      } catch {
        // 忽略
      }
    }
  }

  console.log();
}

// ============================================================
// 主入口
// ============================================================

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(theme.error(`\n致命错误: ${message}`));
  process.exit(1);
});
