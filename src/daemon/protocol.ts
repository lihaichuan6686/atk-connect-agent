import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ToolExecutionEnvelope } from '../core/contracts.js';
import type { ATKInstanceBinding, SessionOperationState } from '../core/session-store.js';

export type DaemonMethod = 'ping' | 'status' | 'execute' | 'attach' | 'detach' | 'cancel' | 'wait' | 'stop';

export interface DaemonRequest {
  id: string;
  method: DaemonMethod;
  params?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface DaemonStatus {
  sessionId: string;
  daemonPid: number;
  sidecarPid: number | null;
  connected: boolean;
  instance?: ATKInstanceBinding;
  operation: SessionOperationState;
  startedAt: string;
}

export interface DaemonExecuteResult {
  envelope: ToolExecutionEnvelope;
  operation: SessionOperationState;
}

export function daemonEndpoint(dataRoot: string, sessionId: string): string {
  const key = createHash('sha256').update(resolve(dataRoot)).update('\0').update(sessionId).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\atk-agent-${key}`
    : resolve(dataRoot, `daemon-${key}.sock`);
}
