#!/bin/bash
# Click at screen coordinates in the dev shell: tools/shell-click.sh X Y
set -euo pipefail
E="$(dirname "$0")/shell-eval.sh"
INIT='const C = imports.gi.Clutter;
global._cuwPtr ??= C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
const d = global._cuwPtr, now = imports.gi.GLib.get_monotonic_time();'
"$E" "$INIT d.notify_absolute_motion(now, $1, $2); 'ok'" >/dev/null
sleep 0.15
"$E" "$INIT d.notify_button(now, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); 'ok'" >/dev/null
sleep 0.08
"$E" "$INIT d.notify_button(now, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); 'ok'" >/dev/null
sleep 0.3
