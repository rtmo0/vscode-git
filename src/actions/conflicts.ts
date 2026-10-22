import * as path from 'path';
import * as vscode from 'vscode';
import { GitError } from '../git/git';
import { FileChange } from '../git/status';
import { OPERATION_NAMES, Repository, RepositoryManager } from '../repository';
import { confirm, plural, separator, showError } from '../ui';

export type Side = 'yours' | 'theirs';

/**
 * During a rebase git calls the upstream "ours" and the replayed commit "theirs". As in JetBrains IDEs,
 * "Yours" is always the user's own work: the current branch in a merge, the rebased commits in a rebase.
 */
function gitSide(repo: Repository, side: Side): 'ours' | 'theirs' {
  const swap = repo.operation?.kind === 'rebase';
  return (side === 'yours') !== swap ? 'ours' : 'theirs';
}

/** Short names of both sides for labels. */
export function sideNames(repo: Repository): Record<Side, string> {
  const operation = repo.operation;
  switch (operation?.kind) {
    case 'merge':
      return { yours: repo.headLabel, theirs: operation.subject ?? 'merged changes' };
    case 'rebase':
      return { yours: operation.subject ?? 'rebased commits', theirs: operation.onto ?? 'upstream' };
    case 'cherry-pick':
    case 'revert':
      return { yours: repo.headLabel, theirs: operation.subject ?? 'commit' };
    default:
      return { yours: 'local changes', theirs: 'incoming changes' };
  }
}

/** Status letter of a side in a `u` status record: X is "ours", Y is "theirs". */
function sideStatus(repo: Repository, change: FileChange, side: Side): string {
  return gitSide(repo, side) === 'ours' ? change.index : change.workTree;
}

export function conflictDescription(repo: Repository, change: FileChange): string {
  const yours = sideStatus(repo, change, 'yours');
  const theirs = sideStatus(repo, change, 'theirs');
  if (yours === theirs) {
    return { D: 'Both deleted', A: 'Both added' }[yours] ?? 'Both modified';
  }
  if (yours === 'D' || theirs === 'D') {
    return yours === 'D' ? 'Deleted by you' : 'Deleted by them';
  }
  return yours === 'A' ? 'Added by you' : theirs === 'A' ? 'Added by them' : 'Both modified';
}

export async function accept(repo: Repository, changes: readonly FileChange[], side: Side): Promise<void> {
  const flag = `--${gitSide(repo, side)}`;
  for (const change of changes) {
    if (sideStatus(repo, change, side) === 'D') {
      await repo.exec(['rm', '--quiet', '--', change.path]);
    } else {
      await repo.exec(['checkout', flag, '--', change.path]);
      await repo.exec(['add', '--', change.path]);
    }
  }
  await repo.refresh();
}

export async function markResolved(repo: Repository, changes: readonly FileChange[]): Promise<void> {
  const unresolved = [];
  for (const change of changes) {
    const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === repo.fileUri(change.path).fsPath);
    const text = document?.getText();
    if (text && /^<{7} |^>{7} /m.test(text)) {
      unresolved.push(change.path);
    }
  }
  if (unresolved.length && !(await confirm(`${plural(unresolved.length, 'file')} still contain conflict markers.`, unresolved.join('\n'), 'Mark as Resolved'))) {
    return;
  }
  await repo.exec(['add', '-A', '--', ...changes.map((c) => c.path)]);
  await repo.refresh();
}

/** Opens the three-way merge editor; one-sided deletions cannot be merged and offer Accept instead. */
export async function merge(repo: Repository, change: FileChange): Promise<void> {
  if (sideStatus(repo, change, 'yours') === 'D' || sideStatus(repo, change, 'theirs') === 'D') {
    const names = sideNames(repo);
    const choice = await vscode.window.showWarningMessage(
      `${change.path}: ${conflictDescription(repo, change).toLowerCase()}.`,
      { modal: true, detail: 'A deletion conflict cannot be merged line by line. Keep one side.' },
      `Accept Yours (${names.yours})`,
      `Accept Theirs (${names.theirs})`
    );
    if (choice) {
      await accept(repo, [change], choice.startsWith('Accept Yours') ? 'yours' : 'theirs');
    }
    return;
  }
  // The built-in Git extension owns the merge editor and stages the file on "Complete Merge".
  await vscode.commands.executeCommand('git.openMergeEditor', repo.fileUri(change.path));
}

type ConflictItem = vscode.QuickPickItem & { change?: FileChange; all?: Side };

const ACCEPT_YOURS: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-left'), tooltip: 'Accept Yours' };
const ACCEPT_THEIRS: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-right'), tooltip: 'Accept Theirs' };

