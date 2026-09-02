import React from 'react';
import { Text, useInput } from 'ink';
import { tuiTheme } from './theme.js';

interface LineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  active?: boolean;
  mask?: boolean;
  placeholder?: string;
}

export function LineInput({
  value,
  onChange,
  onSubmit,
  active = true,
  mask = false,
  placeholder = '',
}: LineInputProps): React.ReactNode {
  useInput((input, key) => {
    if (!active) return;
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      onChange(Array.from(value).slice(0, -1).join(''));
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape && input) {
      onChange(value + input);
    }
  }, { isActive: active });

  const shown = mask ? '•'.repeat(Array.from(value).length) : value;
  return (
    <Text>
      {shown ? <Text>{shown}</Text> : <Text color={tuiTheme.muted}>{placeholder}</Text>}
      {active ? <Text color={tuiTheme.brand}>▌</Text> : null}
    </Text>
  );
}
