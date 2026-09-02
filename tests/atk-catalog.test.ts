import { describe, expect, it } from 'vitest';
import {
  atkCatalogStats,
  atkCommandCatalog,
  getATKCommandHelp,
  isOfficialATKCommand,
  searchATKDocumentation,
} from '../src/atk/catalog/catalog.js';

describe('offline ATK CONNECT catalog', () => {
  it('covers every effective command-library page without unresolved command entries', () => {
    expect(atkCatalogStats.files).toBe(27);
    expect(atkCatalogStats.entries).toBe(atkCommandCatalog.length);
    expect(atkCatalogStats.commandEntries).toBeGreaterThanOrEqual(200);
    expect(atkCatalogStats.uniqueCommands).toBeGreaterThanOrEqual(60);
    expect(atkCatalogStats.commandEntriesWithoutCommand).toEqual([]);
    expect(atkCommandCatalog.filter((entry) => entry.kind === 'command').every(
      (entry) => entry.command && isOfficialATKCommand(entry.command),
    )).toBe(true);
  });

  it('contains representative official commands from all major object groups', () => {
    for (const command of [
      'New', 'SetState', 'Define', 'SetPosition', 'Receiver', 'Transmitter',
      'AddWaypoint', 'Cov', 'Astrogator', 'Astrogator_RM', 'ReportCreate',
    ]) {
      expect(isOfficialATKCommand(command), command).toBe(true);
    }
  });

  it('searches Chinese functions and returns exact command variants', () => {
    expect(searchATKDocumentation('覆盖定义')[0]?.category).toContain('覆盖定义');
    const help = getATKCommandHelp('SetState', '卫星', 20);
    expect(help.length).toBeGreaterThan(3);
    expect(help.every((entry) => entry.command === 'SetState')).toBe(true);
    expect(help.some((entry) => entry.usage.includes('Classical'))).toBe(true);
  });
});
