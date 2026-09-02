import { loadConfig } from '../dist/config.js';
import { ATKManager } from '../dist/atk/manager.js';
import { createATKTools } from '../dist/atk/tools/index.js';

const manager = new ATKManager(loadConfig().atk);
const tools = createATKTools(manager);

function getTool(name) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

try {
  const execute = getTool('execute_atk_connect_command');
  const results = [];
  for (const [command, parameters] of [
    ['GetATKVersion', '/ Platform'],
    ['AllInstanceNames', '/'],
  ]) {
    const raw = await execute.execute({ command, parameters });
    results.push(JSON.parse(String(raw)));
  }
  console.log(JSON.stringify({ status: 'success', results }, null, 2));
} finally {
  await manager.dispose();
}
