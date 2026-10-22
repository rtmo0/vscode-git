import * as path from 'path';
import * as vscode from 'vscode';
import { isAdded, isDeleted } from './changes';
import { FileChange } from './git/status';
import { RepositoryManager } from './repository';

const SETTING = 'jetbrainsColors';

/** Theme color id for a change, contributed in package.json with the JetBrains file status palette. */
export function statusColor(change: FileChange): string {
  if (change.kind === 'conflicted') {
    return 'gitAwesome.conflictForeground';
  }
  if (change.kind === 'untracked') {
    return 'gitAwesome.unversionedForeground';
  }
  if (change.kind === 'ignored') {
    return 'gitAwesome.ignoredForeground';
  }
  if (isDeleted(change)) {
    return 'gitAwesome.deletedForeground';
  }
  if (isAdded(change)) {
    return 'gitAwesome.addedForeground';
  }
  return change.kind === 'renamed' ? 'gitAwesome.renamedForeground' : 'gitAwesome.modifiedForeground';
}

/**
 * Colors changed files in the Explorer, editor tabs and the Changes view with JetBrains file status colors.
 *
 * VS Code takes the color of the most recently registered provider, so the provider re-registers after the
 * built-in Git extension has registered its own for a newly opened repository.
 */
export class FileColors implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private changes = new Map<string, FileChange>();
  private registration?: vscode.Disposable;
  private roots = '';
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: RepositoryManager) {
    this.disposables = [
      this.changed,
      manager.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`git-awesome.${SETTING}`)) {
          this.changed.fire(undefined);
        }
      }),
      { dispose: () => clearTimeout(this.timer) }
    ];
    this.register();
    this.update();
  }

  private register(): void {
    this.registration?.dispose();
    this.registration = vscode.window.registerFileDecorationProvider(this);
  }

  private update(): void {
    const roots = this.manager.repositories.map((r) => r.root).join('\0');
    if (roots !== this.roots) {
      this.roots = roots;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.register(), 500);
    }
    const previous = this.changes;
    this.changes = new Map();
    for (const repo of this.manager.repositories) {
      for (const change of repo.status.changes) {
        this.changes.set(path.join(repo.root, change.path), change);
      }
    }
    const affected = new Set([...previous.keys(), ...this.changes.keys()]);
    this.changed.fire([...affected].map((file) => vscode.Uri.file(file)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !vscode.workspace.getConfiguration('git-awesome').get<boolean>(SETTING, true)) {
      return undefined;
    }
    const change = this.changes.get(uri.fsPath);
    if (!change) {
      return undefined;
    }
    // No badge: the built-in Git extension already shows the status letter.
    return { color: new vscode.ThemeColor(statusColor(change)), propagate: !isDeleted(change) };
  }

  dispose(): void {
    this.registration?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
