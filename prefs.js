// Claude Usage Watch: preferences window.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    contractHome, credentialsDir, expandHome, guessLabel, newAccountId,
    parseAccounts, serializeAccounts,
} from './lib/accounts.js';

const HOME = GLib.get_home_dir();

function hasCredentials(configDir) {
    return GLib.file_test(`${credentialsDir(configDir, HOME)}/.credentials.json`, GLib.FileTest.IS_REGULAR);
}

function dirLabel(configDir) {
    return configDir ? contractHome(expandHome(configDir, HOME), HOME) : 'Default (~/.claude)';
}

/** Config dirs in ~ named .claude or .claude-* that hold credentials. */
function detectConfigDirs() {
    const found = [];
    const home = Gio.File.new_for_path(HOME);
    let en;
    try {
        en = home.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return found;
    }
    let info;
    while ((info = en.next_file(null))) {
        const name = info.get_name();
        if (info.get_file_type() !== Gio.FileType.DIRECTORY || !/^\.claude([-_.].+)?$/.test(name))
            continue;
        const configDir = name === '.claude' ? '' : `~/${name}`;
        if (hasCredentials(configDir))
            found.push({name, configDir});
    }
    en.close(null);
    found.sort((a, b) => a.name.localeCompare(b.name));
    return found;
}

function iconButton(iconName, tooltip, onClick) {
    const b = new Gtk.Button({icon_name: iconName, tooltip_text: tooltip, valign: Gtk.Align.CENTER});
    b.add_css_class('flat');
    b.connect('clicked', onClick);
    return b;
}

