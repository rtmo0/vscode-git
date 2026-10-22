import * as vscode from 'vscode';
import { commitChanges, openDiffs, revisionDiff, showRefChanges } from '../diff';
import { Commit } from '../git/parse';
import { Repository } from '../repository';
import { confirm, notify, pick, separator, BACK } from '../ui';
import { ActionItem, newBranch, newTag, smartCheckout } from './branches';
import { runWithConflicts } from './conflicts';

export async function showAllCommitChanges(repo: Repository, commit: Commit): Promise<void> {
  const changes = await commitChanges(repo, commit);
  await openDiffs(`${commit.shortHash} ${commit.subject}`, changes.map((c) => revisionDiff(repo, c, commit.parents[0], commit.hash)));
}

/** A merge commit is cherry-picked or reverted relative to its first parent. */
const mainline = (commit: Commit) => (commit.parents.length > 1 ? ['-m', '1'] : []);

async function cherryPick(repo: Repository, commit: Commit): Promise<void> {
  if ((await runWithConflicts(repo, ['cherry-pick', ...mainline(commit), commit.hash])) !== undefined) {
    notify(`$(check) Cherry-picked ${commit.shortHash}`);
  }
}

async function revert(repo: Repository, commit: Commit): Promise<void> {
  if ((await runWithConflicts(repo, ['revert', '--no-edit', ...mainline(commit), commit.hash])) !== undefined) {
    notify(`$(check) Reverted ${commit.shortHash}`);
  }
}

async function resetTo(repo: Repository, commit: Commit): Promise<void> {
  const modes = [
    { label: 'Soft', detail: 'Files and the index stay; the commits after it become staged changes', mode: 'soft' },
    { label: 'Mixed', detail: 'Files stay; the commits after it become unstaged changes', mode: 'mixed' },
    { label: 'Hard', detail: 'Files and the index are reset; uncommitted changes are lost', mode: 'hard' },
    { label: 'Keep', detail: 'Files changed after it are reset, local changes are kept', mode: 'keep' }
  ];
  const choice = await pick(modes, { title: `Reset '${repo.headLabel}' to ${commit.shortHash}`, placeholder: commit.subject });
  if (!choice || choice === BACK) {
    return;
  }
  if (choice.mode === 'hard' && !(await confirm(`Hard reset '${repo.headLabel}' to ${commit.shortHash}?`, 'Uncommitted changes are lost.', 'Reset'))) {
    return;
  }
  await repo.exec(['reset', `--${choice.mode}`, commit.hash]);
  await repo.refresh();
  notify(`$(check) Reset ${repo.headLabel} to ${commit.shortHash}`);
}

/** Undo Commit: the last commit becomes uncommitted changes and its message returns to the commit box. */
async function undoCommit(repo: Repository, commit: Commit, restoreMessage: (text: string) => void): Promise<void> {
  const message = await repo.exec(['log', '-1', '--format=%B', commit.hash], { quiet: true });
  await repo.exec(['reset', '--soft', commit.parents[0] ?? 'HEAD~1']);
  await repo.refresh();
  restoreMessage(message.trim());
  notify(`$(check) Undid commit ${commit.shortHash}`);
}

async function editMessage(repo: Repository, commit: Commit): Promise<void> {
  const message = (await repo.exec(['log', '-1', '--format=%B', commit.hash], { quiet: true })).trim();
  const [subject, ...body] = message.split('\n');
  const edited = await vscode.window.showInputBox({ title: 'Edit Commit Message', value: subject, prompt: body.length ? 'The message body is kept' : undefined });
  if (edited === undefined || edited === subject) {
    return;
  }
  await repo.exec(['commit', '--amend', '--only', '--allow-empty', '-F', '-'], { input: [edited, ...body].join('\n') + '\n' });
  await repo.refresh();
}

/** Actions for a commit in the Log's context menu. */
export function commitActionItems(repo: Repository, commit: Commit, restoreMessage: (text: string) => void): ActionItem[] {
  const isHead = commit.hash === repo.status.branch.oid;
  const items: ActionItem[] = [
    { label: 'Copy Revision Number', action: () => vscode.env.clipboard.writeText(commit.hash) },
    { label: 'Show All Changes', action: () => showAllCommitChanges(repo, commit) },
    { label: 'Compare with Local', action: () => showRefChanges(repo, `${commit.shortHash} ↔ Local`, commit.hash, undefined) },
    separator(''),
    { label: 'Cherry-Pick', action: () => cherryPick(repo, commit) },
    { label: 'Checkout Revision', action: () => smartCheckout(repo, [commit.hash], commit.shortHash) },
    separator(''),
    { label: `Reset Current Branch to Here…`, action: () => resetTo(repo, commit) },
    { label: 'Revert Commit', action: () => revert(repo, commit) }
  ];
  if (isHead && repo.head && commit.parents.length) {
    items.push(
      { label: 'Undo Commit…', action: () => undoCommit(repo, commit, restoreMessage) },
      { label: 'Edit Commit Message…', action: () => editMessage(repo, commit) }
    );
  }
  items.push(
    separator(''),
    { label: 'New Branch…', action: () => newBranch(repo, commit.hash) },
    { label: 'New Tag…', action: () => newTag(repo, commit.hash) }
  );
  return items;
}
