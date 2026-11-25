#!/bin/bash
# Screenshot the dev shell started by tools/devshell.sh.
set -euo pipefail
DEV=${CUW_DEV_DIR:-$XDG_RUNTIME_DIR/cuw-dev}
OUT=$(realpath -m "${1:-shot.png}")
export DBUS_SESSION_BUS_ADDRESS=$(cat "$DEV/bus")
gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell/Screenshot \
    -m org.gnome.Shell.Screenshot.Screenshot false false "$OUT" >/dev/null
echo "$OUT"
