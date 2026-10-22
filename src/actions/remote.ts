import * as vscode from 'vscode';
import { showCommitChanges } from '../diff';
import { Commit } from '../git/parse';
import { FORCE_WITH_LEASE, isPushRejected } from '../gitApi';
import { OPERATION_NAMES, Repository, RepositoryManager } from '../repository';
import { BACK, errorMessage, formatDate, notify, pick, plural, separator, showError, withProgress } from '../ui';
import { runWithConflicts } from './conflicts';

export type UpdateMethod = 'merge' | 'rebase';

const UPDATE_METHOD_KEY = 'git-awesome.updateMethod';

export async function fetch(manager: RepositoryManager): Promise<void> {
  const repos = manager.repositories;
  const results = await withProgress('Fetching…', () => Promise.allSettled(repos.map((repo) => repo.api.fetch({ all: true }))));
  await manager.refreshAll();
  const failed = results.flatMap((result, i) => (result.status === 'rejected' ? [`${repos[i].name}: ${errorMessage(result.reason)}`] : []));
  if (failed.length) {
    void showError(failed.join('; '), 'Fetch failed');
  } else {
    notify('$(check) Fetch successful');
  }
}

async function pickUpdateMethod(state: vscode.Memento): Promise<UpdateMethod | undefined> {
  const last = state.get<UpdateMethod>(UPDATE_METHOD_KEY, 'merge');
  const items = [
    { label: 'Merge', detail: 'Merge incoming changes into the current branch', method: 'merge' as const },
    { label: 'Rebase', detail: 'Rebase the current branch on top of incoming changes', method: 'rebase' as const }
  ].sort((a) => (a.method === last ? -1 : 1));
  const choice = await pick(items, { title: 'Update Project', placeholder: 'Uncommitted changes are stashed and restored automatically' });
  if (!choice || choice === BACK) {
    return undefined;
  }
  await state.update(UPDATE_METHOD_KEY, choice.method);
  return choice.method;
}

interface UpdateResult {
  commits: number;
  files: number;
  /** Stopped on conflicts. */
  conflicts?: boolean;
}

/** Fetches and integrates `target` (default: the upstream) into the current branch. */
async function updateRepository(repo: Repository, method: UpdateMethod, target?: { remote: string; branch: string }): Promise<UpdateResult | string> {
  if (repo.operation) {
    return `${repo.name}: finish the ${OPERATION_NAMES[repo.operation.kind].toLowerCase()} in progress first`;
  }
  if (!repo.head) {
    return `${repo.name}: HEAD is detached`;
  }
  const upstream = target ?? (await repo.upstreamOf(repo.head));
  if (!upstream) {
    return `${repo.name}: no tracked branch configured for '${repo.head}'`;
  }
  await repo.api.fetch({ remote: upstream.remote, ref: upstream.branch });
  const incoming = `${upstream.remote}/${upstream.branch}`;
  const [commits, files] = await Promise.all([
    repo.exec(['rev-list', '--count', `HEAD..${incoming}`], { quiet: true }),
    repo.exec(['diff', '--name-only', '-z', `HEAD...${incoming}`], { quiet: true })
  ]);
  const result = { commits: Number(commits.trim()), files: files.split('\0').filter(Boolean).length };
  if (!result.commits) {
    return result;
  }
  const args = method === 'rebase' ? ['rebase', '--autostash', incoming] : ['merge', '--autostash', '--no-edit', incoming];
  const output = await runWithConflicts(repo, args);
  return output === undefined ? { ...result, conflicts: true } : result;
}

/** Update Project: fetch, then merge or rebase every repository onto its tracked branch. */
export async function updateProject(manager: RepositoryManager, state: vscode.Memento, repos = manager.repositories): Promise<void> {
  if (!repos.length) {
    return;
  }
  const method = await pickUpdateMethod(state);
  if (!method) {
    return;
  }
  const skipped: string[] = [];
  let commits = 0;
  let files = 0;
  await withProgress('Updating project…', async (progress) => {
    for (const repo of repos) {
      progress.report({ message: repo.name });
      const result = await updateRepository(repo, method);
      if (typeof result === 'string') {
        skipped.push(result);
        continue;
      }
      commits += result.commits;
      files += result.files;
      if (result.conflicts) {
        return;
      }
    }
  });
  if (skipped.length) {
    void vscode.window.showWarningMessage(`Some repositories were not updated: ${skipped.join('; ')}`);
  }
  if (commits) {
    void vscode.window.showInformationMessage(`Project updated: ${plural(files, 'file')} in ${plural(commits, 'commit')}.`);
  } else if (!skipped.length) {
    notify('$(check) All files are up-to-date');
  }
}

interface PushTarget {
  repo: Repository;
  head: string;
  remote: string;
  remoteBranch: string;
  /** No upstream yet: push with --set-upstream. */
  isNew: boolean;
  commits: Commit[];
}

async function pushTarget(repo: Repository): Promise<PushTarget | string> {
  const head = repo.head;
  if (!head) {
    return `${repo.name}: HEAD is detached`;
  }
  const upstream = await repo.upstreamOf(head);
  if (upstream) {
    const commits = await repo
      .log([`${upstream.remote}/${upstream.branch}..HEAD`, '-n', '1000'])
      .catch(() => repo.log(['HEAD', '--not', '--remotes', '-n', '1000']));
    return { repo, head, remote: upstream.remote, remoteBranch: upstream.branch, isNew: false, commits };
  }
  const remotes = await repo.remotes();
  const remote = (await repo.config('remote.pushDefault')) ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (!remote) {
    return `${repo.name}: no remotes configured`;
  }
  return { repo, head, remote, remoteBranch: head, isNew: true, commits: await repo.log(['HEAD', '--not', '--remotes', '-n', '1000']) };
}

