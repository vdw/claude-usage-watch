#!/bin/bash
# Build claude-usage-watch@vdw.github.io.shell-extension.zip for install or upload.
set -euo pipefail
cd "$(dirname "$0")/.."
./tools/gen-css.py
gjs -m tests/run.js >/dev/null
gnome-extensions pack --force \
    --schema=schemas/org.gnome.shell.extensions.claude-usage-watch.gschema.xml \
    --extra-source=stylesheet-dark.css \
    --extra-source=stylesheet-light.css \
    --extra-source=lib \
    --extra-source=ui \
    --extra-source=LICENSE \
    .
unzip -l claude-usage-watch@vdw.github.io.shell-extension.zip
