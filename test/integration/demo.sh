#!/bin/bash
# Creates a repository with a merge stopped on a conflict, a modified, a deleted and an unversioned file.
set -e
rm -rf "$1"; mkdir -p "$1"; cd "$1"
export GIT_AUTHOR_NAME=Demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=Demo GIT_COMMITTER_EMAIL=demo@example.com
g() { git -c commit.gpgsign=false "$@"; }
g init -q -b main; mkdir -p src/git docs; echo a > src/git/a.ts; echo b > src/b.ts; echo readme > README.md; echo x > conflict.txt
g add .; g commit -qm init
g checkout -qb feature; echo feature > conflict.txt; g commit -qam "feature change"
g checkout -q main; echo main > conflict.txt; g commit -qam "main change"
g merge feature >/dev/null 2>&1 || true
echo a2 > src/git/a.ts; echo new > docs/notes.md; rm src/b.ts
