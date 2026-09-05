#!/bin/sh
set -eu
patina_test_root=$(mktemp -d)
trap 'rm -rf "$patina_test_root"' EXIT
: "${PATINA_TEST_CLI:?Set PATINA_TEST_CLI to a Patina bin/patina.js with inspect support}"
export PATINA_HOST_RECEIPT="$patina_test_root/receipt.json"
: "${PATINA_CODE_BINARY:=/usr/share/code/code}"
unset VSCODE_IPC_HOOK_CLI ELECTRON_RUN_AS_NODE
xvfb-run -a "$PATINA_CODE_BINARY" --no-sandbox --disable-gpu --disable-workspace-trust --skip-welcome --skip-release-notes \
  --user-data-dir "$patina_test_root/user" --extensions-dir "$patina_test_root/extensions" \
  --extensionDevelopmentPath "$PWD" --extensionTestsPath "$PWD/tests/host.cjs" --new-window
test -f "$PATINA_HOST_RECEIPT"
cat "$PATINA_HOST_RECEIPT"
