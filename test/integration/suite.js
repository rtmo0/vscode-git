/* Runs inside the Extension Development Host (--extensionTestsPath) against the demo repository
 * created by test/integration/demo.sh: a merge stopped on a conflict plus local changes. */
const assert = require('assert');
const { execFileSync } = require('child_process');
const vscode = require('vscode');

const until = async (condition, what) => {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

exports.run = async () => {
  const extension = vscode.extensions.getExtension('samarin-aa-aka-rtm00.git-awesome');
  const { manager, tree, colors } = await extension.activate();
  await until(() => manager.repositories.length === 1 && manager.repositories[0].operation, 'the demo repository');
  const repo = manager.repositories[0];
  const git = (...args) => execFileSync('git', args, { cwd: repo.root, encoding: 'utf8' });

  const labels = () => tree.getChildren().map((node) => {
    const item = tree.getTreeItem(node);
    return `${item.label}${item.description ? ` (${item.description})` : ''}`;
  });
  assert.deepStrictEqual(labels(), [
    "Merging 'feature' into 'main' (1 conflict)",
    'Merge Conflicts (1 file)',
    'Changes (2 files)',
    'Unversioned Files (1 file)'
  ]);
  const changes = tree.getChildren().find((n) => n.group === 'changes');
  assert.deepStrictEqual(tree.getChildren(changes).map((n) => tree.getTreeItem(n).label), ['src']);
  assert.strictEqual(tree.getTreeItem(changes).checkboxState, vscode.TreeItemCheckboxState.Checked);

  // JetBrains file status colors for the Explorer, tabs and the Changes view.
  const colorOf = (path) => colors.provideFileDecoration(vscode.Uri.file(`${repo.root}/${path}`))?.color?.id;
  assert.strictEqual(colorOf('src/git/a.ts'), 'gitAwesome.modifiedForeground');
  assert.strictEqual(colorOf('src/b.ts'), 'gitAwesome.deletedForeground');
  assert.strictEqual(colorOf('docs/notes.md'), 'gitAwesome.unversionedForeground');
  assert.strictEqual(colorOf('conflict.txt'), 'gitAwesome.conflictForeground');
  assert.strictEqual(colorOf('README.md'), undefined);

  const conflict = tree.getChildren(tree.getChildren().find((n) => n.group === 'conflicts'))[0];
  await vscode.commands.executeCommand('git-awesome.acceptTheirs', conflict);
  await until(() => repo.conflicts.length === 0, 'the conflict to be resolved');
  assert.strictEqual(git('show', ':conflict.txt'), 'feature\n');

  // The merge message is prefilled; Commit concludes the merge with the checked changes.
  await vscode.commands.executeCommand('git-awesome.commit');
  await until(() => !repo.operation, 'the merge commit');
  assert.strictEqual(git('log', '-1', '--format=%P').trim().split(' ').length, 2);
  assert.strictEqual(git('log', '-1', '--format=%s').trim(), "Merge branch 'feature'");
  assert.strictEqual(git('status', '--porcelain', '--untracked-files=all').trim(), '?? docs/notes.md');
};
