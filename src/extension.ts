import * as vscode from 'vscode';
import { showBranches, checkoutRevision, newBranch, newTag } from './actions/branches';
import { addToGitignore, addToVcs, deleteUnversioned, rollback } from './actions/commit';
import { abortOperation, accept, continueOperation, markResolved, merge, showConflicts, skipCommit, watchResolution } from './actions/conflicts';
import { fetch, push, updateProject } from './actions/remote';
import { Inclusion, isDeleted } from './changes';
import { GitContentProvider, openDiffs, SCHEME, workingTreeDiff } from './diff';
import { getGitApi } from './gitApi';
import { Repository, RepositoryManager } from './repository';
import { FileColors } from './decorations';
import { BranchStatusBar } from './statusBar';
import { guarded } from './ui';
import { ChangesReview } from './views/changesReview';
import { ChangesTree, FileNode, filesOf, Node } from './views/changesTree';
import { CommitView } from './views/commitView';
import { LOG_VIEW_ID, LogView } from './views/logView';

/** Returned from activate for integration tests. */
export interface TestApi {
  manager: RepositoryManager;
  tree: ChangesTree;
  review: ChangesReview;
  colors: FileColors;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const output = vscode.window.createOutputChannel('Git Awesome', { log: true });
  context.subscriptions.push(output, vscode.commands.registerCommand('git-awesome.showOutput', () => output.show()));

  // The built-in Git extension discovers repositories, resolves git.path and authenticates network operations.
  const api = await getGitApi();
  if (!api) {
    output.error('The built-in Git extension is disabled; Git Awesome needs it.');
    void vscode.window.showWarningMessage('Git Awesome needs the built-in Git extension. Enable it and the "git.enabled" setting.');
    return undefined;
  }
  output.info(`Using git at ${api.git.path}`);

