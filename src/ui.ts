import * as vscode from 'vscode';
import { GitError } from './git/git';

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof GitError) {
    // git prefixes lines with "error:"/"fatal:" and indents file lists; keep it readable on one line.
    return error.message
      .split('\n')
      .map((line) => line.replace(/^(error|fatal|hint): /, '').trim())
      .filter((line) => line && !line.startsWith('hint'))
      .join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}

export async function showError(error: unknown, prefix?: string): Promise<void> {
  const text = errorMessage(error);
  const choice = await vscode.window.showErrorMessage(prefix ? `${prefix}: ${text}` : text, 'Show Output');
  if (choice) {
    await vscode.commands.executeCommand('git-awesome.showOutput');
  }
}

/** Wraps a command handler so that failures are reported instead of being swallowed. */
export function guarded<A extends unknown[]>(handler: (...args: A) => Promise<unknown> | unknown): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await handler(...args);
    } catch (error) {
      await showError(error);
    }
  };
}

export function withProgress<T>(title: string, task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

export function notify(text: string): void {
  vscode.window.setStatusBarMessage(text, 5000);
}

export async function confirm(message: string, detail: string | undefined, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

export function listPaths(paths: readonly string[], limit = 10): string {
  const shown = paths.slice(0, limit).join('\n');
  return paths.length > limit ? `${shown}\n… and ${paths.length - limit} more` : shown;
}

export function formatDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `Today ${time}`;
  }
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return `Yesterday ${time}`;
  }
  return date.toLocaleDateString();
}

export const BACK = Symbol('back');

export interface PickOptions {
  title: string;
  placeholder?: string;
  back?: boolean;
  matchOnDescription?: boolean;
  onButton?: (item: vscode.QuickPickItem, button: vscode.QuickInputButton) => void;
}

/** A single-selection quick pick that can offer a Back button. */
export function pick<T extends vscode.QuickPickItem>(items: T[], options: PickOptions): Promise<T | typeof BACK | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<T>();
    quickPick.title = options.title;
    quickPick.placeholder = options.placeholder;
    quickPick.matchOnDescription = options.matchOnDescription ?? false;
    quickPick.items = items;
    quickPick.buttons = options.back ? [vscode.QuickInputButtons.Back] : [];
    let result: T | typeof BACK | undefined;
    quickPick.onDidAccept(() => {
      result = quickPick.selectedItems[0];
      quickPick.hide();
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

export function separator(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}
