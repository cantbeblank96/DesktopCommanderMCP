#!/bin/sh
# Install on B and replace all paths. Do not add the `remote` subcommand.
set -eu
umask 077

NODE=/home/dc/.local/share/node/bin/node
BACKEND=/home/dc/.local/share/rdc-runtime/dist/index.js
WORKDIR=/home/dc/workspace

export DC_REMOTE_DEVICE=true
# Skip optional browser discovery/download at startup on headless nodes.
export DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT=1
# Exit this MCP backend when the controlling SSH standard input closes.
export DESKTOP_COMMANDER_EXIT_ON_STDIN_CLOSE=1
export DESKTOP_COMMANDER_DISABLE_TELEMETRY=1
export PATH=/home/dc/.local/share/node/bin:/usr/local/bin:/usr/bin:/bin

# stdout belongs exclusively to MCP. Send diagnostics to stderr.
test -x "$NODE" || { echo 'Node executable missing' >&2; exit 1; }
test -f "$BACKEND" || { echo 'Desktop Commander backend missing' >&2; exit 1; }
cd "$WORKDIR"
exec "$NODE" "$BACKEND" --no-onboarding
