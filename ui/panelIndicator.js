// Top-bar indicator and dropdown.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {contractHome, credentialsDir} from '../lib/accounts.js';
import {hasData} from '../lib/snapshot.js';
import {formatClock, formatDuration} from '../lib/time.js';

const BAR_WIDTH = 140; // logical px; must match .cuw-bar-trough in stylesheet.css
const STALE_MENU_SECONDS = 60;
const REFRESH_DEBOUNCE_MS = 5000;
const EXPIRY_WARN_MS = 5 * 24 * 3600 * 1000;

const VERTICAL = {orientation: Clutter.Orientation.VERTICAL};
const DIM = 150; // opacity for secondary text; works on light and dark styles

function dim(actor, on = true) {
    actor.opacity = on ? DIM : 255;
    return actor;
}

function windowsOf(snap) {
    if (!snap)
        return [];
    return [snap.fiveHour, ...snap.weekly].filter(Boolean);
}

/** The number shown in the top bar for one account, or null. */
function panelPct(snap, metric) {
    if (!hasData(snap))
        return null;
    if (metric === 'max')
        return Math.max(...windowsOf(snap).map(w => w.pct));
    return snap.fiveHour?.pct ?? Math.max(...snap.weekly.map(w => w.pct));
}

function levelClass(pct, warn, crit) {
    if (pct >= crit)
        return 'cuw-crit';
    if (pct >= warn)
        return 'cuw-warn';
    return 'cuw-ok';
}

function fmtPct(pct) {
    return `${Math.round(pct)}%`;
}

