import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const defaultDocsRoot = resolve(
  projectRoot,
  '..',
  'atk-doc-offline',
  'atk-doc',
  '二次开发教程',
  '1-二次开发CONNECT模式',
  '2-Connect命令库',
);
const docsRoot = resolve(process.argv[2] || defaultDocsRoot);
const outputDir = resolve(projectRoot, 'src', 'atk', 'catalog');

const entities = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['ndash', '–'], ['mdash', '—'],
]);

function decodeHtml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return entities.get(entity.toLowerCase()) ?? match;
  });
}

function plainText(html, preserveLines = false) {
  let value = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|tr|h\d|div|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  value = decodeHtml(value).replace(/\r/g, '');
  if (preserveLines) {
    return value.split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim())
      .filter(Boolean).join('\n').trim();
  }
  return value.replace(/\s+/g, ' ').trim();
}

function firstParagraph(section, label) {
  const expression = new RegExp(`<p[^>]*>\\s*${label}([\\s\\S]*?)<\\/p>`, 'i');
  const match = section.match(expression);
  return match ? plainText(match[1]) : '';
}

function codeBlocks(section) {
  return [...section.matchAll(/<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi)]
    .map((match) => plainText(match[1], true))
    .filter(Boolean);
}

function usageBlock(section) {
  // A few pages place “作用” and “用法” in the same paragraph with a <br>.
  const marker = section.search(/用法[：:]?/i);
  if (marker < 0) return '';
  return codeBlocks(section.slice(marker))[0] ?? '';
}

function categoryFromPath(file) {
  const parts = relative(docsRoot, file).split(sep);
  const rootName = parts[0].replace(/\.html$/i, '').replace(/^\d+-/, '');
  if (parts.length === 1) return rootName;
  const pageName = basename(file, '.html').replace(/^\d+-/, '');
  return pageName === 'index' ? rootName : `${rootName}/${pageName}`;
}

function commandFromUsage(usage) {
  const firstLine = usage.split('\n')[0]?.trim() ?? '';
  const match = firstLine.match(/^([A-Za-z][A-Za-z0-9_]*)\b/);
  return match?.[1] ?? null;
}

async function listHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return listHtmlFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith('.html')) return [];
    // The library root index is navigation only. Astrogator/index.html is a real command page.
    if (directory === docsRoot && entry.name === 'index.html') return [];
    return [fullPath];
  }));
  return nested.flat().sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

function extractSections(html, file) {
  const headings = [...html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  return headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? html.length;
    const body = html.slice(start, end);
    const title = plainText(heading[2]);
    const usage = usageBlock(body);
    const blocks = codeBlocks(body);
    const usageIndex = usage ? blocks.indexOf(usage) : -1;
    const examples = blocks.filter((_, blockIndex) => blockIndex !== usageIndex).slice(0, 12);
    const summary = firstParagraph(body, '作用[：:]?') || firstParagraph(body, '说明[：:]?');
    const details = plainText(body).slice(0, 6000);
    return {
      id: '',
      kind: usage ? 'command' : 'reference',
      category: categoryFromPath(file),
      title,
      command: commandFromUsage(usage),
      summary,
      usage,
      examples,
      details,
      source: relative(docsRoot, file).split(sep).join('/'),
    };
  }).filter((entry) => entry.title && entry.title !== '在 GitHub 上编辑此页');
}

const files = await listHtmlFiles(docsRoot);
const entries = [];
for (const file of files) {
  const html = await readFile(file, 'utf8');
  entries.push(...extractSections(html, file));
}

const seen = new Set();
const catalog = entries.filter((entry) => {
  const key = [entry.source, entry.title, entry.usage].join('\0');
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
catalog.forEach((entry, index) => {
  entry.id = `atk-doc-${String(index + 1).padStart(4, '0')}`;
});

const commands = [...new Set(catalog.map((entry) => entry.command).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
const categories = [...new Set(catalog.map((entry) => entry.category))]
  .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
const stats = {
  generatedAt: new Date().toISOString(),
  sourceRoot: relative(projectRoot, docsRoot).split(sep).join('/'),
  files: files.length,
  entries: catalog.length,
  commandEntries: catalog.filter((entry) => entry.kind === 'command').length,
  referenceEntries: catalog.filter((entry) => entry.kind === 'reference').length,
  uniqueCommands: commands.length,
  commands,
  categories,
  commandEntriesWithoutCommand: catalog.filter((entry) => entry.kind === 'command' && !entry.command)
    .map(({ source, title, usage }) => ({ source, title, usage })),
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, 'commands.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8'),
  writeFile(resolve(outputDir, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`, 'utf8'),
]);

console.log(JSON.stringify(stats, null, 2));
