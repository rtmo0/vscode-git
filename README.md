# Git Awesome

[![Support on Boosty](https://img.shields.io/badge/Boosty-support-F15F2C?logo=boosty&logoColor=white)](https://boosty.to/rtm00)

Git Awesome brings the Git workflow of JetBrains IDEs to VS Code: a Commit tool window with per-file checkboxes and changelists, a Log with a commit graph and branch filters, a Branches popup, Push and Update Project dialogs, a conflicts dialog, shelf and blame annotations.

<img src="media/icon.png" alt="Git Awesome icon" width="128" align="right" />

> **Preview.** See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next (Interactive Rebase, Shelf, Annotate).

## Git tool window: Log

The **Git** panel (next to Terminal, opened automatically the first time, or **Git Awesome: Show Git Log**) works like the Log tab in JetBrains IDEs:

- **Branches** on the left: *HEAD (Current Branch)*, *Local* and *Remote* branches in folders (`feature/…`), *Tags*. Click a branch to jump to its commit, double-click to show only its history, right-click for Checkout, Merge, Rebase, Compare, Rename, Delete and the rest.
- **Commit graph** in the middle with branch and tag labels, author, date and hash. Filter by text or hash, branch and user; history loads as you scroll.
- **Details** on the right: changed files (click to see the diff) and the full message, author, labels and the branches that contain the commit. Double-click a commit for all its changes in one diff.
- Right-click a commit: Copy Revision Number, Show All Changes, Compare with Local, Cherry-Pick, Checkout Revision, Reset Current Branch to Here…, Revert Commit, Undo Commit, Edit Commit Message, New Branch…, New Tag….

## Commit tool window

Open **Commit** in the Activity Bar on the left, as in JetBrains IDEs: the changes tree on top, the message and buttons below, and the whole editor area free for diffs.

- **Changes** lists *Merge Conflicts*, *Changes* and *Unversioned Files*, grouped by directory (or flat). Checkboxes choose what goes into the commit: tracked changes are checked by default, unversioned files are not — exactly as in JetBrains IDEs. Nothing has to be staged.
- **Diff preview**: click a file or move through the tree with `↑`/`↓` — its diff opens in the preview editor while focus stays in the tree, so you can walk the whole change list from the keyboard.
- In an open diff, **Previous Changed File** / **Next Changed File** (arrows in the editor title) step to the neighbouring file and select it in the tree.
- Select several files (or a folder) and use **Show Diff** for the multi-file diff editor. **Show All Changes** in the toolbar opens every change at once.
- **Commit Message**: **Commit**, **Commit and Push…**, **Amend** (brings back the last message), **History…** of your messages, `⌘Enter`/`Ctrl+Enter` to commit. Merge and cherry-pick messages are prefilled.
- Context menu: **Rollback…** (added files stay on disk as unversioned), **Add to VCS**, **Add to .gitignore**, **Delete…** (to trash), **Jump to Source**.

## Branches, Update and Push

- The branch in the status bar (and the toolbar button) opens **Git Branches**: Update Project, Commit, Push, New Branch, Checkout Tag or Revision, Fetch, then *Recent*, *Local* and *Remote* branches.
- Per branch: **Checkout**, **New Branch from…**, **Checkout and Rebase onto current**, **Compare with current**, **Show Diff with Working Tree**, **Rebase current onto…**, **Merge into current**, **Pull into current Using Merge/Rebase**, **Rename…**, **Delete** (with **Restore**).
- **Smart Checkout**: when local changes would be overwritten, they are stashed, the branch is checked out and the changes are restored. **Force Checkout** discards them.
- **Update Project…** fetches and merges or rebases every repository onto its tracked branch; uncommitted changes are stashed and restored automatically.
- **Push…** shows the outgoing commits (select one to see its files), pushes new branches with upstream tracking and offers **Force Push** with `--force-with-lease` and **Push Tags**.
- **New Tag…** tags the current commit (or any commit from the Log); tags have **Checkout**, **Compare**, **Push Tag** and **Delete Tag**. A rejected push offers **Merge** or **Rebase** and pushes again.
- Fetch, pull and push go through the built-in Git extension, so its authentication (SSH agent, credential helpers, GitHub sign-in) works unchanged.

## Merge conflicts

- A merge, rebase, pull or cherry-pick that stops on conflicts opens the **Conflicts** dialog: Enter opens **Merge…** (the three-way merge editor), the item buttons **Accept Yours** / **Accept Theirs**, and the last entries accept one side for all files. During a rebase *Yours* is your rebased commit, as in JetBrains IDEs.
- The Changes view shows the operation in progress with **Continue**, **Skip Commit** (rebase) and **Abort…**; once the last conflict is resolved you are offered to continue.

## JetBrains file colors

Changed files are colored as in JetBrains IDEs in the Explorer, editor tabs, the Changes view and the Log: **modified** blue, **added** green, **deleted** grey, **unversioned** red-brown, **conflicts** red — with separate palettes for dark, light and high-contrast themes. Turn it off with `git-awesome.jetbrainsColors`, or change single colors in `workbench.colorCustomizations` (`gitAwesome.modifiedForeground`, `gitAwesome.addedForeground`, …).

## JetBrains shortcuts

Enable `git-awesome.jetbrainsKeymap` for `⌘T`/`Ctrl+T` Update Project, `⌘⇧K`/`Ctrl+Shift+K` Push, ``Ctrl+Shift+` `` Branches and `⌘K`/`Ctrl+K` Commit (outside the text editor). They override the VS Code bindings of these keys, so they are off by default.

## Requirements

- VS Code 1.95 or newer with the built-in Git extension enabled (Git Awesome uses the git binary it resolves, including the `git.path` setting).
- A trusted workspace.

## Development

```bash
npm install
npm run check   # type-check
npm test        # unit tests
npm run test:integration  # runs test/integration/suite.js in VS Code (set CODE to the VS Code binary)
npm run build   # bundle into dist/
```

Press **F5** (*Run Extension (No Debugger)*) to start an Extension Development Host.

## Support

If Git Awesome saves you time, you can support its development on [Boosty](https://boosty.to/rtm00).

*JetBrains and IntelliJ IDEA are trademarks of JetBrains s.r.o. Git Awesome is not affiliated with or endorsed by JetBrains.*
