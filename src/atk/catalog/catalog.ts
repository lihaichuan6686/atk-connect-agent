import catalogData from './commands.json' with { type: 'json' };
import statsData from './stats.json' with { type: 'json' };

export interface ATKDocumentationEntry {
  id: string;
  kind: 'command' | 'reference';
  category: string;
  title: string;
  command: string | null;
  summary: string;
  usage: string;
  examples: string[];
  details: string;
  source: string;
}

export interface ATKCatalogStats {
  generatedAt: string;
  sourceRoot: string;
  files: number;
  entries: number;
  commandEntries: number;
  referenceEntries: number;
  uniqueCommands: number;
  commands: string[];
  categories: string[];
  commandEntriesWithoutCommand: Array<{ source: string; title: string; usage: string }>;
}

export const atkCommandCatalog = catalogData as ATKDocumentationEntry[];
export const atkCatalogStats = statsData as ATKCatalogStats;

const canonicalCommands = new Map(
  atkCatalogStats.commands.map((command) => [command.toLowerCase(), command]),
);

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s_\-./]+/g, ' ').trim();
}

function scoreEntry(entry: ATKDocumentationEntry, query: string): number {
  const needle = normalized(query);
  if (!needle) return 1;
  const command = normalized(entry.command ?? '');
  const title = normalized(entry.title);
  const category = normalized(entry.category);
  const haystack = normalized([
    entry.command, entry.title, entry.category, entry.summary, entry.usage, entry.details,
  ].filter(Boolean).join(' '));
  let score = 0;
  if (command === needle) score += 100;
  if (title === needle) score += 80;
  if (command.startsWith(needle)) score += 45;
  if (title.startsWith(needle)) score += 35;
  if (category.includes(needle)) score += 20;
  if (haystack.includes(needle)) score += 15;
  for (const token of needle.split(' ').filter(Boolean)) {
    if (haystack.includes(token)) score += 4;
  }
  return score;
}

export function searchATKDocumentation(
  query: string,
  options: { category?: string; limit?: number } = {},
): ATKDocumentationEntry[] {
  const category = normalized(options.category ?? '');
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
  return atkCommandCatalog
    .filter((entry) => !category || normalized(entry.category).includes(category))
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function getATKCommandHelp(
  query: string,
  category?: string,
  limit = 8,
): ATKDocumentationEntry[] {
  const needle = normalized(query);
  const categoryNeedle = normalized(category ?? '');
  const officialCommand = canonicalATKCommand(query);
  const exact = atkCommandCatalog.filter((entry) => {
    if (categoryNeedle && !normalized(entry.category).includes(categoryNeedle)) return false;
    if (officialCommand) return normalized(entry.command ?? '') === needle;
    return normalized(entry.command ?? '') === needle || normalized(entry.title) === needle;
  });
  return (exact.length > 0 ? exact : searchATKDocumentation(query, { category, limit }))
    .slice(0, Math.min(Math.max(limit, 1), 20));
}

export function canonicalATKCommand(command: string): string | undefined {
  return canonicalCommands.get(command.trim().toLowerCase());
}

export function isOfficialATKCommand(command: string): boolean {
  return canonicalATKCommand(command) !== undefined;
}
