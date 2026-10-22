import * as vscode from 'vscode';
import { openDiff, workingTreeDiff } from '../diff';
import { ChangesTree, FileNode } from './changesTree';

const DIFF_CONTEXT = 'git-awesome.changesDiff';

/**
 * Reviewing the Changes view file by file, as with the JetBrains diff preview: selecting a file shows its diff
 * while focus stays in the tree, and Previous/Next Changed File step through the diffs in tree order.
 */
export class ChangesReview implements vscode.Disposable {
  private inDiff = false;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly tree: ChangesTree) {
    this.disposables = [
      tree.view.onDidChangeSelection(({ selection }) => {
        const [node] = selection;
        if (selection.length === 1 && node.type === 'file' && node.group !== 'conflicts') {
          void this.preview(node);
        }
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateContext()),
      tree.onDidChangeTreeData(() => this.updateContext())
    ];
  }

  /** Opens the diff in the preview editor without taking focus, so the arrow keys keep moving through the tree. */
  preview(file: FileNode): Promise<void> {
    return openDiff(workingTreeDiff(file.repo, file.change), { preview: true, preserveFocus: true });
  }

  async step(delta: 1 | -1): Promise<void> {
    const files = this.files();
    if (!files.length) {
      return;
    }
    const current = this.activeIndex(files);
    const next = files[current < 0 ? (delta > 0 ? 0 : files.length - 1) : (current + delta + files.length) % files.length];
    await openDiff(workingTreeDiff(next.repo, next.change), { preview: true });
    if (this.tree.view.visible) {
      await this.tree.view.reveal(next, { select: true, focus: false });
    }
  }

  private files(): FileNode[] {
    return this.tree.displayedFiles().filter((f) => f.group !== 'conflicts');
  }

  /** The file whose diff is in the active editor, or -1. */
  private activeIndex(files: FileNode[]): number {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) {
      return -1;
    }
    const original = input.original.toString();
    const modified = input.modified.toString();
    return files.findIndex((f) => {
      const diff = workingTreeDiff(f.repo, f.change);
      return diff.left.toString() === original && diff.right.toString() === modified;
    });
  }

  private updateContext(): void {
    const inDiff = this.activeIndex(this.files()) >= 0;
    if (inDiff !== this.inDiff) {
      this.inDiff = inDiff;
      void vscode.commands.executeCommand('setContext', DIFF_CONTEXT, inDiff);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
