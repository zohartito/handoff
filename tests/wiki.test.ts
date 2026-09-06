import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHandoffPaths } from "../src/format/paths.js";
import {
  wikiAdd,
  wikiList,
  wikiDistill,
  parseWikiEntries,
  extractLessons,
} from "../src/commands/wiki.js";

function scaffoldHandoff(): ReturnType<typeof resolveHandoffPaths> {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-wiki-'));
  mkdirSync(join(dir, '.handoff'), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.meta, JSON.stringify({
    schemaVersion: 1,
    sourceTool: 'claude-code',
    sourceVersion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectRoot: dir,
  }));
  writeFileSync(paths.wiki, '# Wiki\n\n');
  writeFileSync(paths.corrections, '# Corrections\n\n');
  return paths;
}

test('parseWikiEntries - empty file returns []', () => {
  assert.deepEqual(parseWikiEntries(''), []);
  assert.deepEqual(parseWikiEntries('# Wiki\n\n'), []);
});

test('parseWikiEntries - single entry', () => {
  const raw =
    '## Always use pathlib over os.path\n' +
    '\n' +
    '_Added: 2026-01-01T00:00:00.000Z_\n' +
    '\n' +
    'Prefer pathlib for all file operations.\n' +
    '\n' +
    '---\n';
  const entries = parseWikiEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.title, 'Always use pathlib over os.path');
  assert.ok(entries[0]!.body.includes('Prefer pathlib'));
  assert.equal(entries[0]!.addedAt, '2026-01-01T00:00:00.000Z');
});

test('parseWikiEntries - multiple entries', () => {
  const raw =
    '## Entry one\n\n_Added: 2026-01-01T00:00:00.000Z_\n\nBody one.\n\n---\n\n' +
    '## Entry two\n\n_Added: 2026-01-02T00:00:00.000Z_\n\nBody two.\n\n---\n';
  const entries = parseWikiEntries(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.title, 'Entry one');
  assert.equal(entries[1]!.title, 'Entry two');
});

test('extractLessons - no lesson fields returns []', () => {
  assert.deepEqual(
    extractLessons('## 2026-01-01\n\n**agent did:** x\n**user said:** y\n'),
    [],
  );
});

test('extractLessons - single lesson', () => {
  const raw =
    '## 2026-01-01\n\n**agent did:** used os.path\n\n**user said:** use pathlib\n\n' +
    '**lesson:** always prefer pathlib over os.path\n\n---\n';
  const lessons = extractLessons(raw);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0], 'always prefer pathlib over os.path');
});

test('extractLessons - multiple lessons across entries', () => {
  const raw =
    '## 2026-01-01\n\n**lesson:** rule one\n\n---\n\n' +
    '## 2026-01-02\n\n**lesson:** rule two\n\n---\n';
  const lessons = extractLessons(raw);
  assert.deepEqual(lessons, ['rule one', 'rule two']);
});

test('wikiAdd - appends entry to wiki.md', async () => {
  const paths = scaffoldHandoff();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await wikiAdd({ title: 'Use pathlib', body: 'Always use pathlib.', cwd: paths.root });
  } finally {
    console.log = origLog;
  }
  const content = readFileSync(paths.wiki, 'utf8');
  assert.ok(content.includes('## Use pathlib'), 'title heading');
  assert.ok(content.includes('Always use pathlib.'), 'body');
  assert.ok(logs.some((l) => l.includes('wiki entry added')), 'success log');
});

test('wikiList - empty wiki prints placeholder', async () => {
  const paths = scaffoldHandoff();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  let entries: Awaited<ReturnType<typeof wikiList>> = [];
  try {
    entries = await wikiList({ cwd: paths.root });
  } finally {
    console.log = origLog;
  }
  assert.equal(entries.length, 0);
  assert.ok(logs.some((l) => l.includes('No wiki entries')));
});

test('wikiList - returns added entries', async () => {
  const paths = scaffoldHandoff();
  await wikiAdd({ title: 'Rule A', body: 'Body A.', cwd: paths.root });
  await wikiAdd({ title: 'Rule B', body: 'Body B.', cwd: paths.root });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  let entries: Awaited<ReturnType<typeof wikiList>> = [];
  try {
    entries = await wikiList({ cwd: paths.root });
  } finally {
    console.log = origLog;
  }
  assert.equal(entries.length, 2);
});

test('wikiDistill - no lessons in corrections produces no entries', async () => {
  const paths = scaffoldHandoff();
  writeFileSync(
    paths.corrections,
    '## 2026-01-01\n\n**agent did:** x\n**user said:** y\n\n---\n',
  );
  const result = await wikiDistill({ cwd: paths.root });
  assert.equal(result.added, 0);
});

