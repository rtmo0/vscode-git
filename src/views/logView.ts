import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ActionItem, branchActionItems, newTag } from '../actions/branches';
import { commitActionItems, showAllCommitChanges } from '../actions/commits';
import { commitChanges, openDiff, revisionDiff } from '../diff';
import { Commit, NameStatus, Ref } from '../git/parse';
import { layoutGraph, GraphRow } from '../log/graph';
import { Repository, RepositoryManager } from '../repository';
import { showError } from '../ui';

export const LOG_VIEW_ID = 'git-awesome.log';
const PAGE = 1000;

interface Filters {
  /** A ref name; all refs when empty. */
  branch?: string;
  author?: string;
  text?: string;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'selectRepo'; root: string }
  | { type: 'filters'; filters: Filters }
  | { type: 'loadMore' }
  | { type: 'selectCommit'; hash: string }
  | { type: 'openDiff'; hash: string; path: string }
  | { type: 'openAllChanges'; hash: string }
  | { type: 'commitMenu'; hash: string; x: number; y: number }
  | { type: 'refMenu'; name: string; refType: Ref['type']; x: number; y: number }
  | { type: 'runMenu'; id: number }
  | { type: 'newTag' };

/** The Log tab of the Git tool window: branches, commit graph and commit details. */
export class LogView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private repo?: Repository;
  private filters: Filters = {};
  private limit = PAGE;
  private commits: Commit[] = [];
  private refs: Ref[] = [];
  private details?: { hash: string; changes: NameStatus[] };
  private menu: ActionItem[] = [];
  private signature = '';
  private stale = true;
  private timer?: NodeJS.Timeout;
  private loading?: Promise<void>;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepositoryManager,
    private readonly state: vscode.Memento,
    private readonly restoreMessage: (text: string) => void
  ) {
    this.disposables = [
      vscode.window.registerWebviewViewProvider(LOG_VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } }),
      manager.onDidChange(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.reloadIfChanged(), 300);
      }),
      { dispose: () => clearTimeout(this.timer) }
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: FromWebview) => this.receive(message).catch(showError));
    view.onDidChangeVisibility(() => {
      if (view.visible && this.stale) {
        void this.load();
      }
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Shows the log of a branch, as double-clicking it in the branches tree does. */
  async showBranch(branch: string | undefined): Promise<void> {
    this.filters = { branch };
    this.limit = PAGE;
    await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    await this.load();
  }

  refresh(): Promise<void> {
    return this.load();
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async receive(message: FromWebview): Promise<void> {
    const repo = this.currentRepo();
    switch (message.type) {
      case 'ready':
        await this.load();
        break;
      case 'selectRepo':
        this.repo = this.manager.repositories.find((r) => r.root === message.root);
        this.filters = {};
        this.limit = PAGE;
        await this.load();
        break;
      case 'filters':
        this.filters = message.filters;
        this.limit = PAGE;
        await this.load();
        break;
      case 'loadMore':
        this.limit += PAGE;
        await this.load();
        break;
      case 'selectCommit':
        await this.sendDetails(message.hash);
        break;
      case 'openDiff': {
        const commit = this.commits.find((c) => c.hash === message.hash);
        const change = this.details?.hash === message.hash ? this.details.changes.find((c) => c.path === message.path) : undefined;
        if (repo && commit && change) {
          await openDiff(revisionDiff(repo, change, commit.parents[0], commit.hash), { preview: true });
        }
        break;
      }
      case 'openAllChanges': {
        const commit = this.commits.find((c) => c.hash === message.hash);
        if (repo && commit) {
          await showAllCommitChanges(repo, commit);
        }
        break;
      }
      case 'commitMenu': {
        const commit = this.commits.find((c) => c.hash === message.hash);
        if (repo && commit) {
          this.showMenu(commitActionItems(repo, commit, this.restoreMessage), message.x, message.y);
        }
        break;
      }
      case 'refMenu': {
        const ref = this.refs.find((r) => r.name === message.name && r.type === message.refType);
        if (repo && ref) {
          const items = branchActionItems(this.manager, this.state, repo, ref, this.refs);
          this.showMenu([{ label: 'Show in Log', action: () => this.showBranch(ref.name) }, { label: '', kind: vscode.QuickPickItemKind.Separator }, ...items], message.x, message.y);
        }
        break;
      }
      case 'newTag':
        if (repo) {
          await newTag(repo, 'HEAD');
        }
        break;
      case 'runMenu':
        await this.menu[message.id]?.action?.();
        break;
    }
  }

  private showMenu(items: ActionItem[], x: number, y: number): void {
    this.menu = items;
    this.post({
      type: 'menu',
      x,
      y,
      items: items.map((item, id) => (item.kind === vscode.QuickPickItemKind.Separator ? { separator: true } : { id, label: item.label }))
    });
  }

  private currentRepo(): Repository | undefined {
    const repos = this.manager.repositories;
    if (!this.repo || !repos.includes(this.repo)) {
      this.repo = this.manager.find(vscode.window.activeTextEditor?.document.uri) ?? repos[0];
    }
    return this.repo;
  }

  private async refSignature(repo: Repository): Promise<string> {
    const refs = await repo.exec(['for-each-ref', '--format=%(refname) %(objectname)'], { quiet: true }).catch(() => '');
    return `${repo.root}\n${repo.status.branch.oid}\n${repo.status.branch.head}\n${refs}`;
  }

  /** Reloads when HEAD or any ref moved: not on every working tree change. */
  private async reloadIfChanged(): Promise<void> {
    const repo = this.currentRepo();
    if (!repo || (await this.refSignature(repo)) === this.signature) {
      return;
    }
    if (this.view?.visible) {
      await this.load();
    } else {
      this.stale = true;
    }
  }

  private load(): Promise<void> {
    // Serialize loads: filters typed quickly must not render out of order.
    const run = async () => {
      try {
        await this.doLoad();
      } catch (error) {
        void showError(error, 'Cannot load the log');
      }
    };
    this.loading = (this.loading ?? Promise.resolve()).then(run);
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const repo = this.currentRepo();
    if (!this.view) {
      return;
    }
    if (!repo) {
      this.post({ type: 'data', repos: [], commits: [], refs: [] });
      return;
    }
    this.post({ type: 'loading' });
    this.signature = await this.refSignature(repo);
    this.stale = false;

    const { branch, author, text } = this.filters;
    const isHash = !!text && /^[0-9a-f]{4,40}$/i.test(text);
    const textFilter = text && !isHash;
    const args = [
      '--date-order',
      `-n${this.limit + 1}`,
      ...(author ? [`--author=${author}`, '--regexp-ignore-case'] : []),
      ...(textFilter ? ['--regexp-ignore-case', '--fixed-strings', `--grep=${text}`] : []),
      ...(branch ? [branch] : ['--branches', '--remotes', '--tags', 'HEAD']),
      '--'
    ];
    const [commits, refs] = await Promise.all([repo.log(args).catch(() => [] as Commit[]), repo.refs()]);
    const hasMore = commits.length > this.limit;
    this.commits = commits.slice(0, this.limit);
    this.refs = refs;

    // A filtered list is not a connected history: show nodes without lines, like JetBrains IDEs.
    const graph: GraphRow[] =
      author || textFilter ? this.commits.map(() => ({ lane: 0, color: 0, segments: [], width: 1 })) : layoutGraph(this.commits);
    const decorations = new Map<string, { name: string; type: string; current: boolean }[]>();
    for (const ref of refs) {
      decorations.set(ref.hash, [...(decorations.get(ref.hash) ?? []), { name: ref.name, type: ref.type, current: ref.current }]);
    }
    const oid = repo.status.branch.oid;
    if (oid && !repo.head) {
      decorations.set(oid, [{ name: 'HEAD', type: 'head', current: true }, ...(decorations.get(oid) ?? [])]);
    }
    // Annotated tags point at tag objects: resolve them to their commits.
    const tagCommits = await this.peelTags(repo, refs);
    for (const [tag, hash] of tagCommits) {
      const list = decorations.get(hash) ?? [];
      if (!list.some((d) => d.name === tag && d.type === 'tag')) {
        decorations.set(hash, [...list, { name: tag, type: 'tag', current: false }]);
      }
    }

    this.post({
      type: 'data',
      repos: this.manager.repositories.map((r) => ({ root: r.root, name: r.name })),
      repo: repo.root,
      head: oid,
      headName: repo.head,
      jetbrainsColors: vscode.workspace.getConfiguration('git-awesome').get<boolean>('jetbrainsColors', true),
      filters: this.filters,
      select: isHash ? this.commits.find((c) => c.hash.startsWith(text.toLowerCase()))?.hash : undefined,
      hasMore,
      refs: refs.map((r) => ({
        name: r.name,
        type: r.type,
        remote: r.remote,
        current: r.current,
        hash: tagCommits.get(r.name) ?? r.hash,
        upstream: r.upstream,
        ahead: r.ahead,
        behind: r.behind,
        date: r.date
      })),
      commits: this.commits.map((c, i) => ({
        hash: c.hash,
        shortHash: c.shortHash,
        author: c.author,
        date: c.date,
        subject: c.subject,
        parents: c.parents,
        refs: (decorations.get(c.hash) ?? []).filter((d) => d.type !== 'tag' || !tagCommits.has(d.name) || tagCommits.get(d.name) === c.hash),
        graph: graph[i]
      }))
    });
  }

  private async peelTags(repo: Repository, refs: Ref[]): Promise<Map<string, string>> {
    if (!refs.some((r) => r.type === 'tag')) {
      return new Map();
    }
    const output = await repo.exec(['for-each-ref', '--format=%(refname:short)%00%(*objectname)', 'refs/tags'], { quiet: true }).catch(() => '');
    const result = new Map<string, string>();
    for (const line of output.split('\n')) {
      const [name, peeled] = line.split('\0');
      if (name && peeled) {
        result.set(name, peeled);
      }
    }
    return result;
  }

  private async sendDetails(hash: string): Promise<void> {
    const repo = this.currentRepo();
    const commit = this.commits.find((c) => c.hash === hash);
    if (!repo || !commit) {
      return;
    }
    const [changes, body] = await Promise.all([
      commitChanges(repo, commit),
      repo.exec(['show', '-s', '--format=%B%x00%an%x00%ae%x00%at%x00%cn%x00%ct', hash], { quiet: true })
    ]);
    this.details = { hash, changes };
    const [message, author, email, authorDate, committer, commitDate] = body.split('\0');
    this.post({
      type: 'details',
      hash,
      message: message.trim(),
      author,
      email,
      authorDate: Number(authorDate),
      committer,
      commitDate: Number(commitDate),
      changes
    });
    // Which branches contain the commit can take a while in large repositories: send it separately.
    const containing = await repo
      .exec(['branch', '--all', '--contains', hash, '--format=%(refname:short)'], { quiet: true })
      .catch(() => '');
    if (this.details?.hash === hash) {
      this.post({ type: 'containing', hash, branches: containing.split('\n').filter((b) => b && !b.endsWith('/HEAD')) });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('log.css')}">
</head>
<body>
<script nonce="${nonce}" src="${media('log.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