async function pushOne(target: PushTarget, force: boolean, state: vscode.Memento): Promise<boolean> {
  const { repo, head, remote, remoteBranch, isNew } = target;
  const refspec = head === remoteBranch ? head : `${head}:${remoteBranch}`;
  try {
    await repo.api.push(remote, refspec, isNew, force ? FORCE_WITH_LEASE : undefined);
    return true;
  } catch (error) {
    if (force || !isPushRejected(error)) {
      throw error;
    }
    const last = state.get<UpdateMethod>(UPDATE_METHOD_KEY, 'merge');
    const buttons = last === 'rebase' ? ['Rebase', 'Merge'] : ['Merge', 'Rebase'];
    const choice = await vscode.window.showWarningMessage(
      `Push of '${head}' to '${remote}/${remoteBranch}' was rejected.`,
      { modal: true, detail: 'The remote branch has commits that are not in your branch. Update your branch and push again.' },
      ...buttons
    );
    if (!choice) {
      return false;
    }
    const method: UpdateMethod = choice === 'Rebase' ? 'rebase' : 'merge';
    await state.update(UPDATE_METHOD_KEY, method);
    const result = await updateRepository(repo, method, { remote, branch: remoteBranch });
    if (typeof result === 'string') {
      throw new Error(result);
    }
    if (result.conflicts) {
      return false;
    }
    await repo.api.push(remote, refspec, isNew);
    return true;
  }
}

type PushItem = vscode.QuickPickItem & { force?: boolean; tags?: boolean; commit?: Commit; repo?: Repository };

/** The Push dialog: outgoing commits per repository; selecting a commit shows its files. */
export async function push(manager: RepositoryManager, state: vscode.Memento, repos = manager.repositories): Promise<void> {
  const resolved = await Promise.all(repos.map(pushTarget));
  const targets = resolved.filter((t): t is PushTarget => typeof t !== 'string' && (t.isNew || t.commits.length > 0));
  const problems = resolved.filter((t): t is string => typeof t === 'string');
  if (!targets.length) {
    void vscode.window.showInformationMessage(problems.length ? `Nothing to push. ${problems.join('; ')}` : 'Nothing to push.');
    return;
  }
  const total = targets.reduce((sum, t) => sum + t.commits.length, 0);
  const destination = targets.length === 1 ? `${targets[0].remote}/${targets[0].remoteBranch}${targets[0].isNew ? ' (new)' : ''}` : `${targets.length} repositories`;
  const items: PushItem[] = [
    { label: '$(arrow-up) Push', description: `${plural(total, 'commit')} → ${destination}` },
    { label: '$(warning) Force Push', description: '--force-with-lease', force: true },
    { label: '$(tag) Push Tags', description: `all local tags to ${[...new Set(targets.map((t) => t.remote))].join(', ')}`, tags: true }
  ];
  for (const target of targets) {
    items.push(separator(`${targets.length > 1 ? `${target.repo.name}: ` : ''}${target.head} → ${target.remote}/${target.remoteBranch}${target.isNew ? ' (new)' : ''}`));
    items.push(
      ...target.commits.map((commit) => ({
        label: commit.subject,
        description: `${commit.shortHash} · ${commit.author} · ${formatDate(commit.date)}`,
        commit,
        repo: target.repo
      }))
    );
  }

  let force = false;
  for (;;) {
    const choice = await pick(items, { title: 'Push Commits', placeholder: 'Select a commit to see its changes', matchOnDescription: true });
    if (!choice || choice === BACK) {
      return;
    }
    if (choice.commit && choice.repo) {
      if ((await showCommitChanges(choice.repo, choice.commit, true)) === BACK) {
        continue;
      }
      return;
    }
    if (choice.tags) {
      await pushTags(targets);
      return;
    }
    force = choice.force === true;
    if (
      force &&
      !(await vscode.window.showWarningMessage(
        'Force push?',
        { modal: true, detail: 'Remote commits that are not in your branch are overwritten, unless someone pushed after your last fetch (--force-with-lease).' },
        'Force Push'
      ))
    ) {
      continue;
    }
    break;
  }

  await withProgress('Pushing…', async (progress) => {
    for (const target of targets) {
      progress.report({ message: target.repo.name });
      try {
        if (await pushOne(target, force, state)) {
          notify(`$(check) Pushed ${plural(target.commits.length, 'commit')} to ${target.remote}/${target.remoteBranch}`);
        }
      } catch (error) {
        void showError(error, `Push of ${target.repo.name} failed`);
      }
      await target.repo.refresh();
    }
  });
}

async function pushTags(targets: PushTarget[]): Promise<void> {
  await withProgress('Pushing tags…', async () => {
    for (const { repo, remote } of targets) {
      try {
        await repo.exec(['push', remote, '--tags']);
        notify(`$(check) Pushed tags to ${remote}`);
      } catch (error) {
        void showError(error, `Push of tags from ${repo.name} failed`);
      }
    }
  });
}
