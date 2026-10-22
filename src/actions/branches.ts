import * as vscode from 'vscode';
import { showCommitChanges, showRefChanges } from '../diff';
import { GitError } from '../git/git';
import { Commit, Ref } from '../git/parse';
import { OPERATION_NAMES, Repository, RepositoryManager } from '../repository';
import { BACK, confirm, formatDate, listPaths, notify, pick, separator, withProgress } from '../ui';
import { abortOperation, continueOperation, runWithConflicts, showConflicts, skipCommit } from './conflicts';
import { fetch, push, updateProject } from './remote';

type Item = vscode.QuickPickItem & { action?: () => Thenable<unknown>; ref?: Ref };


const FAVORITES = ['main', 'master', 'develop'];

function trackingDescription(ref: Ref): string {
  if (!ref.upstream) {
    return '';
  }
  if (ref.upstreamGone) {
    return `${ref.upstream} (gone)`;
  }
  return [ref.upstream, ref.ahead ? `↑${ref.ahead}` : '', ref.behind ? `↓${ref.behind}` : ''].filter(Boolean).join(' ');
}

function branchItem(ref: Ref): Item {
  return {
    label: `${ref.type === 'tag' ? '$(tag)' : ref.current ? '$(check)' : FAVORITES.includes(ref.name) ? '$(star-full)' : '$(git-branch)'} ${ref.name}`,
    description: ref.type === 'head' ? trackingDescription(ref) : '',
    ref
  };
}

/** The Git Branches popup. */
export async function showBranches(manager: RepositoryManager, state: vscode.Memento, repoArg?: Repository): Promise<void> {
  const repo = repoArg ?? (await manager.pick('Git Branches'));
  if (!repo) {
    return;
  }
  for (;;) {
    const [refs, recent] = await Promise.all([repo.refs(), repo.recentBranches()]);
    const locals = refs
      .filter((r) => r.type === 'head')
      .sort((a, b) => Number(b.current) - Number(a.current) || Number(FAVORITES.includes(b.name)) - Number(FAVORITES.includes(a.name)) || a.name.localeCompare(b.name));
    const remotes = refs.filter((r) => r.type === 'remote').sort((a, b) => a.name.localeCompare(b.name));
    const recentRefs = recent
      .map((name) => locals.find((r) => r.name === name && !r.current))
      .filter((r): r is Ref => r !== undefined)
      .slice(0, 5);

    const items: Item[] = [];
    const operation = repo.operation;
    if (operation) {
      const name = OPERATION_NAMES[operation.kind];
      items.push(separator(repo.describeOperation() ?? name));
      if (repo.conflicts.length) {
        items.push({ label: '$(warning) Resolve Conflicts…', action: () => showConflicts(repo) });
      }
      items.push({ label: `$(debug-continue) Continue ${name}`, action: () => continueOperation(repo) });
      if (operation.kind === 'rebase') {
        items.push({ label: '$(debug-step-over) Skip Commit', action: () => skipCommit(repo) });
      }
      items.push({ label: `$(debug-stop) Abort ${name}`, action: () => abortOperation(repo) });
    }
    items.push(
      separator('Actions'),
      { label: '$(arrow-down) Update Project…', action: () => updateProject(manager, state) },
      { label: '$(check) Commit…', action: () => vscode.commands.executeCommand('git-awesome.commitMessage.focus') },
      { label: '$(arrow-up) Push…', action: () => push(manager, state, [repo]) },
      { label: '$(add) New Branch…', action: () => newBranch(repo) },
      { label: '$(tag) New Tag…', action: () => newTag(repo, 'HEAD') },
      { label: '$(tag) Checkout Tag or Revision…', action: () => checkoutRevision(repo) },
      { label: '$(sync) Fetch', action: () => fetch(manager) },
      { label: '$(git-commit) Show Git Log', action: () => vscode.commands.executeCommand('git-awesome.showLog') }
    );
    if (recentRefs.length) {
      items.push(separator('Recent'), ...recentRefs.map(branchItem));
    }
    items.push(separator('Local'), ...locals.map(branchItem));
    if (!locals.some((r) => r.current)) {
      items.splice(items.length - locals.length, 0, { label: `$(check) ${repo.headLabel}`, description: 'detached' });
    }
    if (remotes.length) {
      items.push(separator('Remote'), ...remotes.map(branchItem));
    }
    const tags = refs.filter((r) => r.type === 'tag').sort((a, b) => b.date - a.date);
    if (tags.length) {
      items.push(separator('Tags'), ...tags.map(branchItem));
    }

    const choice = await pick(items, {
      title: `Git Branches — ${repo.name}`,
      placeholder: 'Search for branches and actions',
      matchOnDescription: true
    });
    if (!choice || choice === BACK) {
      return;
    }
    if (choice.action) {
      await choice.action();
      return;
    }
    if (choice.ref && (await branchActions(manager, state, repo, choice.ref, refs)) !== BACK) {
      return;
    }
  }
}

