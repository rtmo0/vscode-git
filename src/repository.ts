import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runGit } from './git/git';
import { Commit, LOG_FORMAT, parseLog, parseRecentCheckouts, parseRefs, Ref, REF_FORMAT } from './git/parse';
import { FileChange, parseStatus, Status } from './git/status';
import { ApiRepository, GitApi } from './gitApi';

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface Operation {
  kind: OperationKind;
  /** The merged branch, the rebased branch or the picked commit, for display. */
  subject?: string;
  /** Rebase target, short hash. */
  onto?: string;
}

export const OPERATION_NAMES: Record<OperationKind, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-Pick',
  revert: 'Revert'
};

export interface ExecOptions {
  input?: string;
  /** Log at trace level: reads that run on every refresh. */
  quiet?: boolean;
  env?: Record<string, string>;
}

export class Repository implements vscode.Disposable {
  status: Status = { branch: { ahead: 0, behind: 0 }, changes: [] };
  operation?: Operation;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private refreshing?: Promise<void>;
  private queued?: Promise<void>;

  constructor(
    readonly root: string,
    readonly gitDir: string,
    readonly api: ApiRepository,
    private readonly gitPath: string,
    private readonly output: vscode.LogOutputChannel
  ) {}

  get name(): string {
    return path.basename(this.root);
  }

  /** Current branch; undefined when HEAD is detached. */
  get head(): string | undefined {
    return this.status.branch.head;
  }

  /** Current branch, or `HEAD (abc1234)` when detached; used in `into '…'` labels. */
  get headLabel(): string {
    const { head, oid } = this.status.branch;
    return head ?? (oid ? `HEAD (${oid.slice(0, 7)})` : 'HEAD');
  }

  /** Revision for git arguments: the branch name or `HEAD`. */
  get headRef(): string {
    return this.status.branch.head ?? 'HEAD';
  }

  get conflicts(): FileChange[] {
    return this.status.changes.filter((change) => change.kind === 'conflicted');
  }