const AccountItem = GObject.registerClass(
class AccountItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false, style_class: 'cuw-account'});

        this._box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'cuw-account-box'});
        this.add_child(this._box);

        const header = new St.BoxLayout({style_class: 'cuw-account-header'});
        this._title = new St.Label({style_class: 'cuw-account-title', x_expand: true});
        this._subtitle = dim(new St.Label({style_class: 'cuw-account-subtitle', y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(this._title);
        header.add_child(this._subtitle);
        this._box.add_child(header);

        this._rows = new St.BoxLayout({...VERTICAL, style_class: 'cuw-rows'});
        this._box.add_child(this._rows);

        this._notice = new St.Label({style_class: 'cuw-notice', visible: false});
        this._notice.clutter_text.line_wrap = true;
        this._box.add_child(this._notice);
    }

    _addRow(name, w, opts) {
        const row = new St.BoxLayout({style_class: 'cuw-row'});
        row.add_child(new St.Label({text: name, style_class: 'cuw-row-name', y_align: Clutter.ActorAlign.CENTER}));

        // A horizontal box packs the fill at the start of the trough.
        const trough = new St.BoxLayout({style_class: 'cuw-bar-trough', y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({
            style_class: `cuw-bar-fill ${levelClass(w.pct, opts.warn, opts.crit)}`,
            y_expand: true,
        });
        // CSS lengths follow the shell's scale factor; actor sizes would not.
        fill.set_style(`width: ${Math.round(BAR_WIDTH * Math.min(100, Math.max(0, w.pct)) / 100)}px;`);
        trough.add_child(fill);
        row.add_child(trough);

        row.add_child(new St.Label({text: fmtPct(w.pct), style_class: 'cuw-row-pct', y_align: Clutter.ActorAlign.CENTER}));

        let reset = '';
        if (w.resetsAt) {
            const left = w.resetsAt - opts.now;
            reset = left < 24 * 3600 * 1000
                ? `resets in ${formatDuration(left)}`
                : `resets ${formatClock(w.resetsAt, opts.use12h, opts.now)}`;
        } else if (w.resetText) {
            reset = `resets ${w.resetText}`;
        }
        row.add_child(dim(new St.Label({text: reset, style_class: 'cuw-row-reset', y_align: Clutter.ActorAlign.CENTER})));
        this._rows.add_child(row);
    }

    update(account, snap, opts) {
        this._title.text = account.label;
        this._rows.destroy_all_children();

        const dirHint = account.configDir
            ? `CLAUDE_CONFIG_DIR=${contractHome(credentialsDir(account.configDir, opts.home), opts.home)} `
            : '';
        const notices = [];
        let subtitle = '';

        if (!snap) {
            subtitle = 'Loading…';
        } else {
            if (snap.fiveHour)
                this._addRow('5 h', snap.fiveHour, opts);
            for (const w of snap.weekly)
                this._addRow(w.label === 'all models' ? 'Week' : `Week · ${w.label}`, w, opts);

            switch (snap.status) {
            case 'ok':
                break;
            case 'stale':
                subtitle = `stale since ${formatClock(snap.staleSince, opts.use12h, opts.now)}`;
                notices.push(`Last poll failed: ${snap.error}`);
                break;
            case 'logged-out':
                subtitle = 'Signed out';
                notices.push(`No subscription usage. Run: ${dirHint}claude auth login`);
                break;
            case 'no-credentials':
                subtitle = 'No credentials';
                notices.push(`${snap.error}. Check the folder in Preferences, or run: ${dirHint}claude auth login`);
                break;
            case 'cli-missing':
                subtitle = 'CLI not found';
                notices.push(snap.error);
                break;
            case 'timeout':
            case 'error':
            default:
                subtitle = 'Error';
                notices.push(snap.error ?? 'Unknown error');
            }

            const exp = snap.credentialExpiresAt;
            if (exp && hasData(snap)) {
                if (exp <= opts.now)
                    notices.push(`Sign-in expired. Run: ${dirHint}claude auth login`);
                else if (exp - opts.now < EXPIRY_WARN_MS)
                    notices.push(`Sign-in ends by ${formatClock(exp, opts.use12h, opts.now)} (in ${formatDuration(exp - opts.now)}). Run: ${dirHint}claude auth login`);
            }
        }

        this._subtitle.text = subtitle;
        this._notice.text = notices.join('\n');
        this._notice.visible = notices.length > 0;
        this._notice.style_class = snap && !hasData(snap) && snap.status !== 'ok' ? 'cuw-notice cuw-notice-error' : 'cuw-notice';
    }
});

export const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    /**
     * @param {object} opts
     * @param {Gio.Settings} opts.settings  the extension settings
     * @param {(id: string) => object|null} opts.getSnapshot
     * @param {() => number} opts.oldestFetch
     * @param {() => void} opts.onRefresh
     * @param {() => void} opts.onPreferences
     */
    _init({settings, getSnapshot, oldestFetch, onRefresh, onPreferences}) {
        super._init(0.5, 'Claude Usage Watch', false);
        this._settings = settings;
        this._getSnapshot = getSnapshot;
        this._oldestFetch = oldestFetch;
        this._onRefresh = onRefresh;
        this._accounts = [];
        this._items = new Map();
        this._busy = false;
        this._lastManualRefresh = 0;
        this._tickId = 0;
        this._home = GLib.get_home_dir();
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._panelBox = new St.BoxLayout({style_class: 'cuw-panel', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._panelBox);

        this._accountsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._accountsSection);

        this._emptyItem = new PopupMenu.PopupMenuItem('No accounts enabled. Add one in Preferences.', {reactive: false});
        this.menu.addMenuItem(this._emptyItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cuw-footer'});
        this._status = dim(new St.Label({style_class: 'cuw-footer-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        footer.add_child(this._status);

        this._refreshButton = new St.Button({
            style_class: 'icon-button cuw-footer-button',
            can_focus: true,
            accessible_name: 'Refresh now',
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        this._refreshButton.connect('clicked', () => this._manualRefresh());
        footer.add_child(this._refreshButton);

        const prefsButton = new St.Button({
            style_class: 'icon-button cuw-footer-button',
            can_focus: true,
            accessible_name: 'Preferences',
            child: new St.Icon({icon_name: 'preferences-system-symbolic'}),
        });
        prefsButton.connect('clicked', () => {
            this.menu.close();
            onPreferences();
        });
        footer.add_child(prefsButton);
        this.menu.addMenuItem(footer);

        this.menu.connectObject('open-state-changed', (_m, open) => this._onMenuToggled(open), this);
        this._settings.connectObject(
            'changed::display-mode', () => this._renderPanel(),
            'changed::panel-metric', () => this._renderPanel(),
            'changed::warn-threshold', () => this.renderAll(),
            'changed::crit-threshold', () => this.renderAll(),
            this);
        this._interfaceSettings.connectObject('changed::clock-format', () => this.renderAll(), this);

        this.renderAll();
    }

    setAccounts(accounts) {
        this._accounts = accounts.filter(a => a.enabled);
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        for (const a of this._accounts) {
            const item = new AccountItem();
            this._items.set(a.id, item);
            this._accountsSection.addMenuItem(item);
        }
        this._emptyItem.visible = this._accounts.length === 0;
        this.renderAll();
    }

    setBusy(busy) {
        this._busy = busy;
        this._renderFooter();
    }

    accountUpdated(_id) {
        // Panel ordering and "worst" depend on every account, so redraw all.
        this.renderAll();
    }

    _opts() {
        return {
            now: Date.now(),
            home: this._home,
            warn: this._settings.get_uint('warn-threshold'),
            crit: this._settings.get_uint('crit-threshold'),
            use12h: this._interfaceSettings.get_string('clock-format') === '12h',
        };
    }

    renderAll() {
        this._renderPanel();
        if (this.menu.isOpen)
            this._renderMenu();
        this._renderFooter();
    }

    _renderPanel() {
        this._panelBox.destroy_all_children();
        const {warn, crit} = this._opts();
        const metric = this._settings.get_string('panel-metric');

        let entries = this._accounts.map(a => {
            const snap = this._getSnapshot(a.id);
            return {account: a, snap, pct: panelPct(snap, metric)};
        });

        if (entries.length === 0) {
            this._panelBox.add_child(new St.Label({text: 'Claude', style_class: 'cuw-tag cuw-error', y_align: Clutter.ActorAlign.CENTER}));
            return;
        }

        if (this._settings.get_string('display-mode') === 'worst' && entries.length > 1) {
            const withData = entries.filter(e => e.pct !== null);
            const problem = entries.find(e => e.snap && !hasData(e.snap));
            if (withData.length)
                entries = [withData.reduce((a, b) => (b.pct > a.pct ? b : a))];
            else
                entries = [problem ?? entries[0]];
        }

        entries.forEach((e, i) => {
            if (i > 0)
                this._panelBox.add_child(dim(new St.Label({text: '·', style_class: 'cuw-sep', y_align: Clutter.ActorAlign.CENTER})));

            let text, cls;
            if (e.pct !== null) {
                text = `${e.account.shortTag} ${fmtPct(e.pct)}`;
                cls = levelClass(e.pct, warn, crit);
                if (e.snap.status === 'stale')
                    cls += ' cuw-stale';
            } else if (!e.snap) {
                text = `${e.account.shortTag} …`;
                cls = 'cuw-pending';
            } else {
                text = `${e.account.shortTag} !`;
                cls = 'cuw-error';
            }
            const label = new St.Label({text, style_class: `cuw-tag ${cls}`, y_align: Clutter.ActorAlign.CENTER});
            dim(label, cls.includes('cuw-stale') || cls === 'cuw-pending');
            this._panelBox.add_child(label);
        });
    }

    _renderMenu() {
        const opts = this._opts();
        for (const a of this._accounts)
            this._items.get(a.id)?.update(a, this._getSnapshot(a.id), opts);
    }

    _renderFooter() {
        if (this._busy) {
            this._status.text = 'Updating…';
        } else {
            const times = this._accounts
                .map(a => this._getSnapshot(a.id))
                .filter(Boolean)
                .map(s => s.lastAttemptAt ?? s.fetchedAt);
            this._status.text = times.length
                ? `Checked ${formatClock(Math.max(...times), this._opts().use12h)}`
                : '';
        }
        this._refreshButton.reactive = !this._busy;
        this._refreshButton.opacity = this._busy ? 128 : 255;
    }

    _manualRefresh() {
        const now = Date.now();
        if (this._busy || now - this._lastManualRefresh < REFRESH_DEBOUNCE_MS)
            return;
        this._lastManualRefresh = now;
        this._onRefresh();
    }

    _onMenuToggled(open) {
        if (open) {
            this._renderMenu();
            if (Date.now() - this._oldestFetch() > STALE_MENU_SECONDS * 1000)
                this._onRefresh();
            // Countdowns tick while the menu is open, without re-polling.
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
                this._renderMenu();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        this._settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this._interfaceSettings = null;
        this._items.clear();
        super.destroy();
    }
});