export type ActionItem = vscode.QuickPickItem & { action?: () => Thenable<unknown> };

/** Actions for one branch, shared by the Branches popup and the Log's branch context menu. */
export function branchActionItems(manager: RepositoryManager, state: vscode.Memento, repo: Repository, ref: Ref, refs: Ref[]): ActionItem[] {
  const current = repo.headLabel;
  const name = ref.name;
  const items: ActionItem[] = [];
  if (ref.type === 'tag') {
    return [
      { label: 'Checkout', action: () => smartCheckout(repo, [name], name) },
      { label: `New Branch from '${name}'…`, action: () => newBranch(repo, name) },
      separator(''),
      { label: `Compare with '${current}'`, action: () => compareWithCurrent(repo, ref) },
      { label: 'Show Diff with Working Tree', action: () => showRefChanges(repo, `${name} ↔ Local`, name, undefined) },
      separator(''),
      { label: `Merge '${name}' into '${current}'`, action: () => mergeInto(repo, name) },
      separator(''),
      { label: 'Push Tag…', action: () => pushTag(repo, name) },
      { label: 'Delete Tag', action: () => deleteTag(repo, name) }
    ];
  }
  if (ref.type === 'head' && ref.current) {
    items.push(
      { label: `New Branch from '${name}'…`, action: () => newBranch(repo, name) },
      { label: 'Update', action: () => updateProject(manager, state, [repo]) },
      { label: 'Push…', action: () => push(manager, state, [repo]) },
      { label: 'Rename…', action: () => renameBranch(repo, ref) }
    );
    return items;
  }
  items.push(
    { label: 'Checkout', action: () => checkout(repo, ref, refs) },
    { label: `New Branch from '${name}'…`, action: () => newBranch(repo, name) }
  );
  if (repo.head) {
    items.push({ label: `Checkout and Rebase onto '${current}'`, action: () => checkoutAndRebase(repo, ref, refs) });
  }
  items.push(
    separator(''),
    { label: `Compare with '${current}'`, action: () => compareWithCurrent(repo, ref) },
    { label: 'Show Diff with Working Tree', action: () => showRefChanges(repo, `${name} ↔ Local`, name, undefined) },
    separator(''),
    { label: `Rebase '${current}' onto '${name}'`, action: () => rebaseOnto(repo, name) },
    { label: `Merge '${name}' into '${current}'`, action: () => mergeInto(repo, name) }
  );
  if (ref.type === 'remote') {
    items.push(
      { label: `Pull into '${current}' Using Merge`, action: () => pullInto(repo, ref, 'merge') },
      { label: `Pull into '${current}' Using Rebase`, action: () => pullInto(repo, ref, 'rebase') }
    );
  }
  items.push(separator(''));
  if (ref.type === 'head') {
    items.push({ label: 'Rename…', action: () => renameBranch(repo, ref) });
  }
  items.push({ label: 'Delete', action: () => deleteBranch(repo, ref) });
  return items;
}