  const manager = new RepositoryManager(api, output);
  const inclusion = new Inclusion(context.workspaceState);
  const tree = new ChangesTree(manager, inclusion);
  const review = new ChangesReview(tree);
  const commitView = new CommitView(manager, inclusion, context.workspaceState, context.globalState);
  const state = context.globalState;
  const colors = new FileColors(manager);
  const logView = new LogView(context.extensionUri, manager, state, (text) => commitView.setDraft(text));
  context.subscriptions.push(
    logView,
    manager,
    inclusion,
    tree,
    review,
    commitView,
    new BranchStatusBar(manager),
    colors,
    watchResolution(manager),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider(manager))
  );

  const files = (node?: Node, selected?: readonly Node[]): FileNode[] => filesOf(tree.targets(node, selected));
  const conflictsByRepo = (node?: Node, selected?: readonly Node[]) => {
    const conflicts = files(node, selected).filter((f) => f.group === 'conflicts');
    return [...new Set(conflicts.map((f) => f.repo))].map((repo) => ({ repo, changes: conflicts.filter((f) => f.repo === repo).map((f) => f.change) }));
  };
  const operationRepo = async (node?: Node): Promise<Repository | undefined> =>
    node?.repo ?? (await manager.pick('Select Repository', (repo) => repo.operation !== undefined));

  const commands: Record<string, (...args: never[]) => unknown> = {
    'git-awesome.refresh': () => Promise.all([manager.refreshAll(), logView.refresh()]),
    'git-awesome.showLog': () => vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`),
    'git-awesome.fetch': () => fetch(manager),
    'git-awesome.updateProject': () => updateProject(manager, state),
    'git-awesome.push': () => push(manager, state),
    'git-awesome.branches': () => showBranches(manager, state),
    'git-awesome.newBranch': async () => {
      const repo = await manager.pick('New Branch');
      return repo && newBranch(repo);
    },
    'git-awesome.newTag': async () => {
      const repo = await manager.pick('New Tag');
      return repo && newTag(repo, 'HEAD');
    },
    'git-awesome.checkoutRevision': async () => {
      const repo = await manager.pick('Checkout Tag or Revision');
      return repo && checkoutRevision(repo);
    },
    'git-awesome.commit': () => commitView.commit(false),
    'git-awesome.commitAndPush': () => commitView.commit(true),

    'git-awesome.showDiff': async (node?: Node, selected?: readonly Node[]) => {
      const targets = files(node, selected);
      if (targets.length === 1) {
        return targets[0].group === 'conflicts' ? merge(targets[0].repo, targets[0].change) : review.preview(targets[0]);
      }
      const items = targets.filter((f) => f.group !== 'conflicts').map((f) => workingTreeDiff(f.repo, f.change));
      return openDiffs('Changes', items);
    },
    'git-awesome.nextChangedFile': () => review.step(1),
    'git-awesome.previousChangedFile': () => review.step(-1),
    'git-awesome.showAllChanges': () =>
      openDiffs(
        'All Changes',
        manager.repositories.flatMap((repo) =>
          repo.status.changes.filter((c) => c.kind !== 'conflicted' && c.kind !== 'ignored').map((c) => workingTreeDiff(repo, c))
        )
      ),
    'git-awesome.openFile': async (node?: Node, selected?: readonly Node[]) => {
      const targets = files(node, selected).filter((f) => !isDeleted(f.change));
      for (const f of targets) {
        await vscode.window.showTextDocument(f.repo.fileUri(f.change.path), { preview: targets.length === 1 });
      }
    },
    'git-awesome.rollback': (node?: Node, selected?: readonly Node[]) => rollback(files(node, selected)),
    'git-awesome.addToVcs': (node?: Node, selected?: readonly Node[]) => addToVcs(files(node, selected)),
    'git-awesome.deleteUnversioned': (node?: Node, selected?: readonly Node[]) => deleteUnversioned(files(node, selected)),
    'git-awesome.addToGitignore': (node?: Node, selected?: readonly Node[]) => addToGitignore(files(node, selected)),
    'git-awesome.groupByDirectory': () => vscode.workspace.getConfiguration('git-awesome').update('changes.groupByDirectory', true, vscode.ConfigurationTarget.Global),
    'git-awesome.groupFlat': () => vscode.workspace.getConfiguration('git-awesome').update('changes.groupByDirectory', false, vscode.ConfigurationTarget.Global),

    'git-awesome.resolveConflicts': async (node?: Node) => {
      const repo = node?.repo ?? (await manager.pick('Resolve Conflicts', (r) => r.conflicts.length > 0));
      return repo && showConflicts(repo);
    },
    'git-awesome.mergeConflict': async (node?: Node, selected?: readonly Node[]) => {
      for (const { repo, changes } of conflictsByRepo(node, selected)) {
        await merge(repo, changes[0]);
      }
    },
    'git-awesome.acceptYours': async (node?: Node, selected?: readonly Node[]) => {
      for (const { repo, changes } of conflictsByRepo(node, selected)) {
        await accept(repo, changes, 'yours');
      }
    },
    'git-awesome.acceptTheirs': async (node?: Node, selected?: readonly Node[]) => {
      for (const { repo, changes } of conflictsByRepo(node, selected)) {
        await accept(repo, changes, 'theirs');
      }
    },
    'git-awesome.markResolved': async (node?: Node, selected?: readonly Node[]) => {
      for (const { repo, changes } of conflictsByRepo(node, selected)) {
        await markResolved(repo, changes);
      }
    },
    'git-awesome.continueOperation': async (node?: Node) => {
      const repo = await operationRepo(node);
      return repo && continueOperation(repo);
    },
    'git-awesome.abortOperation': async (node?: Node) => {
      const repo = await operationRepo(node);
      return repo && abortOperation(repo);
    },
    'git-awesome.skipCommit': async (node?: Node) => {
      const repo = await operationRepo(node);
      return repo && skipCommit(repo);
    }
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(handler as (...args: unknown[]) => unknown)));
  }
  // Show the Git tool window once, when the first repository appears, so the Log is discovered without hunting for it.
  const SHOWN_KEY = 'git-awesome.logShown';
  if (!state.get(SHOWN_KEY)) {
    const showOnce = manager.onDidChange(() => {
      if (manager.repositories.length && !state.get(SHOWN_KEY)) {
        showOnce.dispose();
        void state.update(SHOWN_KEY, true);
        void vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      }
    });
    context.subscriptions.push(showOnce);
  }
  return { manager, tree, review, colors };
}

export function deactivate(): void {}
