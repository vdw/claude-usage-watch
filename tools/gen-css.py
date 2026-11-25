#!/usr/bin/env python3
"""Generate the extension stylesheets from tools/stylesheet.css.in.

GNOME Shell loads one of stylesheet-dark.css / stylesheet-light.css by style
variant and reloads it when the colour scheme changes, but only if a
variant file was loaded; stylesheet.css is the fallback. Each output is
complete. Run from the repo root."""
import pathlib

VARIANTS = {
    'stylesheet-dark.css': {'WARN': '#f8e45c', 'CRIT': '#ff7b63', 'ACCENT': '#62a0ea'},
    'stylesheet-light.css': {'WARN': '#b07800', 'CRIT': '#c01c28', 'ACCENT': '#3584e4'},
    'stylesheet.css': {'WARN': '#f8e45c', 'CRIT': '#ff7b63', 'ACCENT': '#62a0ea'},
}

# The top bar is dark in both styles.
for colors in VARIANTS.values():
    colors.update(PANEL_WARN='#f8e45c', PANEL_CRIT='#ff7b63')

template = pathlib.Path('tools/stylesheet.css.in').read_text()
for name, colors in VARIANTS.items():
    out = template
    for key, value in colors.items():
        out = out.replace(f'@{key}@', value)
    pathlib.Path(name).write_text(out)