async function branchActions(manager: RepositoryManager, state: vscode.Memento, repo: Repository, ref: Ref, refs: Ref[]): Promise<typeof BACK | void> {
  const choice = await pick(branchActionItems(manager, state, repo, ref, refs), { title: `${ref.type === 'tag' ? 'Tag' : 'Branch'} '${ref.name}'`, back: true });
  if (choice === BACK) {
    return BACK;
  }
  await choice?.action?.();
}

async function pushTag(repo: Repository, name: string): Promise<void> {
  const remotes = await repo.remotes();
  const remote = remotes.length > 1 ? await vscode.window.showQuickPick(remotes, { title: `Push Tag '${name}' to` }) : remotes[0];
  if (remote) {
    await withProgress(`Pushing tag ${name}…`, () => repo.exec(['push', remote, `refs/tags/${name}`]));
    notify(`$(check) Pushed tag ${name} to ${remote}`);
  }
}

async function deleteTag(repo: Repository, name: string): Promise<void> {
  if (await confirm(`Delete tag '${name}'?`, 'The tag is deleted locally; remote tags are not changed.', 'Delete')) {
    await repo.exec(['tag', '-d', name]);
    await repo.refresh();
  }
}

export async function newTag(repo: Repository, revision: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: `New Tag on ${revision === 'HEAD' ? repo.headLabel : revision.slice(0, 7)}`,
    prompt: 'Tag name',
    validateInput: async (value) => {
      if (!value.trim()) {
        return 'Enter a tag name';
      }
      try {
        await repo.exec(['check-ref-format', `refs/tags/${value}`], { quiet: true });
        return undefined;
      } catch {
        return `'${value}' is not a valid tag name`;
      }
    }
  });
  if (name) {
    await repo.exec(['tag', name, revision]);
    await repo.refresh();
    notify(`$(check) Created tag ${name}`);
  }
}

/**
 * `git checkout` that handles local changes like JetBrains IDEs: when they would be overwritten,
 * Smart Checkout stashes them, checks out and restores them; Force Checkout discards them.
 */
export async function smartCheckout(repo: Repository, args: string[], target: string): Promise<boolean> {
  try {
    await repo.exec(['checkout', ...args]);
  } catch (error) {
    if (!(error instanceof GitError) || !/Your local changes to the following files would be overwritten/.test(error.stderr)) {
      throw error;
    }
    const files = error.stderr
      .split('\n')
      .filter((line) => line.startsWith('\t'))
      .map((line) => line.trim());
    const choice = await vscode.window.showWarningMessage(
      `Your local changes would be overwritten by checkout of '${target}'.`,
      {
        modal: true,
        detail: `${listPaths(files)}\n\nSmart Checkout stashes the changes, checks out '${target}' and restores them. Force Checkout discards them.`
      },
      'Smart Checkout',
      'Force Checkout'
    );
    if (!choice) {
      return false;
    }
    if (choice === 'Force Checkout') {
      await repo.exec(['checkout', '--force', ...args]);
    } else {
      await repo.exec(['stash', 'push', '-m', `git-awesome: local changes before checkout of ${target}`]);
      try {
        await repo.exec(['checkout', ...args]);
      } finally {
        await repo.exec(['stash', 'pop']).catch(async () => {
          await repo.refresh();
          void vscode.window.showWarningMessage('Your local changes were restored with conflicts; they are also kept in the stash.');
          if (repo.conflicts.length) {
            void showConflicts(repo);
          }
        });
      }
    }
  }
  await repo.refresh();
  notify(`$(check) Checked out ${target}`);
  return true;
}

