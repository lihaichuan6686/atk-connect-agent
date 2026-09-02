import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolExecutionContext } from '../types.js';

const storage = new AsyncLocalStorage<ToolExecutionContext>();

export function runWithToolExecutionContext<T>(
  context: ToolExecutionContext,
  operation: () => T,
): T {
  return storage.run(context, operation);
}

export function currentToolExecutionContext(): ToolExecutionContext | undefined {
  return storage.getStore();
}
