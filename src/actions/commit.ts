import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Inclusion, isUnversioned } from '../changes';
import { FileChange } from '../git/status';
import { Repository, RepositoryManager } from '../repository';
import { confirm, listPaths, plural, showError } from '../ui';
import { showConflicts } from './conflicts';
import { push } from './remote';

const HISTORY_KEY = 'git-awesome.messageHistory';
const HISTORY_SIZE = 30;

export interface CommitRequest {
  message: string;
  amend: boolean;
  push: boolean;
}

/** Pathspecs go through stdin: there is no command line length limit and names are never globs. */
const PATHSPEC_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

async function commitRepository(repo: Repository, changes: readonly FileChange[], messageFile: string, amend: boolean): Promise<void> {
  const unversioned = changes.filter(isUnversioned).map((c) => c.path);
  const paths = changes.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path]));
  const amendArgs = amend ? ['--amend'] : [];
  if (unversioned.length) {
    await repo.exec(['add', ...PATHSPEC_STDIN], { input: unversioned.join('\0') });
  }
  if (repo.operation && repo.operation.kind !== 'rebase') {
    // git refuses partial commits while merging, cherry-picking or reverting: stage, then commit everything.
    if (paths.length) {
      await repo.exec(['add', '-A', ...PATHSPEC_STDIN], { input: paths.join('\0') });
    }
    await repo.exec(['commit', ...amendArgs, '-F', messageFile]);
  } else if (paths.length) {
    // Commits exactly the checked files from the working tree, whatever is staged, like JetBrains IDEs.
    await repo.exec(['commit', ...amendArgs, '--only', '-F', messageFile, ...PATHSPEC_STDIN], { input: paths.join('\0') });
  } else {
    await repo.exec(['commit', '--amend', '--only', '-F', messageFile]);
  }
}

/** Commits the checked changes of every repository with one message. Returns whether it committed. */
export async function commit(manager: RepositoryManager, inclusion: Inclusion, state: vscode.Memento, request: CommitRequest): Promise<boolean> {
  const message = request.message.replace(/\s+$/, '');
  if (!message.trim()) {
    void vscode.window.showWarningMessage('Specify a commit message.');
    return false;
  }
  let targets = manager.repositories
    .map((repo) => ({ repo, changes: inclusion.includedChanges(repo) }))
    .filter((t) => t.changes.length > 0);
  if (!targets.length && request.amend) {
    const repo = await manager.pick('Amend Commit');
    targets = repo ? [{ repo, changes: [] }] : [];
  }
  if (!targets.length) {
    void vscode.window.showWarningMessage('No changes are selected for commit.');
    return false;
  }
  const conflicted = targets.find((t) => t.repo.conflicts.length);
  if (conflicted) {
    void vscode.window.showWarningMessage(`Resolve ${plural(conflicted.repo.conflicts.length, 'merge conflict')} in ${conflicted.repo.name} before committing.`);
    void showConflicts(conflicted.repo);
    return false;
  }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-awesome-'));
  const messageFile = path.join(dir, 'COMMIT_EDITMSG');
  const committed: Repository[] = [];
  try {
    await fs.promises.writeFile(messageFile, message + '\n', { mode: 0o600 });
    for (const { repo, changes } of targets) {
      await commitRepository(repo, changes, messageFile, request.amend);
      committed.push(repo);
    }
  } catch (error) {
    void showError(error, committed.length ? `Commit failed after committing ${committed.map((r) => r.name).join(', ')}` : 'Commit failed');
    return false;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await manager.refreshAll();
  }

  await addToHistory(state, message);
  const files = targets.reduce((sum, t) => sum + t.changes.length, 0);
  const subject = message.split('\n')[0];
  void vscode.window.showInformationMessage(
    request.amend ? `Commit amended: ${subject}` : `${plural(files, 'file')} committed: ${subject}`
  );
  if (request.push) {
    await push(manager, state, committed);
  }
  return true;
}

