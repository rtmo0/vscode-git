import * as path from 'path';
import * as vscode from 'vscode';
import { isAdded, isDeleted } from './changes';
import { Commit, NameStatus, parseNameStatus } from './git/parse';
import { FileChange } from './git/status';
import { Repository, RepositoryManager } from './repository';
import { BACK, plural } from './ui';

export const SCHEME = 'git-awesome';

interface Query {
  root: string;
  /** Empty for a side that does not exist (an added or deleted file). */
  ref: string;
  path: string;
}

/** A read-only document with the content of `relativePath` at `ref`. */
export function gitUri(root: string, ref: string, relativePath: string): vscode.Uri {
  const query: Query = { root, ref, path: relativePath };
  return vscode.Uri.from({ scheme: SCHEME, path: vscode.Uri.file(path.join(root, relativePath)).path, query: JSON.stringify(query) });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepositoryManager) {
    // Content at a symbolic ref (HEAD, a branch) changes with the repository; commit hashes never do.
    this.subscription = manager.onDidChange(() => {
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme === SCHEME && !/^[0-9a-f]{40}$/.test((JSON.parse(document.uri.query) as Query).ref)) {
          this.changed.fire(document.uri);
        }
      }
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = JSON.parse(uri.query) as Query;
    const repo = this.manager.repositories.find((r) => r.root === query.root);
    if (!query.ref || !repo) {
      return '';
    }
    try {
      return await repo.exec(['show', `${query.ref}:${query.path}`], { quiet: true });
    } catch {
      return ''; // The file does not exist at that revision.
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

export interface DiffItem {
  resource: vscode.Uri;
  left: vscode.Uri;
  right: vscode.Uri;
  title: string;
}

/** HEAD ↔ working tree, the diff of the Commit tool window. */
export function workingTreeDiff(repo: Repository, change: FileChange): DiffItem {
  const resource = repo.fileUri(change.path);
  return {
    resource,
    left: gitUri(repo.root, isAdded(change) ? '' : 'HEAD', change.origPath ?? change.path),
    right: isDeleted(change) ? gitUri(repo.root, '', change.path) : resource,
    title: `${path.basename(change.path)} (HEAD ↔ Local)`
  };
}

function refLabel(ref: string): string {
  return /^[0-9a-f]{40}/.test(ref) ? ref.slice(0, 7) + ref.slice(40) : ref;
}

/** `leftRef` ↔ `rightRef`; an undefined `rightRef` is the working tree. */
export function revisionDiff(repo: Repository, change: NameStatus, leftRef: string | undefined, rightRef: string | undefined): DiffItem {
  const resource = repo.fileUri(change.path);
  return {
    resource,
    left: gitUri(repo.root, change.status === 'A' || !leftRef ? '' : leftRef, change.origPath ?? change.path),
    right: change.status === 'D' ? gitUri(repo.root, '', change.path) : rightRef ? gitUri(repo.root, rightRef, change.path) : resource,
    title: `${path.basename(change.path)} (${leftRef ? refLabel(leftRef) : 'empty'} ↔ ${rightRef ? refLabel(rightRef) : 'Local'})`
  };
}

export async function openDiff(item: DiffItem, options: vscode.TextDocumentShowOptions = {}): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', item.left, item.right, item.title, options);
}

/** One diff editor for one file, the multi-file diff editor for several. */
export async function openDiffs(title: string, items: DiffItem[]): Promise<void> {
  if (items.length === 1) {
    await openDiff(items[0], { preview: true });
  } else if (items.length > 1) {
    await vscode.commands.executeCommand(
      'vscode.changes',
      title,
      items.map((item) => [item.resource, item.left, item.right])
    );
  }
}

const STATUS_ICONS: Record<string, string> = { A: 'diff-added', D: 'diff-removed', R: 'diff-renamed', C: 'diff-added' };

/**
 * A changes browser: moving through the list previews each file's diff, Enter opens it,
 * the first entry opens all files in the multi-file diff editor.
 */
export function showChangesPick(
  repo: Repository,
  title: string,
  changes: NameStatus[],
  leftRef: string | undefined,
  rightRef: string | undefined,
  back = false
): Promise<typeof BACK | undefined> {
  if (!changes.length) {
    void vscode.window.showInformationMessage(`${title}: no changes.`);
    return Promise.resolve(undefined);
  }
  type Item = vscode.QuickPickItem & { change?: NameStatus };
  const all: Item = { label: '$(diff-multiple) Show All Changes', description: plural(changes.length, 'file') };
  const items: Item[] = [
    ...(changes.length > 1 ? [all] : []),
    ...changes.map((change) => ({
      label: `$(${STATUS_ICONS[change.status] ?? 'diff-modified'}) ${path.basename(change.path)}`,
      description: [path.dirname(change.path) === '.' ? '' : path.dirname(change.path), change.origPath ? `← ${change.origPath}` : '']
        .filter(Boolean)
        .join('  '),
      change
    }))
  ];
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<Item>();
    quickPick.title = title;
    quickPick.placeholder = 'Move through the list to preview a diff; Enter opens it';
    quickPick.matchOnDescription = true;
    quickPick.ignoreFocusOut = true;
    quickPick.items = items;
    quickPick.buttons = back ? [vscode.QuickInputButtons.Back] : [];
    let result: typeof BACK | undefined;
    quickPick.onDidChangeActive(([item]) => {
      if (item?.change) {
        void openDiff(revisionDiff(repo, item.change, leftRef, rightRef), { preview: true, preserveFocus: true });
      }
    });
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0];
      quickPick.hide();
      if (item === all) {
        void openDiffs(title, changes.map((change) => revisionDiff(repo, change, leftRef, rightRef)));
      } else if (item?.change) {
        void openDiff(revisionDiff(repo, item.change, leftRef, rightRef), { preview: false });
      }
    });
    quickPick.onDidTriggerButton(() => {
      result = BACK;
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(result);
    });
    quickPick.show();
  });
}

/** Files changed by a commit compared with its first parent, or with the empty tree for a root commit. */
export async function commitChanges(repo: Repository, commit: Pick<Commit, 'hash' | 'parents'>): Promise<NameStatus[]> {
  const parent = commit.parents[0];
  const output = parent
    ? await repo.exec(['diff', '--name-status', '-z', '-M', parent, commit.hash], { quiet: true })
    : await repo.exec(['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', commit.hash], { quiet: true });
  return parseNameStatus(output);
}

export async function showCommitChanges(repo: Repository, commit: Commit, back = false): Promise<typeof BACK | undefined> {
  return showChangesPick(repo, `${commit.shortHash} ${commit.subject}`, await commitChanges(repo, commit), commit.parents[0], commit.hash, back);
}

/** Lists files changed between `leftRef` and `rightRef` (undefined: working tree). */
export async function showRefChanges(repo: Repository, title: string, leftRef: string, rightRef: string | undefined, back = false) {
  const output = await repo.exec(['diff', '--name-status', '-z', '-M', leftRef, ...(rightRef ? [rightRef] : [])], { quiet: true });
  return showChangesPick(repo, title, parseNameStatus(output), leftRef, rightRef, back);
}