test('wikiDistill - extracts lessons and writes wiki entries', async () => {
  const paths = scaffoldHandoff();
  writeFileSync(
    paths.corrections,
    '## 2026-01-01\n\n**agent did:** used os.path\n\n**user said:** use pathlib\n\n' +
      '**lesson:** always prefer pathlib over os.path\n\n---\n',
  );
  const result = await wikiDistill({ cwd: paths.root });
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
  const content = readFileSync(paths.wiki, 'utf8');
  assert.ok(content.includes('always prefer pathlib over os.path'), 'lesson body in wiki');
});

test('wikiDistill - deduplicates: existing lessons not re-added', async () => {
  const paths = scaffoldHandoff();
  const lesson = 'always prefer pathlib over os.path';
  writeFileSync(paths.corrections, '## 2026-01-01\n\n**lesson:** ' + lesson + '\n\n---\n');
  await wikiDistill({ cwd: paths.root });
  const result2 = await wikiDistill({ cwd: paths.root });
  assert.equal(result2.added, 0);
  assert.equal(result2.skipped, 1);
});

test('wikiDistill --dry-run - does not write to wiki.md', async () => {
  const paths = scaffoldHandoff();
  writeFileSync(paths.corrections, '## 2026-01-01\n\n**lesson:** some rule\n\n---\n');
  const before = readFileSync(paths.wiki, 'utf8');
  const result = await wikiDistill({ cwd: paths.root, dryRun: true });
  const after = readFileSync(paths.wiki, 'utf8');
  assert.equal(before, after, 'wiki.md must not change in dry-run');
  assert.equal(result.added, 1, 'dry-run still reports what it would add');
});

test('wikiDistill - multiple lessons, deduplicates within batch', async () => {
  const paths = scaffoldHandoff();
  writeFileSync(
    paths.corrections,
    '## 2026-01-01\n**lesson:** rule alpha\n---\n' +
    '## 2026-01-02\n**lesson:** rule beta\n---\n' +
    '## 2026-01-03\n**lesson:** rule alpha\n---\n',
  );
  const result = await wikiDistill({ cwd: paths.root });
  assert.equal(result.added, 2, 'only 2 unique lessons');
  assert.equal(result.skipped, 1, '1 duplicate within batch');
});

// --- Codex review fixes ------------------------------------------------------

test('extractLessons - skips superseded corrections', () => {
  const raw =
    '# Corrections\n\n' +
    '## 2026-01-01T00:00:00Z\n\n' +
    '**agent did:** used the old rule\n\n' +
    '**lesson:** the obsolete lesson\n\n' +
    '**superseded:** true\n\n---\n\n' +
    '## 2026-01-02T00:00:00Z\n\n' +
    '**agent did:** used the new rule\n\n' +
    '**lesson:** the current lesson\n\n---\n';
  const lessons = extractLessons(raw);
  assert.deepEqual(lessons, ['the current lesson']);
});

test('wikiDistill - superseded lessons never reach the wiki', async () => {
  const paths = scaffoldHandoff();
  writeFileSync(
    paths.corrections,
    '# Corrections\n\n' +
      '## 2026-01-01T00:00:00Z\n\n**lesson:** retired rule\n\n**superseded:** true\n\n---\n\n' +
      '## 2026-01-02T00:00:00Z\n\n**lesson:** live rule\n\n---\n',
  );
  const origLog = console.log;
  console.log = () => {};
  let res;
  try {
    res = await wikiDistill({ cwd: paths.root });
  } finally {
    console.log = origLog;
  }
  assert.equal(res.added, 1);
  const bodies = parseWikiEntries(readFileSync(paths.wiki, 'utf8')).map((e) => e.body);
  assert.ok(bodies.includes('live rule'));
  assert.ok(!bodies.includes('retired rule'), 'superseded lesson must not be distilled');
});

test('wikiDistill - concurrent runs do not create duplicate entries (read+dedup+append under lock)', async () => {
  const paths = scaffoldHandoff();
  writeFileSync(
    paths.corrections,
    '# Corrections\n\n## 2026-01-02T00:00:00Z\n\n**lesson:** exactly one durable rule\n\n---\n',
  );
  const origLog = console.log;
  console.log = () => {};
  try {
    // Fire two distills at once against the same wiki.md.
    await Promise.all([
      wikiDistill({ cwd: paths.root }),
      wikiDistill({ cwd: paths.root }),
    ]);
  } finally {
    console.log = origLog;
  }
  const entries = parseWikiEntries(readFileSync(paths.wiki, 'utf8'));
  const matching = entries.filter((e) => e.body === 'exactly one durable rule');
  assert.equal(matching.length, 1, 'the lesson must appear exactly once, not once per concurrent run');
});