async function addToHistory(state: vscode.Memento, message: string): Promise<void> {
  const history = state.get<string[]>(HISTORY_KEY, []).filter((m) => m !== message);
  await state.update(HISTORY_KEY, [message, ...history].slice(0, HISTORY_SIZE));
}

export async function pickFromHistory(state: vscode.Memento): Promise<string | undefined> {
  const history = state.get<string[]>(HISTORY_KEY, []);
  if (!history.length) {
    void vscode.window.showInformationMessage('No commit messages yet.');
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(
    history.map((message) => ({ label: message.split('\n')[0], detail: message.includes('\n') ? message.split('\n').slice(1).join(' ').trim() : undefined, message })),
    { title: 'Commit Message History', matchOnDetail: true }
  );
  return choice?.message;
}

/** Rollback: tracked changes return to HEAD; added files become unversioned again and are kept on disk. */
export async function rollback(entries: readonly { repo: Repository; change: FileChange }[]): Promise<void> {
  const tracked = entries.filter((e) => e.change.kind === 'changed' || e.change.kind === 'renamed');
  if (!tracked.length) {
    void vscode.window.showInformationMessage(entries.length ? 'Unversioned files have nothing to roll back; use Delete to remove them.' : 'Select changes to roll back.');
    return;
  }
  if (!(await confirm(`Roll back changes in ${plural(tracked.length, 'file')}?`, listPaths(tracked.map((e) => e.change.path)), 'Rollback'))) {
    return;
  }
  for (const repo of new Set(tracked.map((e) => e.repo))) {
    const changes = tracked.filter((e) => e.repo === repo).map((e) => e.change);
    const added = changes.filter((c) => c.index === 'A').map((c) => c.path);
    const restored = changes.filter((c) => c.index !== 'A').flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path]));
    if (restored.length) {
      await repo.exec(['restore', '--source=HEAD', '--staged', '--worktree', ...PATHSPEC_STDIN], { input: restored.join('\0') });
    }
    if (added.length) {
      await repo.exec(['rm', '--cached', '--quiet', ...PATHSPEC_STDIN], { input: added.join('\0') });
    }
    await repo.refresh();
  }
}

export async function addToVcs(entries: readonly { repo: Repository; change: FileChange }[]): Promise<void> {
  for (const repo of new Set(entries.map((e) => e.repo))) {
    const paths = entries.filter((e) => e.repo === repo && isUnversioned(e.change)).map((e) => e.change.path);
    if (paths.length) {
      await repo.exec(['add', ...PATHSPEC_STDIN], { input: paths.join('\0') });
      await repo.refresh();
    }
  }
}

export async function deleteUnversioned(entries: readonly { repo: Repository; change: FileChange }[]): Promise<void> {
  const files = entries.filter((e) => isUnversioned(e.change));
  if (!files.length || !(await confirm(`Delete ${plural(files.length, 'unversioned file')}?`, `${listPaths(files.map((e) => e.change.path))}\n\nFiles are moved to the trash.`, 'Delete'))) {
    return;
  }
  for (const { repo, change } of files) {
    await vscode.workspace.fs.delete(repo.fileUri(change.path), { useTrash: true });
  }
  await Promise.all([...new Set(files.map((e) => e.repo))].map((repo) => repo.refresh()));
}

export async function addToGitignore(entries: readonly { repo: Repository; change: FileChange }[]): Promise<void> {
  for (const repo of new Set(entries.map((e) => e.repo))) {
    const lines = entries.filter((e) => e.repo === repo).map((e) => `/${e.change.path}`);
    const file = path.join(repo.root, '.gitignore');
    const existing = fs.existsSync(file) ? await fs.promises.readFile(file, 'utf8') : '';
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await fs.promises.appendFile(file, prefix + lines.join('\n') + '\n');
    await repo.refresh();
  }
}
