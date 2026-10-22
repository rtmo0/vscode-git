#!/bin/bash
# Runs test/integration/suite.js in an Extension Development Host. CODE: path to the VS Code binary.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Electron}"
TEST_DIR="$ROOT/.vscode-test"
rm -rf "$TEST_DIR/u" "$TEST_DIR/demo"; mkdir -p "$TEST_DIR/u/User" "$TEST_DIR/e"
echo '{"workbench.startupEditor":"none","security.workspace.trust.enabled":false,"git.autofetch":false}' > "$TEST_DIR/u/User/settings.json"
bash "$ROOT/test/integration/demo.sh" "$TEST_DIR/demo"
# A clean environment: inside a VS Code terminal ELECTRON_RUN_AS_NODE would turn the binary into node.
env -i HOME="$HOME" PATH="$PATH" USER="$USER" TMPDIR="$TMPDIR" "$CODE" \
  --user-data-dir "$TEST_DIR/u" --extensions-dir "$TEST_DIR/e" \
  --extensionDevelopmentPath="$ROOT" --extensionTestsPath="$ROOT/test/integration/suite.js" \
  --new-window "$TEST_DIR/demo"
