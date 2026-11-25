#!/bin/bash
# Start a headless GNOME Shell with its own D-Bus session, dconf database and
# extensions dir, so testing never touches the real session.
#
#   tools/devshell.sh            # start (foreground; Ctrl-C to stop)
#   tools/shell-eval.sh 'JS'     # run JS inside it (from another terminal)
#   tools/shell-shot.sh out.png  # screenshot it
#
# The dev dir defaults to $XDG_RUNTIME_DIR/cuw-dev; set CUW_DEV_DIR to change.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV=${CUW_DEV_DIR:-$XDG_RUNTIME_DIR/cuw-dev}
SIZE=${CUW_DEV_SIZE:-1600x900}

if [[ "${1:-}" != "--inner" ]]; then
    mkdir -p "$DEV/data/gnome-shell/extensions" "$DEV/config"
    ln -sfn "$ROOT" "$DEV/data/gnome-shell/extensions/claude-usage-watch@vdw.github.io"
    ln -sfn "$ROOT/tools/devhelper" "$DEV/data/gnome-shell/extensions/cuw-devhelper@local"
    glib-compile-schemas "$ROOT/schemas"
    export XDG_DATA_HOME="$DEV/data" XDG_CONFIG_HOME="$DEV/config"
    # Never let anything started on the dev bus reach the real session's display.
    unset WAYLAND_DISPLAY DISPLAY
    exec dbus-run-session -- "$0" --inner
fi

echo "$DBUS_SESSION_BUS_ADDRESS" > "$DEV/bus"

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['cuw-devhelper@local', 'claude-usage-watch@vdw.github.io']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
# Seed accounts once, from CUW_DEV_ACCOUNTS if given.
SCHEMA_ARGS=(--schemadir "$ROOT/schemas")
if [[ -n "${CUW_DEV_ACCOUNTS:-}" ]]; then
    gsettings "${SCHEMA_ARGS[@]}" set org.gnome.shell.extensions.claude-usage-watch accounts "$CUW_DEV_ACCOUNTS"
fi

gnome-shell --headless --no-x11 --virtual-monitor "$SIZE" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null; rm -f "$DEV/bus"' EXIT INT TERM

# Once the shell answers, give D-Bus-activated apps (the prefs window) its display.
for _ in $(seq 60); do
    if out=$(gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval \
            'imports.gi.GLib.getenv("WAYLAND_DISPLAY")' 2>/dev/null) && [[ $out == "(true, '\"wayland-"* ]]; then
        display=${out#*\"}; display=${display%%\"*}
        dbus-update-activation-environment "WAYLAND_DISPLAY=$display"
        echo "dev shell ready on $display"
        break
    fi
    sleep 1
done
wait $SHELL_PID
