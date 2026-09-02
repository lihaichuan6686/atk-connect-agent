export type ATKAgentErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'INVALID_INPUT'
  | 'TOOL_NOT_FOUND'
  | 'ATK_UNAVAILABLE'
  | 'ATTACH_FAILED'
  | 'MULTIPLE_ATK_INSTANCES'
  | 'OPERATION_BUSY'
  | 'RESOURCE_LIMIT'
  | 'DAEMON_UNAVAILABLE'
  | 'DAEMON_PERMISSION_MISMATCH'
  | 'CONNECT_COMMAND_FAILED'
  | 'VERIFICATION_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'AGENT_LOOP_LIMIT'
  | 'INTERNAL_ERROR';

export class ATKAgentError extends Error {
  constructor(
    public readonly code: ATKAgentErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ATKAgentError';
  }
}

export function toATKAgentError(cause: unknown): ATKAgentError {
  if (cause instanceof ATKAgentError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/NACK|CONNECT.*失败|命令.*失败/i.test(message)) {
    return new ATKAgentError('CONNECT_COMMAND_FAILED', message, undefined, { cause });
  }
  if (/未连接|无法连接|ATK.*不存在|ATK.*启动/i.test(message)) {
    return new ATKAgentError('ATK_UNAVAILABLE', message, undefined, { cause });
  }
  if (/超时|timeout/i.test(message)) {
    return new ATKAgentError('TIMEOUT', message, undefined, { cause });
  }
  if (/取消|cancel|abort/i.test(message)) {
    return new ATKAgentError('CANCELLED', message, undefined, { cause });
  }
  if (/验证失败|读回.*失败|未发现.*场景/i.test(message)) {
    return new ATKAgentError('VERIFICATION_FAILED', message, undefined, { cause });
  }
  if (/必须|非法|无效|未知工具|不在.*白名单/i.test(message)) {
    return new ATKAgentError('INVALID_INPUT', message, undefined, { cause });
  }
  return new ATKAgentError('INTERNAL_ERROR', message, undefined, { cause });
}

export function exitCodeFor(error: ATKAgentError): number {
  switch (error.code) {
    case 'CONFIGURATION_ERROR':
    case 'INVALID_INPUT':
    case 'TOOL_NOT_FOUND': return 2;
    case 'ATK_UNAVAILABLE': return 3;
    case 'ATTACH_FAILED':
    case 'MULTIPLE_ATK_INSTANCES':
    case 'DAEMON_UNAVAILABLE':
    case 'DAEMON_PERMISSION_MISMATCH': return 3;
    case 'OPERATION_BUSY': return 8;
    case 'RESOURCE_LIMIT': return 9;
    case 'CONNECT_COMMAND_FAILED': return 4;
    case 'AGENT_LOOP_LIMIT': return 5;
    case 'CANCELLED':
    case 'TIMEOUT': return 6;
    case 'VERIFICATION_FAILED': return 7;
    default: return 1;
  }
}
