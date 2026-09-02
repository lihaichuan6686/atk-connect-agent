import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Agent } from '../agent/agent.js';
import type { AppConfig } from '../config.js';
import type { ATKConnectionState } from '../types.js';
import { Brand } from './brand.js';
import { LineInput } from './LineInput.js';
import { tuiTheme } from './theme.js';
import { atkCatalogStats } from '../atk/catalog/catalog.js';

interface DisplayMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'error';
  text: string;
}

interface ToolActivity {
  id: number;
  name: string;
  detail: string;
  status: 'running' | 'success' | 'error';
}

export type ChatExitReason = 'quit' | 'configure';

interface ChatAppProps {
  agent: Agent;
  getATKState: () => Promise<ATKConnectionState>;
  sessionId: string;
  config: AppConfig;
  onExit: (reason: ChatExitReason) => void;
}

export function ChatApp({ agent, getATKState, sessionId, config, onExit }: ChatAppProps): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [atkState, setAtkState] = useState<ATKConnectionState>('disconnected');
  const messageId = useRef(0);
  const activityId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void getATKState().then((state) => { if (mounted.current) setAtkState(state); }); };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [getATKState]);

  useInput((inputCharacter, key) => {
    if (key.ctrl && inputCharacter === 'c') {
      onExit('quit');
      exit();
    }
  });

  const addMessage = (role: DisplayMessage['role'], text: string): number => {
    const id = ++messageId.current;
    setMessages((current) => [...current, { id, role, text }]);
    return id;
  };

  const updateMessage = (id: number, update: (text: string) => string): void => {
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, text: update(message.text) } : message
    )));
  };

  const handleSlashCommand = (value: string): boolean => {
    const command = value.trim().toLowerCase();
    if (command === '/quit' || command === '/exit') {
      onExit('quit');
      exit();
      return true;
    }
    if (command === '/config') {
      onExit('configure');
      exit();
      return true;
    }
    if (command === '/clear') {
      agent.clearMemory();
      setMessages([]);
      setActivities([]);
      return true;
    }
    if (command === '/status') {
      addMessage(
        'system',
        `Session: ${sessionId} · Provider: ${config.llm.provider} · Model: ${activeModel(config)} · ATK: ${atkState} · Memory: ~${agent.tokenCount()} tokens`,
      );
      return true;
    }
    if (command === '/tools') {
      addMessage(
        'system',
        `官方 CONNECT：${atkCatalogStats.commandEntries} 个用法 · ${atkCatalogStats.uniqueCommands} 个命令首词 · ${atkCatalogStats.categories.length} 个分类。可直接问我“查询 SetState 官方用法”或“用覆盖定义命令创建网格”。`,
      );
      return true;
    }
    if (command === '/help') {
      addMessage(
        'system',
        '/help 帮助 · /tools 官方工具覆盖 · /status 状态 · /clear 清空会话 · /config 重新配置模型 · /quit 退出',
      );
      return true;
    }
    if (command.startsWith('/')) {
      addMessage('error', `未知命令：${value.trim()}。输入 /help 查看可用命令。`);
      return true;
    }
    return false;
  };

  const submit = async (raw: string): Promise<void> => {
    const value = raw.trim();
    if (!value || busy) return;
    setInput('');
    if (handleSlashCommand(value)) return;

    addMessage('user', value);
    const assistantId = addMessage('assistant', '');
    setBusy(true);

    try {
      const runId = `tui-${Date.now()}-${messageId.current}`;
      for await (const event of agent.run(value, { toolContext: { caller: 'tui', runId } })) {
        if (!mounted.current) break;
        if (event.type === 'text') {
          updateMessage(assistantId, (text) => text + event.content);
        } else if (event.type === 'tool_call') {
          const id = ++activityId.current;
          setActivities((current) => [...current, {
            id,
            name: event.toolName,
            detail: compact(JSON.stringify(event.args), 110),
            status: 'running',
          }]);
        } else if (event.type === 'tool_result') {
          setActivities((current) => {
            const index = findLastRunning(current, event.toolName);
            if (index < 0) return current;
            return current.map((activity, activityIndex) => activityIndex === index ? {
              ...activity,
              detail: compact(event.result.replace(/\s+/g, ' '), 110),
              status: event.success ? 'success' : 'error',
            } : activity);
          });
        } else if (event.type === 'done' && event.content) {
          updateMessage(assistantId, (text) => text || event.content);
        } else if (event.type === 'error') {
          updateMessage(assistantId, (text) => text || event.message);
        } else if (event.type === 'cancelled') {
          updateMessage(assistantId, (text) => text || event.message);
        }
      }
    } catch (cause) {
      updateMessage(assistantId, () => cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const terminalRows = stdout.rows || 30;
  const visibleMessageCount = Math.max(4, Math.min(10, terminalRows - 17));
  const visibleMessages = messages.slice(-visibleMessageCount);
  const visibleActivities = activities.slice(-3);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Brand compact />
        <Text color={tuiTheme.muted}>航天任务终端 · v1.4</Text>
      </Box>

      <Box borderStyle="round" borderColor={tuiTheme.border} paddingX={1} flexDirection="column" minHeight={8}>
        {messages.length === 0 ? (
          <Box flexDirection="column" alignItems="center" paddingY={1}>
            <Brand />
            <Text color={tuiTheme.muted}>描述任务，我会规划并调用 ATK 工具。</Text>
            <Text color={tuiTheme.muted}>试试：创建一个两小时的近地轨道场景</Text>
          </Box>
        ) : visibleMessages.map((message) => (
          <MessageLine key={message.id} message={message} />
        ))}
      </Box>

      {visibleActivities.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={tuiTheme.accent}>工具执行</Text>
          {visibleActivities.map((activity) => <ActivityLine key={activity.id} activity={activity} />)}
        </Box>
      ) : null}

      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={busy ? tuiTheme.warning : tuiTheme.brand}
        paddingX={1}
      >
        <Text color={tuiTheme.brand}>❯ </Text>
        {busy ? (
          <Text color={tuiTheme.warning}>小轨正在规划任务…</Text>
        ) : (
          <LineInput
            value={input}
            onChange={(value) => setInput(value.replace(/[\r\n]/g, ''))}
            onSubmit={(value) => { void submit(value); }}
            placeholder="输入航天任务或 /help"
          />
        )}
      </Box>

      <Box justifyContent="space-between">
        <Text color={tuiTheme.muted}>{config.llm.provider} · {activeModel(config)}</Text>
        <Text color={stateColor(atkState)}>ATK {atkState}</Text>
        <Text color={tuiTheme.muted}>Ctrl+C 退出</Text>
      </Box>
    </Box>
  );
}