async function checkout(repo: Repository, ref: Ref, refs: Ref[]): Promise<boolean> {
  if (ref.type !== 'remote') {
    return smartCheckout(repo, [ref.name], ref.name);
  }
  const local = ref.remoteBranch!;
  const existing = refs.find((r) => r.type === 'head' && r.name === local);
  if (!existing) {
    return smartCheckout(repo, ['-b', local, '--track', ref.name], local);
  }
  const choice = await vscode.window.showWarningMessage(
    `Local branch '${local}' already exists.`,
    {
      modal: true,
      detail: `Checkout and Update checks out '${local}' and fast-forwards it to '${ref.name}'. Overwrite resets '${local}' to '${ref.name}'; its commits that are not in '${ref.name}' are lost.`
    },
    'Checkout and Update',
    'Overwrite'
  );
  if (choice === 'Overwrite') {
    return smartCheckout(repo, ['-B', local, '--track', ref.name], local);
  }
  if (choice !== 'Checkout and Update' || !(await smartCheckout(repo, [local], local))) {
    return false;
  }
  try {
    await repo.exec(['merge', '--ff-only', ref.name]);
  } catch {
    void vscode.window.showWarningMessage(`'${local}' has diverged from '${ref.name}' and was not updated. Use Update Project to merge or rebase.`);
  }
  await repo.refresh();
  return true;
}

async function validateBranchName(repo: Repository, name: string, existing: (name: string) => boolean): Promise<string | undefined> {
  if (!name.trim()) {
    return 'Enter a branch name';
  }
  if (existing(name)) {
    return `Branch '${name}' already exists`;
  }
  try {
    await repo.exec(['check-ref-format', '--branch', name], { quiet: true });
    return undefined;
  } catch {
    return `'${name}' is not a valid branch name`;
  }
}

export async function newBranch(repo: Repository, startPoint?: string): Promise<void> {
  const locals = new Set((await repo.refs()).filter((r) => r.type === 'head').map((r) => r.name));
  const name = await vscode.window.showInputBox({
    title: startPoint ? `Create New Branch from '${startPoint}'` : 'Create New Branch',
    prompt: 'New branch name; the branch is checked out after creation',
    validateInput: (value) => validateBranchName(repo, value, (n) => locals.has(n))
  });
  if (name) {
    await smartCheckout(repo, ['-b', name, ...(startPoint ? [startPoint] : [])], name);
  }
}

export async function checkoutRevision(repo: Repository): Promise<void> {
  const revision = await vscode.window.showInputBox({
    title: 'Checkout Tag or Revision',
    prompt: 'Enter a reference (branch, tag) name or commit hash',
    validateInput: async (value) => (!value.trim() || (await repo.revParse(value.trim())) ? undefined : `'${value}' does not name a commit`)
  });
  if (revision?.trim()) {
    await smartCheckout(repo, [revision.trim()], revision.trim());
  }
}

async function checkoutAndRebase(repo: Repository, ref: Ref, refs: Ref[]): Promise<void> {
  const onto = repo.head!;
  if (ref.type === 'remote') {
    if (await checkout(repo, ref, refs)) {
      await rebaseOnto(repo, onto);
    }
    return;
  }
  // `git rebase <upstream> <branch>` checks out <branch> first.
  if ((await runWithConflicts(repo, ['rebase', '--autostash', onto, ref.name])) !== undefined) {
    notify(`$(check) Rebased ${ref.name} onto ${onto}`);
  }
}

async function rebaseOnto(repo: Repository, target: string): Promise<void> {
  const current = repo.headLabel;
  if ((await runWithConflicts(repo, ['rebase', '--autostash', target])) !== undefined) {
    notify(`$(check) Rebased ${current} onto ${target}`);
  }
}

async function mergeInto(repo: Repository, source: string): Promise<void> {
  const current = repo.headLabel;
  const output = await runWithConflicts(repo, ['merge', '--autostash', '--no-edit', source]);
  if (output !== undefined) {
    if (/Already up to date/.test(output)) {
      void vscode.window.showInformationMessage(`'${current}' is already up to date with '${source}'.`);
    } else {
      notify(`$(check) Merged ${source} into ${current}`);
    }
  }
}

