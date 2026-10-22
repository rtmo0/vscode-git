import * as vscode from 'vscode';
import { OPERATION_NAMES, RepositoryManager } from './repository';

/** Current branch of the active repository; opens the Git tool window. */
export class BranchStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('git-awesome.branch', vscode.StatusBarAlignment.Left, 99);
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: RepositoryManager) {
    this.item.name = 'Git Awesome Branch';
    this.item.command = 'git-awesome.showLog';
    this.disposables = [this.item, manager.onDidChange(() => this.update()), vscode.window.onDidChangeActiveTextEditor(() => this.update())];
    this.update();
  }

  private update(): void {
    const repo = this.manager.find(vscode.window.activeTextEditor?.document.uri) ?? this.manager.repositories[0];
    if (!repo) {
      this.item.hide();
      return;
    }
    const { ahead, behind } = repo.status.branch;
    const operation = repo.operation;
    this.item.text = operation
      ? `$(git-merge) ${OPERATION_NAMES[operation.kind]}: ${repo.headLabel}`
      : `$(git-branch) ${repo.headLabel}${ahead ? ` ↑${ahead}` : ''}${behind ? ` ↓${behind}` : ''}`;
    this.item.tooltip = `${repo.name}: ${repo.describeOperation() ?? repo.headLabel}\nClick to show Git`;
    this.item.backgroundColor = operation ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
