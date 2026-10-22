# Roadmap

Goal: behave the way the Git integration of JetBrains IDEs behaves — same windows, same actions, same names, same defaults — using native VS Code UI wherever it can express the JetBrains behaviour, and webviews only where it cannot.

## Architecture

- **git CLI, not the built-in Git extension API.** Every operation runs `git` directly (`src/git/git.ts`) with machine-readable output (`--porcelain=v2 -z`, `--format` with NUL separators). The built-in Git extension is used only to locate the git binary and discover repositories.
- **Multiple repositories.** Every view groups by repository root, like JetBrains "Git roots".
- **Repository state model.** One watcher per repository (`.git/HEAD`, `index`, `refs`, worktree) feeds a debounced state model; all views render from it.
- **Native first:** TreeViews (with checkboxes) for Commit and Shelf, QuickPick for the Branches popup, the VS Code diff and merge editors for Show Diff and Merge…, editor decorations for Annotate.
- **Webviews** for what has no native equivalent: Log (graph table + details), Push dialog, Interactive Rebase, Conflicts dialog.
- Parsers are pure functions covered by unit tests; integration tests run against throw-away repositories.

## Milestones

### 1. Commit tool window — done in 0.1.0 (except changelists and partial hunks)
- Changes tree grouped by directory, with per-file and per-directory checkboxes; Unversioned Files node.
- Changelists (default *Changes*, create/move/rename/delete, set active).
- Commit message box with message history; **Amend**; author override; sign-off.
- **Commit** and **Commit and Push…**; Rollback; Show Diff (double click); Jump to Source.
- Partial commit of selected hunks/lines.

### 2. Branches popup (status bar) — done in 0.1.0
- Recent, Local and Remote branches with search and favourites.
- Per branch: Checkout, New Branch from…, Checkout and Rebase onto Current, Compare with Current, Show Diff with Working Tree, Rebase Current onto Selected, Merge into Current, Pull into Current Using Rebase/Merge, Push…, Rename…, Delete.
- New Branch…, Checkout Tag or Revision…, Update Project (merge/rebase, with auto-stash).

### 3. Push dialog — done in 0.1.0
- Outgoing commits per repository and branch with changed files and diffs.
- Target branch editing, Push Tags, Force Push (`--force-with-lease`), set upstream.

### 4. Log — done in 0.1.0 (except date and path filters, Create Patch, Show Repository at Revision, Fixup/Squash, Interactive Rebase)
- Commit graph with branch/tag labels; columns: subject, author, date, hash.
- Filters: branch, user, date, path, text/regex/hash search.
- Details pane: changed files tree and full message.
- Context actions: Copy Revision Number, Create Patch, Cherry-Pick, Checkout Revision, Show Repository at Revision, Compare with Local, Reset Current Branch to Here…, Revert Commit, Undo Commit, Edit Commit Message, Fixup/Squash Into…, Interactively Rebase from Here…, New Branch…, New Tag….

### 5. Conflicts and Interactive Rebase
- Conflicts dialog: Accept Yours / Accept Theirs / Merge… (VS Code merge editor); continue/abort merge, rebase, cherry-pick.
- Interactive Rebase dialog: reorder, pick/edit/reword/squash/fixup/drop.

### 6. Shelf, Stash, Annotate, History
- Shelf (patch-based, per changelist) and Stash with Unshelve/Apply/Pop.
- Annotate with Git Blame in the editor gutter area, with commit details on hover.
- Show History for file and for selection.

## Out of scope
- Local History (VS Code Timeline covers it), code analysis before commit, GitHub/GitLab pull requests.