/** The Conflicts dialog: Enter opens Merge…, item buttons accept one side, the last entries accept a side for all files. */
export async function showConflicts(repo: Repository): Promise<void> {
  await repo.refresh();
  if (!repo.conflicts.length) {
    void vscode.window.showInformationMessage('There are no merge conflicts.');
    return;
  }
  const names = sideNames(repo);
  const quickPick = vscode.window.createQuickPick<ConflictItem>();
  quickPick.title = `Conflicts — ${repo.describeOperation() ?? repo.name}`;
  quickPick.placeholder = `Enter: Merge…   ← Accept Yours (${names.yours})   → Accept Theirs (${names.theirs})`;
  quickPick.matchOnDescription = true;

  const render = () => {
    quickPick.items = [
      ...repo.conflicts.map((change) => ({
        label: `$(warning) ${path.basename(change.path)}`,
        description: path.dirname(change.path) === '.' ? '' : path.dirname(change.path),
        detail: conflictDescription(repo, change),
        buttons: [
          { ...ACCEPT_YOURS, tooltip: `Accept Yours (${names.yours})` },
          { ...ACCEPT_THEIRS, tooltip: `Accept Theirs (${names.theirs})` }
        ],
        change
      })),
      separator(''),
      { label: `$(arrow-left) Accept Yours for All Files`, description: names.yours, all: 'yours' as const },
      { label: `$(arrow-right) Accept Theirs for All Files`, description: names.theirs, all: 'theirs' as const }
    ];
  };
  const run = async (task: () => Promise<void>) => {
    quickPick.busy = true;
    try {
      await task();
    } catch (error) {
      void showError(error);
    }
    quickPick.busy = false;
    if (repo.conflicts.length) {
      render();
    } else {
      quickPick.hide();
    }
  };

  render();
  quickPick.onDidTriggerItemButton(({ item, button }) => {
    if (item.change) {
      void run(() => accept(repo, [item.change!], button.tooltip?.startsWith('Accept Yours') ? 'yours' : 'theirs'));
    }
  });
  quickPick.onDidAccept(() => {
    const item = quickPick.selectedItems[0];
    if (item?.all) {
      void run(() => accept(repo, repo.conflicts, item.all!));
    } else if (item?.change) {
      quickPick.hide();
      void merge(repo, item.change).catch(showError);
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

/**
 * Runs a merge-like command. Conflicts are not an error: the Conflicts dialog opens, as in JetBrains IDEs.
 * Returns the command output, or undefined when it stopped on conflicts.
 */
export async function runWithConflicts(repo: Repository, args: string[]): Promise<string | undefined> {
  let output: string;
  try {
    output = await repo.exec(args);
  } catch (error) {
    await repo.refresh();
    if (repo.conflicts.length) {
      void showConflicts(repo);
      return undefined;
    }
    throw error;
  }
  await repo.refresh();
  if (repo.conflicts.length) {
    // An autostash that did not apply cleanly leaves conflicts after a successful command.
    void vscode.window.showWarningMessage('Your local changes were restored with conflicts; they are also kept in the stash.');
    void showConflicts(repo);
    return undefined;
  }
  return output;
}

export async function continueOperation(repo: Repository): Promise<void> {
  const operation = repo.operation;
  if (!operation) {
    return;
  }
  if (repo.conflicts.length) {
    void vscode.window.showWarningMessage(`Resolve ${plural(repo.conflicts.length, 'conflict')} before continuing.`);
    await showConflicts(repo);
    return;
  }
  if (operation.kind === 'merge') {
    // Merges are concluded from the Commit tool window, where the merge message is prefilled.
    await vscode.commands.executeCommand('git-awesome.commitMessage.focus');
    return;
  }
  try {
    const output = await runWithConflicts(repo, [operation.kind, '--continue']);
    if (output !== undefined && !repo.operation) {
      vscode.window.setStatusBarMessage(`$(check) ${OPERATION_NAMES[operation.kind]} completed`, 5000);
    }
  } catch (error) {
    if (operation.kind === 'rebase' && error instanceof GitError && /nothing to commit|No changes/.test(error.message)) {
      if (await confirm('The current commit has no changes left.', 'Skip it and continue rebasing?', 'Skip Commit')) {
        await skipCommit(repo);
      }
      return;
    }
    throw error;
  }
}

export async function skipCommit(repo: Repository): Promise<void> {
  await runWithConflicts(repo, ['rebase', '--skip']);
}

export async function abortOperation(repo: Repository): Promise<void> {
  const operation = repo.operation;
  if (!operation) {
    return;
  }
  const name = OPERATION_NAMES[operation.kind];
  if (await confirm(`Abort ${name.toLowerCase()}?`, `${repo.describeOperation()}. The repository returns to the state before the ${name.toLowerCase()}.`, `Abort ${name}`)) {
    await repo.exec([operation.kind, '--abort']);
    await repo.refresh();
  }
}

/** Offers to continue once the last conflict of a running operation is resolved. */
export function watchResolution(manager: RepositoryManager): vscode.Disposable {
  const counts = new Map<Repository, number>();
  return manager.onDidChange(() => {
    for (const repo of manager.repositories) {
      const previous = counts.get(repo) ?? 0;
      const current = repo.conflicts.length;
      counts.set(repo, current);
      if (previous > 0 && current === 0 && repo.operation) {
        const action = repo.operation.kind === 'merge' ? 'Commit Merge…' : `Continue ${OPERATION_NAMES[repo.operation.kind]}`;
        void vscode.window.showInformationMessage(`All conflicts in ${repo.name} are resolved.`, action).then((choice) => {
          if (choice) {
            void continueOperation(repo).catch(showError);
          }
        });
      }
    }
  });
}