function MessageLine({ message }: { message: DisplayMessage }): React.ReactNode {
  const label = message.role === 'user' ? '你' : message.role === 'assistant' ? '小轨' : '系统';
  const color = message.role === 'user'
    ? tuiTheme.success
    : message.role === 'error'
      ? tuiTheme.error
      : message.role === 'system'
        ? tuiTheme.warning
        : tuiTheme.brand;
  return (
    <Box marginBottom={1}>
      <Text bold color={color}>{label} › </Text>
      <Text wrap="wrap">{message.text || '…'}</Text>
    </Box>
  );
}

function ActivityLine({ activity }: { activity: ToolActivity }): React.ReactNode {
  const icon = activity.status === 'running' ? '◌' : activity.status === 'success' ? '✓' : '✗';
  const color = activity.status === 'running'
    ? tuiTheme.warning
    : activity.status === 'success'
      ? tuiTheme.success
      : tuiTheme.error;
  return (
    <Text color={color}>
      {icon} {activity.name} <Text color={tuiTheme.muted}>{activity.detail}</Text>
    </Text>
  );
}

function findLastRunning(activities: ToolActivity[], name: string): number {
  for (let index = activities.length - 1; index >= 0; index--) {
    if (activities[index].name === name && activities[index].status === 'running') return index;
  }
  return -1;
}

function activeModel(config: AppConfig): string {
  return config.llm.provider === 'ollama' ? config.llm.ollamaModel : config.llm.model;
}

function stateColor(state: string): string {
  if (state === 'connected') return tuiTheme.success;
  if (state === 'error') return tuiTheme.error;
  if (state === 'connecting') return tuiTheme.warning;
  return tuiTheme.muted;
}

function compact(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
