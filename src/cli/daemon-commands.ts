import type { Command } from 'commander';
import { getAgentDataRoot } from '../core/app-runtime.js';
import { daemonRequest, daemonStatus, ensureDaemon } from '../daemon/client.js';
import { runSessionDaemon } from '../daemon/server.js';
import { listATKInstances } from '../atk/instances.js';
import { SessionStore } from '../core/session-store.js';
import { VERSION } from '../version.js';

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('管理长期持有 ATK CONNECT 的 Session daemon');
  daemon.command('start')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (options: { session: string }) => {
      process.stdout.write(`${JSON.stringify(await ensureDaemon(getAgentDataRoot(), options.session), null, 2)}\n`);
    });
  daemon.command('status')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (options: { session: string }) => {
      const status = await daemonStatus(getAgentDataRoot(), options.session);
      process.stdout.write(`${JSON.stringify(status ?? { running: false, sessionId: options.session }, null, 2)}\n`);
      if (!status) process.exitCode = 3;
    });
  daemon.command('stop')
    .requiredOption('--session <id>', 'Session ID')
    .option('--close-atk', '同时关闭该 Session 自己启动的 ATK')
    .action(async (options: { session: string; closeAtk?: boolean }) => {
      const result = await daemonRequest(getAgentDataRoot(), options.session, 'stop', {
        keepATKAlive: !options.closeAtk,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  daemon.command('serve', { hidden: true })
    .requiredOption('--session <id>')
    .action(async (options: { session: string }) => runSessionDaemon(options.session));

  const instance = program.command('instance').description('发现并严格绑定 ATK 实例');
  instance.command('list').action(async () => {
    process.stdout.write(`${JSON.stringify({ instances: await listATKInstances() }, null, 2)}\n`);
  });
  instance.command('attach')
    .requiredOption('--pid <pid>', 'ATK PID')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (options: { pid: string; session: string }) => {
      await ensureDaemon(getAgentDataRoot(), options.session);
      const result = await daemonRequest(getAgentDataRoot(), options.session, 'attach', { pid: Number(options.pid) });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  instance.command('current')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (options: { session: string }) => {
      const status = await daemonStatus(getAgentDataRoot(), options.session);
      if (status) process.stdout.write(`${JSON.stringify(status.instance ?? null, null, 2)}\n`);
      else {
        const manifest = await new SessionStore(getAgentDataRoot(), options.session, VERSION).readManifest();
        process.stdout.write(`${JSON.stringify(manifest?.atk ?? null, null, 2)}\n`);
      }
    });
  instance.command('detach')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (options: { session: string }) => {
      const result = await daemonRequest(getAgentDataRoot(), options.session, 'detach');
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  const operation = program.command('operation').description('查看、取消或等待 Session 长任务');
  operation.command('status')
    .requiredOption('--session <id>')
    .action(async (options: { session: string }) => {
      const status = await daemonRequest(getAgentDataRoot(), options.session, 'status');
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    });
  operation.command('cancel')
    .requiredOption('--session <id>')
    .action(async (options: { session: string }) => {
      const result = await daemonRequest(getAgentDataRoot(), options.session, 'cancel');
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  operation.command('wait')
    .requiredOption('--session <id>')
    .option('--timeout <ms>', '等待毫秒数', '60000')
    .option('--recover', '失败/取消后探测 ATK，确认响应后恢复 idle')
    .action(async (options: { session: string; timeout: string; recover?: boolean }) => {
      const timeoutMs = Number(options.timeout);
      const result = await daemonRequest(getAgentDataRoot(), options.session, 'wait', {
        timeoutMs, recover: options.recover === true,
      }, timeoutMs + 2000);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
}
