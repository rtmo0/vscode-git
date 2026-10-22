import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/git/git';
import { parseStatus } from '../src/git/status';

const record = (...parts: string[]) => parts.join('\0') + '\0';

test('parses branch headers, renames with their source, conflicts and paths with spaces', () => {
  const status = parseStatus(
    record(
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head feature/login',
      '# branch.upstream origin/feature/login',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/my file.ts',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new name.ts',
      'src/old name.ts',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt',
      '? notes/todo list.md',
      '! dist/extension.js'
    )
  );

  assert.deepEqual(status.branch, {
    oid: '1111111111111111111111111111111111111111',
    head: 'feature/login',
    upstream: 'origin/feature/login',
    ahead: 2,
    behind: 3
  });
  assert.deepEqual(status.changes, [
    { kind: 'changed', path: 'src/my file.ts', index: '.', workTree: 'M' },
    { kind: 'renamed', path: 'src/new name.ts', origPath: 'src/old name.ts', index: 'R', workTree: '.' },
    { kind: 'conflicted', path: 'conflict.txt', index: 'U', workTree: 'U' },
    { kind: 'untracked', path: 'notes/todo list.md', index: '?', workTree: '?' },
    { kind: 'ignored', path: 'dist/extension.js', index: '!', workTree: '!' }
  ]);
});

test('unborn and detached heads leave oid and head undefined', () => {
  assert.deepEqual(parseStatus(record('# branch.oid (initial)', '# branch.head main')).branch, { head: 'main', ahead: 0, behind: 0 });
  assert.deepEqual(parseStatus(record('# branch.oid abc', '# branch.head (detached)')).branch, { oid: 'abc', ahead: 0, behind: 0 });
});

test('parses the output of a real repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-awesome-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'tracked.txt'), 'one\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'tracked.txt'), 'two\n');
    writeFileSync(join(dir, 'new file.txt'), 'x\n');

    const status = parseStatus(await runGit('git', ['status', '--porcelain=v2', '--branch', '-z'], { cwd: dir }));
    assert.equal(status.branch.head, 'main');
    assert.deepEqual(
      status.changes.map((c) => [c.kind, c.path, c.index + c.workTree]),
      [
        ['changed', 'tracked.txt', '.M'],
        ['untracked', 'new file.txt', '??']
      ]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
