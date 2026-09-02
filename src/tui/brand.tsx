import React from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';

const ORBITLING = [
  '          ·       ✦',
  '       .-========-.',
  '    __(  ◉      ◉  )__',
  '   /   \\     △     /   \\',
  '   \\____\'-.____.-\'____/',
  '       ╰──╯  ╰──╯',
  '      ──── orbit ────',
];

export function Brand({ compact = false }: { compact?: boolean }): React.ReactNode {
  if (compact) {
    return (
      <Text bold color={tuiTheme.brand}>
        ◉ ATK Agent
      </Text>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      {ORBITLING.map((line) => (
        <Text key={line} color={tuiTheme.brand}>{line}</Text>
      ))}
      <Text bold color={tuiTheme.accent}>ATK ORBITLING · 小轨</Text>
      <Text color={tuiTheme.muted}>你的航天任务设计搭档</Text>
    </Box>
  );
}