async function pullInto(repo: Repository, ref: Ref, method: 'merge' | 'rebase'): Promise<void> {
  await withProgress(`Fetching ${ref.name}…`, () => repo.api.fetch({ remote: ref.remote, ref: ref.remoteBranch }));
  await (method === 'merge' ? mergeInto(repo, ref.name) : rebaseOnto(repo, ref.name));
}

async function compareWithCurrent(repo: Repository, ref: Ref): Promise<void> {
  const current = repo.headRef;
  const [incoming, outgoing] = await Promise.all([
    repo.log([`${current}..${ref.name}`, '-n', '1000']),
    repo.log([`${ref.name}..${current}`, '-n', '1000'])
  ]);
  type CommitItem = vscode.QuickPickItem & { commit?: Commit; files?: boolean };
  const commitItem = (commit: Commit): CommitItem => ({
    label: commit.subject,
    description: `${commit.shortHash} · ${commit.author} · ${formatDate(commit.date)}`,
    commit
  });
  const items: CommitItem[] = [
    { label: '$(diff-multiple) Show Files Changed Between Branches', description: `${repo.headLabel} ↔ ${ref.name}`, files: true },
    separator(`In '${ref.name}' but not in '${repo.headLabel}' (${incoming.length})`),
    ...incoming.map(commitItem),
    separator(`In '${repo.headLabel}' but not in '${ref.name}' (${outgoing.length})`),
    ...outgoing.map(commitItem)
  ];
  for (;;) {
    const choice = await pick(items, { title: `Compare '${ref.name}' with '${repo.headLabel}'`, matchOnDescription: true });
    if (!choice || choice === BACK) {
      return;
    }
    const result = choice.files
      ? await showRefChanges(repo, `${repo.headLabel} ↔ ${ref.name}`, current, ref.name, true)
      : choice.commit
        ? await showCommitChanges(repo, choice.commit, true)
        : undefined;
    if (result !== BACK) {
      return;
    }
  }
}

async function renameBranch(repo: Repository, ref: Ref): Promise<void> {
  const locals = new Set((await repo.refs()).filter((r) => r.type === 'head').map((r) => r.name));
  const name = await vscode.window.showInputBox({
    title: `Rename Branch '${ref.name}'`,
    value: ref.name,
    validateInput: (value) => (value === ref.name ? undefined : validateBranchName(repo, value, (n) => locals.has(n)))
  });
  if (name && name !== ref.name) {
    await repo.exec(['branch', '-m', ref.name, name]);
    await repo.refresh();
  }
}

async function deleteBranch(repo: Repository, ref: Ref): Promise<void> {
  if (ref.type === 'remote') {
    if (await confirm(`Delete remote branch '${ref.name}'?`, `The branch '${ref.remoteBranch}' is deleted on '${ref.remote}' for everyone.`, 'Delete')) {
      await withProgress(`Deleting ${ref.name}…`, () => repo.exec(['push', ref.remote!, '--delete', ref.remoteBranch!]));
      notify(`$(check) Deleted remote branch ${ref.name}`);
    }
    return;
  }
  try {
    await repo.exec(['branch', '-d', ref.name]);
  } catch (error) {
    if (!(error instanceof GitError) || !/not fully merged/.test(error.stderr)) {
      throw error;
    }
    if (!(await confirm(`Branch '${ref.name}' is not fully merged.`, 'Its commits that are not in other branches will be unreachable.', 'Delete Anyway'))) {
      return;
    }
    await repo.exec(['branch', '-D', ref.name]);
  }
  await repo.refresh();
  const choice = await vscode.window.showInformationMessage(`Deleted branch '${ref.name}'.`, 'Restore');
  if (choice) {
    await repo.exec(['branch', ref.name, ref.hash]);
    if (ref.upstream && ref.upstream.includes('/')) {
      await repo.exec(['branch', `--set-upstream-to=${ref.upstream}`, ref.name]).catch(() => undefined);
    }
    await repo.refresh();
  }
}
