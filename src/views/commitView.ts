import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { commit, pickFromHistory } from '../actions/commit';
import { Inclusion } from '../changes';
import { RepositoryManager } from '../repository';
import { plural } from '../ui';

export const COMMIT_VIEW_ID = 'git-awesome.commitMessage';
const DRAFT_KEY = 'git-awesome.commitMessageDraft';

type FromWebview =
  | { type: 'ready' }
  | { type: 'message'; text: string }
  | { type: 'amend'; value: boolean }
  | { type: 'commit'; push: boolean }
  | { type: 'history' };

/** The lower half of the Commit tool window: message, Amend, Commit and Commit and Push…. */
export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private message: string;
  private amend = false;
  /** The message that Amend filled in, cleared again when Amend is turned off untouched. */
  private amendMessage?: string;
  private busy = false;
  /** Operations whose message was already prefilled, so a cleared message is not refilled. */
  private readonly prefilled = new Set<string>();
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly manager: RepositoryManager,
    private readonly inclusion: Inclusion,
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento
  ) {
    this.message = workspaceState.get<string>(DRAFT_KEY, '');
    this.disposables = [
      vscode.window.registerWebviewViewProvider(COMMIT_VIEW_ID, this),
      manager.onDidChange(() => {
        this.prefillOperationMessage();
        this.postState();
      }),
      inclusion.onDidChange(() => this.postState())
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message: FromWebview) => void this.receive(message));
    view.onDidDispose(() => (this.view = undefined));
  }

  private async receive(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        void this.view?.webview.postMessage({ type: 'setMessage', text: this.message });
        this.postState();
        break;
      case 'message':
        this.setMessage(message.text, false);
        break;
      case 'amend':
        await this.setAmend(message.value);
        break;
      case 'history': {
        const text = await pickFromHistory(this.globalState);
        if (text !== undefined) {
          this.setMessage(text);
        }
        break;
      }
      case 'commit':
        await this.commit(message.push);
        break;
    }
  }

  async commit(push: boolean): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.postState();
    try {
      if (await commit(this.manager, this.inclusion, this.globalState, { message: this.message, amend: this.amend, push })) {
        this.amend = false;
        this.amendMessage = undefined;
        this.setMessage('');
      }
    } finally {
      this.busy = false;
      this.postState();
    }
  }

  /** Puts a message into the commit box, e.g. after Undo Commit. */
  setDraft(text: string): void {
    this.setMessage(text);
  }

  private setMessage(text: string, toWebview = true): void {
    this.message = text;
    void this.workspaceState.update(DRAFT_KEY, text);
    if (toWebview) {
      void this.view?.webview.postMessage({ type: 'setMessage', text });
    }
  }

  private async setAmend(value: boolean): Promise<void> {
    this.amend = value;
    if (value && !this.message.trim()) {
      // As in JetBrains IDEs, Amend brings back the last commit message for editing.
      const repo = this.manager.repositories.find((r) => this.inclusion.includedChanges(r).length) ?? (await this.manager.pick('Amend Commit'));
      const last = await repo?.exec(['log', '-1', '--format=%B'], { quiet: true }).catch(() => undefined);
      if (last?.trim()) {
        this.amendMessage = last.trim();
        this.setMessage(this.amendMessage);
      }
    } else if (!value && this.amendMessage !== undefined && this.message === this.amendMessage) {
      this.setMessage('');
    }
    if (!value) {
      this.amendMessage = undefined;
    }
    this.postState();
  }

  /** Merge, cherry-pick and revert messages prepared by git, as JetBrains IDEs show them. */
  private prefillOperationMessage(): void {
    for (const repo of this.manager.repositories) {
      const operation = repo.operation;
      if (!operation || operation.kind === 'rebase') {
        continue;
      }
      const key = `${repo.root}:${operation.kind}:${operation.subject}`;
      if (this.prefilled.has(key) || this.message.trim()) {
        continue;
      }
      const text = repo.readGitFile('MERGE_MSG');
      if (text) {
        this.prefilled.add(key);
        this.setMessage(
          text
            .split('\n')
            .filter((line) => !line.startsWith('#'))
            .join('\n')
            .trim()
        );
      }
    }
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const repos = this.manager.repositories;
    let total = 0;
    let included = 0;
    let conflicts = 0;
    for (const repo of repos) {
      const changes = repo.status.changes.filter((c) => c.kind !== 'ignored');
      total += changes.length;
      included += this.inclusion.includedChanges(repo).length;
      conflicts += repo.conflicts.length;
    }
    const summary = conflicts
      ? `Resolve ${plural(conflicts, 'conflict')} before committing`
      : total
        ? `${included} of ${plural(total, 'file')} selected`
        : 'No changes';
    void this.view.webview.postMessage({
      type: 'state',
      amend: this.amend,
      busy: this.busy,
      summary,
      canCommit: !conflicts && (included > 0 || this.amend)
    });
  }

  private html(): string {
    const nonce = randomBytes(16).toString('base64');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; gap: 6px; padding: 6px 12px 10px; box-sizing: border-box; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  textarea { flex: 1; min-height: 52px; resize: none; box-sizing: border-box; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.4; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  label { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
  input[type=checkbox] { margin: 0; accent-color: var(--vscode-checkbox-background); }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; }
  button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-family: inherit; font-size: inherit; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  #summary { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <textarea id="message" placeholder="Commit Message" spellcheck="true" aria-label="Commit message"></textarea>
  <div class="row">
    <label title="Add the selected changes to the last commit and edit its message"><input type="checkbox" id="amend"> Amend</label>
    <a id="history" title="Pick a recent commit message">History…</a>
  </div>
  <div class="buttons">
    <button id="commit" title="Commit (⌘Enter / Ctrl+Enter)">Commit</button>
    <button id="commitPush" class="secondary">Commit and Push…</button>
  </div>
  <div id="summary"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const message = document.getElementById('message');
  const amend = document.getElementById('amend');
  const commit = document.getElementById('commit');
  const commitPush = document.getElementById('commitPush');
  const summary = document.getElementById('summary');
  let timer;
  const flush = () => { clearTimeout(timer); vscode.postMessage({ type: 'message', text: message.value }); };
  message.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 200); });
  message.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!commit.disabled) commit.click(); }
  });
  commit.addEventListener('click', () => { flush(); vscode.postMessage({ type: 'commit', push: false }); });
  commitPush.addEventListener('click', () => { flush(); vscode.postMessage({ type: 'commit', push: true }); });
  amend.addEventListener('change', () => { flush(); vscode.postMessage({ type: 'amend', value: amend.checked }); });
  document.getElementById('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'setMessage') {
      message.value = data.text;
    } else if (data.type === 'state') {
      amend.checked = data.amend;
      commit.textContent = data.amend ? 'Amend Commit' : 'Commit';
      commitPush.textContent = data.amend ? 'Amend Commit and Push…' : 'Commit and Push…';
      commit.disabled = commitPush.disabled = data.busy || !data.canCommit;
      summary.textContent = data.busy ? 'Committing…' : data.summary;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
