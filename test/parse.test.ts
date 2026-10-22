import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseLog, parseNameStatus, parseRecentCheckouts, parseRefs } from '../src/git/parse';

test('parses local, remote and tag refs; remote names may contain slashes; remote HEAD is skipped', () => {
  const line = (...fields: string[]) => fields.join('\0');
  const refs = parseRefs(
    [
      line('refs/heads/main', 'aaa', 'origin/main', 'ahead 2, behind 1', '1700000000', '*'),
      line('refs/heads/old', 'bbb', 'origin/old', 'gone', '1600000000', ' '),
      line('refs/remotes/origin/HEAD', 'aaa', '', '', '1700000000', ' '),
      line('refs/remotes/origin/feature/login', 'ccc', '', '', '1700000001', ' '),
      line('refs/remotes/team/backend/fix', 'ddd', '', '', '1700000002', ' '),
      line('refs/tags/v1.0', 'eee', '', '', '1500000000', ' ')
    ].join('\n') + '\n',
    ['origin', 'team/backend']
  );
  assert.deepEqual(
    refs.map((r) => [r.type, r.name, r.remote, r.remoteBranch, r.upstream, r.ahead, r.behind, r.upstreamGone, r.current]),
    [
      ['head', 'main', undefined, undefined, 'origin/main', 2, 1, false, true],
      ['head', 'old', undefined, undefined, 'origin/old', 0, 0, true, false],
      ['remote', 'origin/feature/login', 'origin', 'feature/login', undefined, 0, 0, false, false],
      ['remote', 'team/backend/fix', 'team/backend', 'fix', undefined, 0, 0, false, false],
      ['tag', 'v1.0', undefined, undefined, undefined, 0, 0, false, false]
    ]
  );
});

test('parses name-status with renames and paths containing spaces', () => {
  assert.deepEqual(parseNameStatus(['M', 'a b.txt', 'R087', 'old.ts', 'new.ts', 'D', 'gone.txt', 'A', 'new file', ''].join('\0')), [
    { status: 'M', path: 'a b.txt' },
    { status: 'R', origPath: 'old.ts', path: 'new.ts' },
    { status: 'D', path: 'gone.txt' },
    { status: 'A', path: 'new file' }
  ]);
});

test('parses log records including root commits and merges', () => {
  const record = (...fields: string[]) => '\x1e' + fields.join('\0') + '\n';
  const commits = parseLog(record('h1', 's1', 'Ann', 'a@x', '1700000000', 'p1 p2', 'Merge branch x') + record('h2', 's2', 'Bob', 'b@x', '1600000000', '', 'Initial'));
  assert.deepEqual(
    commits.map((c) => [c.hash, c.parents, c.subject]),
    [
      ['h1', ['p1', 'p2'], 'Merge branch x'],
      ['h2', [], 'Initial']
    ]
  );
});

test('recent checkouts are unique, most recent first', () => {
  const reflog = ['checkout: moving from feature to main', 'commit: x', 'checkout: moving from main to feature', 'checkout: moving from dev to main'].join('\n');
  assert.deepEqual(parseRecentCheckouts(reflog), ['main', 'feature', 'dev']);
});
