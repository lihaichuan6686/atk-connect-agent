import { describe, expect, it } from 'vitest';
import { MemoryManager } from '../src/agent/memory.js';

describe('MemoryManager', () => {
  it('prunes complete turns without orphaning tool results', () => {
    const memory = new MemoryManager({ maxTokens: 90 });
    memory.setSystemPrompt('system');
    memory.add({ role: 'user', content: 'first '.repeat(20) });
    memory.add({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'tc1', name: 'sample', arguments: { value: 'x'.repeat(80) } }],
    });
    memory.add({ role: 'tool', content: 'result '.repeat(20), name: 'sample', tool_call_id: 'tc1' });
    memory.add({ role: 'assistant', content: 'done' });
    memory.add({ role: 'user', content: 'second turn' });
    memory.add({ role: 'assistant', content: 'answer' });

    const messages = memory.getAll();
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(messages[1]?.content).toBe('second turn');
  });
});
