/**
 * Checks the git behaviour the actions rely on, with the same arguments, in throw-away repositories.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGit } from '../src/git/git';
import { parseStatus } from '../src/git/status';

const PATHSPEC_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

async function withRepo(body: (git: (args: string[], input?: string) => Promise<string>, write: (path: string, text: string) => void, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'git-awesome-'));
  const git = (args: string[], input?: string) =>
    runGit('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, input });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    await git(['init', '-q', '-b', 'main']);
    await body(git, write, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const status = async (git: (args: string[]) => Promise<string>) =>
  parseStatus(await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])).changes.map((c) => `${c.index}${c.workTree} ${c.path}`);

test('commit --only commits exactly the checked files and leaves other staged changes staged', async () => {
  await withRepo(async (git, write, dir) => {
    write('a.txt', '1\n');
    write('b.txt', '1\n');
    write('app/[id]/page.tsx', '1\n');
    write('app/x/page.tsx', '1\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);

    write('a.txt', '2\n');
    write('b.txt', '2\n');
    await git(['add', 'b.txt']);
    write('app/[id]/page.tsx', '2\n');
    write('app/x/page.tsx', '2\n');
    write('new.txt', 'new\n');
    writeFileSync(join(dir, 'msg'), 'Checked files\n');

    // Unversioned files are added first, then all checked paths go through stdin.
    await git(['add', ...PATHSPEC_STDIN], 'new.txt');
    await git(['commit', '--only', '-F', 'msg', ...PATHSPEC_STDIN], ['a.txt', 'app/[id]/page.tsx', 'new.txt'].join('\0'));

    assert.equal((await git(['show', '--name-only', '--format=%s', 'HEAD'])).trim(), 'Checked files\n\na.txt\napp/[id]/page.tsx\nnew.txt');
    assert.deepEqual(await status(git), ['.M app/x/page.tsx', 'M. b.txt', '?? msg']);
  });
});

test('amend --only without paths changes only the message', async () => {
  await withRepo(async (git, write, dir) => {
    write('a.txt', '1\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'old']);
    write('a.txt', '2\n');
    await git(['add', 'a.txt']);
    writeFileSync(join(dir, 'msg'), 'new\n');
    await git(['commit', '--amend', '--only', '-F', 'msg']);
    assert.equal((await git(['log', '--format=%s'])).trim(), 'new');
    assert.ok((await status(git)).includes('M. a.txt'));
  });
});

test('rollback restores tracked files and keeps added files as unversioned', async () => {
  await withRepo(async (git, write, dir) => {
    write('a.txt', '1\n');
    write('gone.txt', '1\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    write('a.txt', '2\n');
    await git(['add', 'a.txt']);
    write('a.txt', '3\n');
    rmSync(join(dir, 'gone.txt'));
    write('added.txt', 'x\n');
    await git(['add', 'added.txt']);

    await git(['restore', '--source=HEAD', '--staged', '--worktree', ...PATHSPEC_STDIN], ['a.txt', 'gone.txt'].join('\0'));
    await git(['rm', '--cached', '--quiet', ...PATHSPEC_STDIN], 'added.txt');

    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '1\n');
    assert.ok(existsSync(join(dir, 'gone.txt')));
    assert.deepEqual(await status(git), ['?? added.txt']);
  });
});

test('during a rebase, "Accept Yours" (git --theirs) keeps the commit being rebased', async () => {
  await withRepo(async (git, write) => {
    write('f.txt', 'base\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'base']);
    await git(['checkout', '-qb', 'feature']);
    write('f.txt', 'feature\n');
    await git(['commit', '-qam', 'feature change']);
    await git(['checkout', '-q', 'main']);
    write('f.txt', 'main\n');
    await git(['commit', '-qam', 'main change']);
    await git(['checkout', '-q', 'feature']);

    await assert.rejects(git(['rebase', '--autostash', 'main']));
    assert.deepEqual(await status(git), ['UU f.txt']);
    await git(['checkout', '--theirs', '--', 'f.txt']);
    await git(['add', '--', 'f.txt']);
    await git(['rebase', '--continue']);
    assert.equal((await git(['show', 'HEAD:f.txt'])), 'feature\n');
    assert.equal((await git(['log', '--format=%s'])).trim(), 'feature change\nmain change\nbase');
  });
});

test('merge --autostash keeps unrelated local changes across a merge', async () => {
  await withRepo(async (git, write, dir) => {
    write('a.txt', '1\n');
    write('local.txt', '1\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    await git(['checkout', '-qb', 'feature']);
    write('a.txt', '2\n');
    await git(['commit', '-qam', 'feature']);
    await git(['checkout', '-q', 'main']);
    write('a.txt', 'dirty\n');
    write('local.txt', 'dirty\n');
    await assert.rejects(git(['merge', '--no-edit', 'feature']), /would be overwritten/);

    await git(['checkout', '-q', '--', 'a.txt']);
    await git(['merge', '--autostash', '--no-edit', 'feature']);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '2\n');
    assert.equal(readFileSync(join(dir, 'local.txt'), 'utf8'), 'dirty\n');
  });
});