  fileUri(relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, relativePath));
  }

  async exec(args: string[], options: ExecOptions = {}): Promise<string> {
    const started = Date.now();
    try {
      const output = await runGit(this.gitPath, args, { cwd: this.root, input: options.input, env: options.env });
      const line = `[${this.name}] git ${args.join(' ')} (${Date.now() - started} ms)`;
      if (options.quiet) {
        this.output.trace(line);
      } else {
        this.output.info(line);
      }
      return output;
    } catch (error) {
      this.output.error(`[${this.name}] git ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** Reloads status; a call made while a refresh is running schedules exactly one more, so the result is never stale. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.load().finally(() => (this.refreshing = undefined));
      return this.refreshing;
    }
    this.queued ??= this.refreshing.then(() => {
      this.queued = undefined;
      return this.refresh();
    });
    return this.queued;
  }

  private async load(): Promise<void> {
    try {
      const output = await this.exec(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], {
        quiet: true,
        env: { GIT_OPTIONAL_LOCKS: '0' }
      });
      this.status = parseStatus(output);
      this.operation = this.readOperation();
    } catch {
      // Logged by exec; keep the previous state.
    }
    this.changed.fire();
  }

  readGitFile(name: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.gitDir, name), 'utf8').trim();
    } catch {
      return undefined;
    }
  }

  private readOperation(): Operation | undefined {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      if (fs.existsSync(path.join(this.gitDir, dir))) {
        return {
          kind: 'rebase',
          subject: this.readGitFile(`${dir}/head-name`)?.replace(/^refs\/heads\//, ''),
          onto: this.readGitFile(`${dir}/onto`)?.slice(0, 7)
        };
      }
    }
    if (fs.existsSync(path.join(this.gitDir, 'MERGE_HEAD'))) {
      const message = this.readGitFile('MERGE_MSG') ?? '';
      const subject = /^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/.exec(message)?.[1];
      return { kind: 'merge', subject };
    }
    const picked = this.readGitFile('CHERRY_PICK_HEAD');
    if (picked) {
      return { kind: 'cherry-pick', subject: picked.slice(0, 7) };
    }
    const reverted = this.readGitFile('REVERT_HEAD');
    if (reverted) {
      return { kind: 'revert', subject: reverted.slice(0, 7) };
    }
    return undefined;
  }

  describeOperation(): string | undefined {
    const operation = this.operation;
    switch (operation?.kind) {
      case 'merge':
        return `Merging ${operation.subject ? `'${operation.subject}'` : 'changes'} into '${this.headLabel}'`;
      case 'rebase':
        return `Rebasing '${operation.subject ?? 'HEAD'}'${operation.onto ? ` onto ${operation.onto}` : ''}`;
      case 'cherry-pick':
        return `Cherry-picking ${operation.subject}`;
      case 'revert':
        return `Reverting ${operation.subject}`;
      default:
        return undefined;
    }
  }

  async remotes(): Promise<string[]> {
    return (await this.exec(['remote'], { quiet: true })).split('\n').filter(Boolean);
  }

  async refs(): Promise<Ref[]> {
    const [remotes, output] = await Promise.all([
      this.remotes(),
      this.exec(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true })
    ]);
    return parseRefs(output, remotes);
  }

  async log(args: string[]): Promise<Commit[]> {
    return parseLog(await this.exec(['log', `--format=${LOG_FORMAT}`, ...args], { quiet: true }));
  }

  async recentBranches(): Promise<string[]> {
    try {
      return parseRecentCheckouts(await this.exec(['reflog', '--format=%gs', '-n', '300', 'HEAD'], { quiet: true }));
    } catch {
      return []; // Unborn branch: no reflog yet.
    }
  }

  async config(key: string): Promise<string | undefined> {
    try {
      return (await this.exec(['config', '--get', key], { quiet: true })).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** The configured upstream of a local branch, independent of whether the remote-tracking ref exists. */
  async upstreamOf(branch: string): Promise<{ remote: string; branch: string } | undefined> {
    const [remote, merge] = await Promise.all([this.config(`branch.${branch}.remote`), this.config(`branch.${branch}.merge`)]);
    return remote && merge && remote !== '.' ? { remote, branch: merge.replace(/^refs\/heads\//, '') } : undefined;
  }

  async revParse(revision: string): Promise<string | undefined> {
    try {
      return (await this.exec(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { quiet: true })).trim();
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export class RepositoryManager implements vscode.Disposable {
  private readonly repos = new Map<ApiRepository, { repo: Repository; disposables: vscode.Disposable[] }>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly api: GitApi,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.disposables = [
      this.changed,
      api.onDidOpenRepository((repo) => void this.open(repo)),
      api.onDidCloseRepository((repo) => this.close(repo))
    ];
    for (const repo of api.repositories) {
      void this.open(repo);
    }
  }

  get repositories(): Repository[] {
    return [...this.repos.values()].map((entry) => entry.repo).sort((a, b) => a.root.localeCompare(b.root));
  }

  private async open(apiRepo: ApiRepository): Promise<void> {
    const root = apiRepo.rootUri.fsPath;
    let gitDir: string;
    try {
      gitDir = (await runGit(this.api.git.path, ['rev-parse', '--absolute-git-dir'], { cwd: root })).trim();
    } catch (error) {
      this.log.error(`Cannot open repository ${root}: ${String(error)}`);
      return;
    }
    if (this.repos.has(apiRepo)) {
      return;
    }
    const repo = new Repository(root, gitDir, apiRepo, this.api.git.path, this.log);
    let timer: NodeJS.Timeout | undefined;
    this.repos.set(apiRepo, {
      repo,
      disposables: [
        // The built-in extension watches the worktree and .git; follow its change events.
        apiRepo.state.onDidChange(() => {
          clearTimeout(timer);
          timer = setTimeout(() => void repo.refresh(), 150);
        }),
        repo.onDidChange(() => this.changed.fire()),
        { dispose: () => clearTimeout(timer) },
        repo
      ]
    });
    await repo.refresh();
  }

  private close(apiRepo: ApiRepository): void {
    const entry = this.repos.get(apiRepo);
    if (entry) {
      this.repos.delete(apiRepo);
      entry.disposables.forEach((d) => d.dispose());
      this.changed.fire();
    }
  }

  /** The deepest repository containing `uri`. */
  find(uri: vscode.Uri | undefined): Repository | undefined {
    if (uri?.scheme !== 'file') {
      return undefined;
    }
    return this.repositories
      .filter((repo) => uri.fsPath === repo.root || uri.fsPath.startsWith(repo.root + path.sep))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  /** The repository of the active editor, the only repository, or one chosen by the user. */
  async pick(title: string, filter: (repo: Repository) => boolean = () => true): Promise<Repository | undefined> {
    const candidates = this.repositories.filter(filter);
    if (candidates.length <= 1) {
      return candidates[0];
    }
    const active = this.find(vscode.window.activeTextEditor?.document.uri);
    if (active && candidates.includes(active)) {
      return active;
    }
    const choice = await vscode.window.showQuickPick(
      candidates.map((repo) => ({ label: repo.name, description: repo.headLabel, detail: repo.root, repo })),
      { title, placeHolder: 'Select a repository' }
    );
    return choice?.repo;
  }

  refreshAll(): Promise<void> {
    return Promise.all(this.repositories.map((repo) => repo.refresh())).then(() => undefined);
  }

  dispose(): void {
    for (const entry of this.repos.values()) {
      entry.disposables.forEach((d) => d.dispose());
    }
    this.repos.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
