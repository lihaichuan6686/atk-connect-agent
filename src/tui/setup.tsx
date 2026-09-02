import React from 'react';
import { render } from 'ink';
import type { AppConfig } from '../config.js';
import type { UserSettings } from '../settings/user-settings.js';
import { SetupWizard } from './SetupWizard.js';

export async function runSetupWizard(initial: AppConfig): Promise<UserSettings | null> {
  let result: UserSettings | null = null;
  const instance = render(
    <SetupWizard
      initial={initial}
      onComplete={(settings) => { result = settings; }}
      onCancel={() => { result = null; }}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return result;
}
