import * as vscode from 'vscode';
import { FileChange } from './git/status';
import { Repository } from './repository';

export function isUnversioned(change: FileChange): boolean {
  return change.kind === 'untracked';
}

/** New in the working tree compared with HEAD. */
export function isAdded(change: FileChange): boolean {
  return change.kind === 'untracked' || change.index === 'A';
}

export function isDeleted(change: FileChange): boolean {
  return change.kind !== 'conflicted' && (change.index === 'D' || change.workTree === 'D');
}

export function statusLabel(change: FileChange): string {
  if (change.kind === 'untracked') {
    return 'Unversioned';
  }
  if (change.kind === 'conflicted') {
    return 'Merge conflict';
  }
  if (change.kind === 'renamed') {
    return 'Renamed';
  }
  if (change.index === 'A') {
    return 'Added';
  }
  if (isDeleted(change)) {
    return 'Deleted';
  }
  return 'Modified';
}

const STATE_KEY = 'git-awesome.inclusion';

/**
 * Which changes are checked for commit, as in the JetBrains Commit tool window: tracked changes are
 * included unless unchecked, unversioned files are excluded unless checked.
 */
export class Inclusion implements vscode.Disposable {
  private readonly excluded: Set<string>;
  private readonly included: Set<string>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {
    const saved = state.get<{ excluded: string[]; included: string[] }>(STATE_KEY);
    this.excluded = new Set(saved?.excluded);
    this.included = new Set(saved?.included);
  }

  private key(repo: Repository, change: FileChange): string {
    return `${repo.root}\0${change.path}`;
  }

  isIncluded(repo: Repository, change: FileChange): boolean {
    if (change.kind === 'conflicted' || change.kind === 'ignored') {
      return false;
    }
    const key = this.key(repo, change);
    return change.kind === 'untracked' ? this.included.has(key) : !this.excluded.has(key);
  }

  set(repo: Repository, changes: readonly FileChange[], include: boolean): void {
    for (const change of changes) {
      const key = this.key(repo, change);
      const set = change.kind === 'untracked' ? this.included : this.excluded;
      if (include === (change.kind === 'untracked')) {
        set.add(key);
      } else {
        set.delete(key);
      }
    }
    void this.save();
    this.changed.fire();
  }

  includedChanges(repo: Repository): FileChange[] {
    return repo.status.changes.filter((change) => this.isIncluded(repo, change));
  }

  /** Forgets files that are no longer changed, so a file that changes again starts from the default. */
  prune(repos: readonly Repository[]): void {
    const live = new Set(repos.flatMap((repo) => repo.status.changes.map((change) => this.key(repo, change))));
    let removed = false;
    for (const set of [this.excluded, this.included]) {
      for (const key of set) {
        if (!live.has(key)) {
          set.delete(key);
          removed = true;
        }
      }
    }
    if (removed) {
      void this.save();
    }
  }

  private save(): Thenable<void> {
    return this.state.update(STATE_KEY, { excluded: [...this.excluded], included: [...this.included] });
  }

  dispose(): void {
    this.changed.dispose();
  }
}
