import type { ATKAgentErrorCode } from './errors.js';

export const EVENT_SCHEMA_VERSION = '1.0';

export interface CommandTraceEntry {
  timestamp: string;
  command: string;
  parameters: string;
  success: boolean;
  response: string;
  durationMs: number;
  sessionId?: string;
  atkPid?: number | null;
  scenario?: string | null;
  scenarioFingerprint?: string | null;
  startedAt?: string;
  completedAt?: string;
  atkStillBusy?: boolean;
}

export interface ArtifactRecord {
  type: 'scenario' | 'report' | 'ephemeris' | 'screenshot' | 'log' | 'checkpoint' | 'other';
  path: string;
  description?: string;
  sha256?: string;
}

export type ExecutionStatus = 'executed' | 'failed' | 'timeout' | 'cancelled' | 'dry_run';
export type VerificationStatus = 'not_requested' | 'unverified' | 'verified' | 'failed';

export interface ToolExecutionEnvelope<T = unknown> {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  success: boolean;
  executionStatus: ExecutionStatus;
  verificationStatus: VerificationStatus;
  tool: string;
  data: T;
  rawCommands: CommandTraceEntry[];
  artifacts: ArtifactRecord[];
  warnings: string[];
  durationMs: number;
  error?: {
    code: ATKAgentErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface ProductEvent {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  sequence: number;
  timestamp: string;
  runId: string;
  sessionId?: string;
  type:
    | 'run.started'
    | 'plan.created'
    | 'tool.started'
    | 'tool.progress'
    | 'tool.finished'
    | 'artifact.created'
    | 'validation.finished'
    | 'run.finished'
    | 'run.failed'
    | 'run.cancelled';
  payload: Record<string, unknown>;
}
