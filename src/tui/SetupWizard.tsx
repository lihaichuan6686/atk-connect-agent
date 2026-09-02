import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { AppConfig } from '../config.js';
import {
  saveUserSettings,
  type ProviderName,
  type UserSettings,
} from '../settings/user-settings.js';
import { Brand } from './brand.js';
import { LineInput } from './LineInput.js';
import { tuiTheme } from './theme.js';

const PROVIDERS: Array<{ value: ProviderName; label: string; hint: string }> = [
  { value: 'deepseek', label: 'DeepSeek', hint: 'OpenAI 兼容接口' },
  { value: 'qwen', label: '通义千问', hint: 'DashScope 兼容接口' },
  { value: 'openai', label: 'OpenAI / 兼容服务', hint: '也适用于 vLLM 等服务' },
  { value: 'ollama', label: 'Ollama 本地模型', hint: '无需 API Key' },
];

const DEFAULTS: Record<ProviderName, { url: string; models: string[] }> = {
  deepseek: { url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  openai: { url: 'https://api.openai.com/v1', models: ['gpt-4.1', 'gpt-4o'] },
  ollama: { url: 'http://localhost:11434', models: ['qwen2.5', 'llama3.2'] },
};

type Step = 'provider' | 'url' | 'key' | 'model' | 'custom-model' | 'confirm';

interface SetupWizardProps {
  initial: AppConfig;
  onComplete: (settings: UserSettings) => void;
  onCancel?: () => void;
}

export function SetupWizard({ initial, onComplete, onCancel }: SetupWizardProps): React.ReactNode {
  const { exit } = useApp();
  const initialProvider = asProvider(initial.llm.provider);
  const [step, setStep] = useState<Step>('provider');
  const [providerIndex, setProviderIndex] = useState(
    Math.max(0, PROVIDERS.findIndex((item) => item.value === initialProvider)),
  );
  const [provider, setProvider] = useState<ProviderName>(initialProvider);
  const [baseURL, setBaseURL] = useState(initial.llm.baseURL || DEFAULTS[initialProvider].url);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(initial.llm.model || DEFAULTS[initialProvider].models[0]);
  const [modelIndex, setModelIndex] = useState(0);
  const [error, setError] = useState('');

  const models = [...DEFAULTS[provider].models, '自定义模型…'];

  useInput((input, key) => {
    if (key.escape && onCancel) {
      onCancel();
      exit();
      return;
    }

    if (step === 'provider') {
      if (key.upArrow || input === 'k') setProviderIndex((providerIndex - 1 + PROVIDERS.length) % PROVIDERS.length);
      if (key.downArrow || input === 'j') setProviderIndex((providerIndex + 1) % PROVIDERS.length);
      if (key.return) {
        const selected = PROVIDERS[providerIndex].value;
        setProvider(selected);
        setBaseURL(DEFAULTS[selected].url);
        setModel(DEFAULTS[selected].models[0]);
        setModelIndex(0);
        setError('');
        setStep('url');
      }
      return;
    }

    if (step === 'model') {
      if (key.upArrow || input === 'k') setModelIndex((modelIndex - 1 + models.length) % models.length);
      if (key.downArrow || input === 'j') setModelIndex((modelIndex + 1) % models.length);
      if (key.return) {
        if (modelIndex === models.length - 1) {
          setModel('');
          setStep('custom-model');
        } else {
          setModel(models[modelIndex]);
          setStep('confirm');
        }
      }
      return;
    }

    if (step === 'confirm') {
      if (input.toLowerCase() === 'b') {
        setStep('model');
        return;
      }
      if (key.return || input.toLowerCase() === 'y') {
        try {
          const settings: UserSettings = {
            provider,
            baseURL: baseURL.trim(),
            model: model.trim(),
            apiKey: provider === 'ollama' ? '' : (apiKey || initial.llm.apiKey),
          };
          saveUserSettings(settings);
          onComplete(settings);
          exit();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }
  });

  const submitURL = (value: string) => {
    if (!/^https?:\/\//i.test(value.trim())) {
      setError('URL 必须以 http:// 或 https:// 开头');
      return;
    }
    setBaseURL(value.trim());
    setError('');
    setStep(provider === 'ollama' ? 'model' : 'key');
  };

  const submitKey = (value: string) => {
    if (!value && !initial.llm.apiKey) {
      setError('API Key 不能为空');
      return;
    }
    setError('');
    setStep('model');
  };

  const submitCustomModel = (value: string) => {
    if (!value.trim()) {
      setError('模型名称不能为空');
      return;
    }
    setModel(value.trim());
    setError('');
    setStep('confirm');
  };

  return (
    <Box flexDirection="column" paddingX={2}>
      <Brand />
      <Box marginTop={1} borderStyle="round" borderColor={tuiTheme.border} paddingX={2} flexDirection="column">
        <Text bold color={tuiTheme.accent}>首次启动配置</Text>
        <Text color={tuiTheme.muted}>配置保存在当前 Windows 用户目录，API Key 使用 DPAPI 加密。</Text>
        <Box marginTop={1} flexDirection="column">
          {step === 'provider' ? (
            <>
              <Text bold>1/4 选择模型服务</Text>
              {PROVIDERS.map((item, index) => (
                <Text key={item.value} color={index === providerIndex ? tuiTheme.brand : undefined}>
                  {index === providerIndex ? '❯ ' : '  '}{item.label} <Text color={tuiTheme.muted}>— {item.hint}</Text>
                </Text>
              ))}
              <Text color={tuiTheme.muted}>↑↓ 选择 · Enter 确认</Text>
            </>
          ) : null}

          {step === 'url' ? (
            <>
              <Text bold>2/4 API Base URL</Text>
              <Box borderStyle="single" borderColor={tuiTheme.brand} paddingX={1}>
                <LineInput value={baseURL} onChange={setBaseURL} onSubmit={submitURL} />
              </Box>
            </>
          ) : null}

          {step === 'key' ? (
            <>
              <Text bold>3/4 API Key</Text>
              <Box borderStyle="single" borderColor={tuiTheme.brand} paddingX={1}>
                <LineInput
                  value={apiKey}
                  onChange={setApiKey}
                  onSubmit={submitKey}
                  mask
                  placeholder={initial.llm.apiKey ? '留空并回车可使用现有密钥' : '输入 API Key'}
                />
              </Box>
            </>
          ) : null}

          {step === 'model' ? (
            <>
              <Text bold>{provider === 'ollama' ? '3/3' : '4/4'} 选择模型</Text>
              {models.map((item, index) => (
                <Text key={item} color={index === modelIndex ? tuiTheme.brand : undefined}>
                  {index === modelIndex ? '❯ ' : '  '}{item}
                </Text>
              ))}
              <Text color={tuiTheme.muted}>↑↓ 选择 · Enter 确认</Text>
            </>
          ) : null}

          {step === 'custom-model' ? (
            <>
              <Text bold>输入自定义模型名称</Text>
              <Box borderStyle="single" borderColor={tuiTheme.brand} paddingX={1}>
                <LineInput value={model} onChange={setModel} onSubmit={submitCustomModel} placeholder="model-name" />
              </Box>
            </>
          ) : null}

          {step === 'confirm' ? (
            <>
              <Text bold color={tuiTheme.success}>配置预览</Text>
              <Text>Provider  <Text color={tuiTheme.brand}>{provider}</Text></Text>
              <Text>URL       <Text color={tuiTheme.brand}>{baseURL}</Text></Text>
              <Text>Model     <Text color={tuiTheme.brand}>{model}</Text></Text>
              <Text>API Key   <Text color={tuiTheme.brand}>{provider === 'ollama' ? '不需要' : '已加密保存'}</Text></Text>
              <Text color={tuiTheme.muted}>Enter/Y 保存 · B 返回</Text>
            </>
          ) : null}
        </Box>
        {error ? <Text color={tuiTheme.error}>✗ {error}</Text> : null}
      </Box>
    </Box>
  );
}

function asProvider(value: string): ProviderName {
  return PROVIDERS.some((item) => item.value === value) ? value as ProviderName : 'deepseek';
}
