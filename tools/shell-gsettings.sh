#!/bin/bash
# Run gsettings against the dev shell's isolated dconf, with the extension schema.
# Example: tools/shell-gsettings.sh set org.gnome.shell.extensions.claude-usage-watch display-mode worst
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV=${CUW_DEV_DIR:-$XDG_RUNTIME_DIR/cuw-dev}
export DBUS_SESSION_BUS_ADDRESS=$(cat "$DEV/bus") XDG_CONFIG_HOME="$DEV/config"
exec gsettings --schemadir "$ROOT/schemas" "$@"
