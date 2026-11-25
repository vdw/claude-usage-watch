#!/bin/bash
# Evaluate JS in the dev shell started by tools/devshell.sh. Prints the result.
set -euo pipefail
DEV=${CUW_DEV_DIR:-$XDG_RUNTIME_DIR/cuw-dev}
export DBUS_SESSION_BUS_ADDRESS=$(cat "$DEV/bus")
gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "$1"
