import * as path from 'path';
import * as vscode from 'vscode';
import { conflictDescription } from '../actions/conflicts';
import { Inclusion, statusLabel } from '../changes';
import { FileChange } from '../git/status';
import { Repository, RepositoryManager } from '../repository';
import { plural } from '../ui';

export const VIEW_ID = 'git-awesome.changes';
const GROUP_BY_DIRECTORY = 'changes.groupByDirectory';

type Group = 'conflicts' | 'changes' | 'unversioned';

const GROUP_LABELS: Record<Group, string> = {
  conflicts: 'Merge Conflicts',
  changes: 'Changes',
  unversioned: 'Unversioned Files'
};

export interface FileNode {
  type: 'file';
  repo: Repository;
  group: Group;
  change: FileChange;
}

export type Node =
  | { type: 'repo'; repo: Repository; children: Node[] }
  | { type: 'operation'; repo: Repository }
  | { type: 'group'; repo: Repository; group: Group; files: FileNode[]; children: Node[] }
  | { type: 'dir'; repo: Repository; group: Group; path: string; label: string; files: FileNode[]; children: Node[] }
  | FileNode;

/** Files under the given nodes, without duplicates. */
export function filesOf(nodes: readonly Node[]): FileNode[] {
  const seen = new Set<string>();
  const result: FileNode[] = [];
  const visit = (node: Node) => {
    if (node.type === 'file') {
      const key = `${node.repo.root}\0${node.change.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(node);
      }
    } else if (node.type === 'repo') {
      node.children.forEach(visit);
    } else if (node.type === 'group' || node.type === 'dir') {
      node.files.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return result;
}

function byName(a: FileNode, b: FileNode): number {
  return path.basename(a.change.path).localeCompare(path.basename(b.change.path)) || a.change.path.localeCompare(b.change.path);
}

/** Directory tree with single-child chains compressed into one node (`src/git`), directories before files. */
function directoryTree(files: FileNode[], base: string): Node[] {
  const dirs = new Map<string, FileNode[]>();
  const direct: FileNode[] = [];
  for (const file of files) {
    const rest = file.change.path.slice(base.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      direct.push(file);
    } else {
      const name = rest.slice(0, slash);
      dirs.set(name, [...(dirs.get(name) ?? []), file]);
    }
  }
  const nodes: Node[] = [];
  for (const [name, list] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
    let label = name;
    let dirPath = `${base}${name}/`;
    for (;;) {
      const rests = list.map((f) => f.change.path.slice(dirPath.length));
      const next = rests[0].split('/')[0];
      if (!rests.every((rest) => rest.includes('/') && rest.split('/')[0] === next)) {
        break;
      }
      label += `/${next}`;
      dirPath += `${next}/`;
    }
    nodes.push({ type: 'dir', repo: list[0].repo, group: list[0].group, path: dirPath, label, files: list, children: directoryTree(list, dirPath) });
  }
  return [...nodes, ...direct.sort(byName)];
}

export class ChangesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly view: vscode.TreeView<Node>;
  private roots: Node[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly manager: RepositoryManager,
    private readonly inclusion: Inclusion
  ) {
    this.view = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this,
      canSelectMany: true,
      showCollapseAll: true,
      manageCheckboxStateManually: true
    });
    this.disposables = [
      this.view,
      this.changed,
      this.view.onDidChangeCheckboxState((event) => {
        for (const [node, state] of event.items) {
          for (const repo of new Set(filesOf([node]).map((f) => f.repo))) {
            const changes = filesOf([node]).filter((f) => f.repo === repo).map((f) => f.change);
            inclusion.set(repo, changes, state === vscode.TreeItemCheckboxState.Checked);
          }
        }
      }),
      manager.onDidChange(() => this.rebuild()),
      inclusion.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`git-awesome.${GROUP_BY_DIRECTORY}`)) {
          this.rebuild();
        }
      })
    ];
    this.rebuild();
  }

  private get groupByDirectory(): boolean {
    return vscode.workspace.getConfiguration('git-awesome').get<boolean>(GROUP_BY_DIRECTORY, true);
  }

  private repoNodes(repo: Repository): Node[] {
    const nodes: Node[] = repo.operation ? [{ type: 'operation', repo }] : [];
    const groups: Record<Group, FileNode[]> = { conflicts: [], changes: [], unversioned: [] };
    for (const change of repo.status.changes) {
      if (change.kind !== 'ignored') {
        const group: Group = change.kind === 'conflicted' ? 'conflicts' : change.kind === 'untracked' ? 'unversioned' : 'changes';
        groups[group].push({ type: 'file', repo, group, change });
      }
    }
    for (const group of ['conflicts', 'changes', 'unversioned'] as const) {
      const files = groups[group];
      if (files.length) {
        const children = this.groupByDirectory ? directoryTree(files, '') : [...files].sort((a, b) => a.change.path.localeCompare(b.change.path));
        nodes.push({ type: 'group', repo, group, files, children });
      }
    }
    return nodes;
  }

  private rebuild(): void {
    const repos = this.manager.repositories;
    this.inclusion.prune(repos);
    this.roots =
      repos.length === 1 ? this.repoNodes(repos[0]) : repos.map((repo) => ({ type: 'repo' as const, repo, children: this.repoNodes(repo) }));

    const single = repos.length === 1 ? repos[0] : undefined;
    const { ahead, behind } = single?.status.branch ?? { ahead: 0, behind: 0 };
    this.view.description = single ? [single.headLabel, ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ') : undefined;
    this.view.message = repos.length && !repos.some((r) => r.status.changes.length || r.operation) ? 'No changes' : undefined;
    void vscode.commands.executeCommand('setContext', 'git-awesome.hasRepositories', repos.length > 0);
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.roots;
    }
    return 'children' in node ? node.children : [];
  }

  private checkbox(files: FileNode[]): vscode.TreeItemCheckboxState {
    return files.every((f) => this.inclusion.isIncluded(f.repo, f.change))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const id = (...parts: string[]) => [node.repo.root, ...parts].join('|');
    switch (node.type) {
      case 'repo': {
        const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = id('repo');
        item.description = node.repo.headLabel;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.tooltip = node.repo.root;
        item.contextValue = 'repo';
        return item;
      }
      case 'operation': {
        const item = new vscode.TreeItem(node.repo.describeOperation() ?? '', vscode.TreeItemCollapsibleState.None);
        item.id = id('operation');
        item.iconPath = new vscode.ThemeIcon(node.repo.operation?.kind === 'rebase' ? 'git-pull-request' : 'git-merge', new vscode.ThemeColor('notificationsWarningIcon.foreground'));
        item.description = node.repo.conflicts.length ? plural(node.repo.conflicts.length, 'conflict') : 'ready to continue';
        item.contextValue = `operation-${node.repo.operation?.kind}`;
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(GROUP_LABELS[node.group], vscode.TreeItemCollapsibleState.Expanded);
        item.id = id('group', node.group);
        item.description = plural(node.files.length, 'file');
        item.contextValue = `group-${node.group}`;
        if (node.group === 'conflicts') {
          item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
          item.tooltip = 'Click Resolve… to open the Conflicts dialog';
        } else {
          item.checkboxState = this.checkbox(node.files);
        }
        return item;
      }
      case 'dir': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = id('dir', node.group, node.path);
        item.resourceUri = node.repo.fileUri(node.path.slice(0, -1));
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = plural(node.files.length, 'file');
        item.contextValue = `dir-${node.group}`;
        if (node.group !== 'conflicts') {
          item.checkboxState = this.checkbox(node.files);
        }
        return item;
      }
      case 'file': {
        const { change, repo, group } = node;
        const item = new vscode.TreeItem(path.basename(change.path), vscode.TreeItemCollapsibleState.None);
        item.id = id('file', group, change.path);
        item.resourceUri = repo.fileUri(change.path);
        item.iconPath = vscode.ThemeIcon.File;
        const dir = path.dirname(change.path);
        const location = this.groupByDirectory || dir === '.' ? '' : dir;
        const moved = change.origPath ? `moved from ${change.origPath}` : '';
        const status = group === 'conflicts' ? conflictDescription(repo, change) : statusLabel(change);
        item.description = [location, moved].filter(Boolean).join('  ');
        item.tooltip = `${change.path}\n${status}`;
        item.contextValue = `file-${group}`;
        item.command = { command: 'git-awesome.showDiff', title: 'Show Diff', arguments: [node] };
        if (group !== 'conflicts') {
          item.checkboxState = this.checkbox([node]);
        }
        return item;
      }
    }
  }

  getParent(): undefined {
    return undefined;
  }

  /** Nodes a command applies to: the clicked node with the selection it belongs to, or the selection. */
  targets(node?: Node, selected?: readonly Node[]): Node[] {
    if (node) {
      return selected?.length && selected.includes(node) ? [...selected] : [node];
    }
    return [...this.view.selection];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