export default class ClaudeUsageWatchPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._accounts = parseAccounts(this._settings.get_string('accounts'));
        this._rows = [];
        this._expanded = new Set();
        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({title: 'Claude Usage Watch', icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        this._accountsGroup = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'One entry per Claude Code profile. The folder is what CLAUDE_CONFIG_DIR points to; leave it as Default for the plain claude command.',
        });
        const headerBox = new Gtk.Box({spacing: 6});
        const detect = new Gtk.Button({label: 'Detect', tooltip_text: 'Find ~/.claude and ~/.claude-* folders that are signed in', valign: Gtk.Align.CENTER});
        detect.connect('clicked', () => this._detect());
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: 'Add account', valign: Gtk.Align.CENTER});
        add.connect('clicked', () => this._addAccount());
        headerBox.append(detect);
        headerBox.append(add);
        this._accountsGroup.set_header_suffix(headerBox);
        page.add(this._accountsGroup);

        page.add(this._buildDisplayGroup());
        page.add(this._buildGeneralGroup());

        this._rebuildAccounts();

        // Another prefs window or dconf may change the list underneath us.
        const id = this._settings.connect('changed::accounts', () => {
            if (this._settings.get_string('accounts') === serializeAccounts(this._accounts))
                return;
            this._accounts = parseAccounts(this._settings.get_string('accounts'));
            this._rebuildAccounts();
        });
        window.connect('close-request', () => {
            this._settings.disconnect(id);
            return false;
        });
    }

    // --- accounts ---------------------------------------------------------

    _save() {
        this._settings.set_string('accounts', serializeAccounts(this._accounts));
    }

    _rebuildAccounts() {
        for (const row of this._rows)
            this._accountsGroup.remove(row);
        this._rows = [];

        if (this._accounts.length === 0) {
            const empty = new Adw.ActionRow({title: 'No accounts', subtitle: 'Use Detect or + to add one.'});
            this._accountsGroup.add(empty);
            this._rows.push(empty);
            return;
        }

        this._accounts.forEach((account, index) => {
            const row = this._buildAccountRow(account, index);
            this._accountsGroup.add(row);
            this._rows.push(row);
        });
    }

    _buildAccountRow(account, index) {
        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(account.label, -1),
            expanded: this._expanded.has(account.id),
        });
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(account.id);
            else
                this._expanded.delete(account.id);
        });

        const updateSubtitle = () => {
            const ok = hasCredentials(account.configDir);
            row.subtitle = GLib.markup_escape_text(
                `${account.shortTag} · ${dirLabel(account.configDir)}${ok ? '' : ' · no credentials found'}`, -1);
            warn.visible = !ok;
        };

        const warn = new Gtk.Image({icon_name: 'dialog-warning-symbolic', tooltip_text: 'No .credentials.json in this folder. Run claude auth login with this profile.'});
        warn.add_css_class('warning');
        row.add_suffix(warn);

        const toggle = new Gtk.Switch({active: account.enabled, valign: Gtk.Align.CENTER, tooltip_text: 'Show this account'});
        toggle.connect('notify::active', () => {
            account.enabled = toggle.active;
            this._save();
        });
        row.add_suffix(toggle);

        const label = new Adw.EntryRow({title: 'Label', text: account.label, show_apply_button: true});
        label.connect('apply', () => {
            account.label = label.text.trim() || 'Account';
            row.title = GLib.markup_escape_text(account.label, -1);
            this._save();
        });
        row.add_row(label);

        const tag = new Adw.EntryRow({title: 'Top-bar tag (up to 4 characters)', text: account.shortTag, show_apply_button: true, max_length: 4});
        tag.connect('apply', () => {
            account.shortTag = tag.text.trim() || account.label.charAt(0).toUpperCase();
            tag.text = account.shortTag;
            updateSubtitle();
            this._save();
        });
        row.add_row(tag);

        const folder = new Adw.ActionRow({title: 'Config folder', subtitle: GLib.markup_escape_text(dirLabel(account.configDir), -1)});
        const setDir = configDir => {
            account.configDir = configDir;
            folder.subtitle = GLib.markup_escape_text(dirLabel(configDir), -1);
            updateSubtitle();
            this._save();
        };
        folder.add_suffix(iconButton('folder-open-symbolic', 'Choose folder', () => this._chooseFolder(account, setDir)));
        folder.add_suffix(iconButton('edit-clear-symbolic', 'Use the default profile (~/.claude)', () => setDir('')));
        row.add_row(folder);

        const actions = new Adw.ActionRow({title: 'Order'});
        const up = iconButton('go-up-symbolic', 'Move up', () => this._move(index, -1));
        const down = iconButton('go-down-symbolic', 'Move down', () => this._move(index, 1));
        up.sensitive = index > 0;
        down.sensitive = index < this._accounts.length - 1;
        const del = new Gtk.Button({label: 'Remove', valign: Gtk.Align.CENTER});
        del.add_css_class('destructive-action');
        del.connect('clicked', () => {
            this._accounts.splice(index, 1);
            this._save();
            this._rebuildAccounts();
        });
        actions.add_suffix(up);
        actions.add_suffix(down);
        actions.add_suffix(del);
        row.add_row(actions);

        updateSubtitle();
        return row;
    }

    _chooseFolder(account, setDir) {
        const dialog = new Gtk.FileDialog({title: 'Choose a Claude config folder', modal: true});
        const start = credentialsDir(account.configDir, HOME);
        const startFile = Gio.File.new_for_path(GLib.file_test(start, GLib.FileTest.IS_DIR) ? start : HOME);
        dialog.set_initial_folder(startFile);
        dialog.select_folder(this._window, null, (d, res) => {
            let file;
            try {
                file = d.select_folder_finish(res);
            } catch {
                return; // dismissed
            }
            const path = file?.get_path();
            if (!path)
                return;
            // ~/.claude is the default profile; keep CLAUDE_CONFIG_DIR unset for it.
            setDir(path === `${HOME}/.claude` ? '' : contractHome(path, HOME));
        });
    }

    _move(index, delta) {
        const to = index + delta;
        if (to < 0 || to >= this._accounts.length)
            return;
        const [a] = this._accounts.splice(index, 1);
        this._accounts.splice(to, 0, a);
        this._save();
        this._rebuildAccounts();
    }

    _addAccount() {
        const id = newAccountId();
        this._accounts.push({id, label: 'New account', shortTag: 'N', configDir: '', enabled: true});
        this._expanded.add(id);
        this._save();
        this._rebuildAccounts();
    }

    _detect() {
        const have = new Set(this._accounts.map(a => credentialsDir(a.configDir, HOME)));
        const used = new Set(this._accounts.map(a => a.shortTag));
        let added = 0;
        for (const {name, configDir} of detectConfigDirs()) {
            if (have.has(credentialsDir(configDir, HOME)))
                continue;
            const guess = guessLabel(name);
            let tag = guess.shortTag;
            for (let n = 2; used.has(tag); n++)
                tag = `${guess.shortTag}${n}`;
            used.add(tag);
            this._accounts.push({id: newAccountId(), label: guess.label, shortTag: tag, configDir, enabled: true});
            added++;
        }
        this._window.add_toast(new Adw.Toast({
            title: added ? `Added ${added} account${added > 1 ? 's' : ''}` : 'No new signed-in profiles found',
            timeout: 3,
        }));
        if (added) {
            this._save();
            this._rebuildAccounts();
        }
    }

    // --- display & general -----------------------------------------------

    _buildDisplayGroup() {
        const group = new Adw.PreferencesGroup({title: 'Top bar'});

        const mode = new Adw.ComboRow({
            title: 'Show',
            model: Gtk.StringList.new(['Every account', 'Only the highest']),
            selected: this._settings.get_string('display-mode') === 'worst' ? 1 : 0,
        });
        mode.connect('notify::selected', () =>
            this._settings.set_string('display-mode', mode.selected === 1 ? 'worst' : 'all'));
        group.add(mode);

        const metric = new Adw.ComboRow({
            title: 'Number',
            subtitle: 'The dropdown always shows every limit',
            model: Gtk.StringList.new(['5-hour session', 'Highest of 5-hour and weekly']),
            selected: this._settings.get_string('panel-metric') === 'max' ? 1 : 0,
        });
        metric.connect('notify::selected', () =>
            this._settings.set_string('panel-metric', metric.selected === 1 ? 'max' : 'session'));
        group.add(metric);

        for (const [key, title] of [['warn-threshold', 'Warning at (%)'], ['crit-threshold', 'Critical at (%)']]) {
            const spin = Adw.SpinRow.new_with_range(1, 100, 1);
            spin.title = title;
            this._settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(spin);
        }
        return group;
    }

    _buildGeneralGroup() {
        const group = new Adw.PreferencesGroup({title: 'General'});

        const interval = Adw.SpinRow.new_with_range(1, 60, 1);
        interval.title = 'Poll every (minutes)';
        interval.subtitle = 'Each poll runs claude once per account. It uses no tokens.';
        interval.value = Math.round(this._settings.get_uint('poll-interval') / 60);
        interval.connect('notify::value', () =>
            this._settings.set_uint('poll-interval', Math.round(interval.value) * 60));
        group.add(interval);

        const path = new Adw.EntryRow({
            title: 'claude binary (empty = search PATH and ~/.local/bin)',
            text: this._settings.get_string('claude-path'),
            show_apply_button: true,
        });
        path.connect('apply', () => this._settings.set_string('claude-path', path.text.trim()));
        const test = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        test.connect('clicked', () => this._testBinary(path.text.trim()));
        path.add_suffix(test);
        group.add(path);

        return group;
    }

    _testBinary(override) {
        const candidates = override
            ? [expandHome(override, HOME)]
            : [GLib.find_program_in_path('claude'), `${HOME}/.local/bin/claude`].filter(Boolean);
        const bin = candidates.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ??
            (override && !override.includes('/') ? GLib.find_program_in_path(override) : null);

        const toast = title => this._window.add_toast(new Adw.Toast({title: GLib.markup_escape_text(title, -1), timeout: 4}));
        if (!bin) {
            toast(override ? `Not executable: ${override}` : 'claude not found in PATH or ~/.local/bin');
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new([bin, '--version'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            toast(`Could not run ${bin}: ${e.message}`);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                toast(`${contractHome(bin, HOME)}: ${(out ?? '').trim().split('\n')[0]}`);
            } catch (e) {
                toast(`Error: ${e.message}`);
            }
        });
    }
}
