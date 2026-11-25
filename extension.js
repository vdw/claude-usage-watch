// Claude Usage Watch: entry point.

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {parseAccounts} from './lib/accounts.js';
import {Poller} from './lib/poller.js';
import {CliProvider} from './lib/providers/cliProvider.js';
import {PanelIndicator} from './ui/panelIndicator.js';

export default class ClaudeUsageWatchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        const workDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage-watch']);
        GLib.mkdir_with_parents(workDir, 0o700);

        const provider = new CliProvider({
            getClaudePath: () => this._settings.get_string('claude-path').trim(),
            workDir,
        });

        this._poller = new Poller({
            provider,
            intervalSeconds: this._settings.get_uint('poll-interval'),
            onUpdate: id => this._indicator?.accountUpdated(id),
            onBusyChanged: busy => this._indicator?.setBusy(busy),
        });

        this._indicator = new PanelIndicator({
            settings: this._settings,
            getSnapshot: id => this._poller.getSnapshot(id),
            oldestFetch: () => this._poller.oldestFetch(),
            onRefresh: () => this._poller.refresh({force: true}),
            onPreferences: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings.connectObject(
            'changed::accounts', () => this._applyAccounts(),
            'changed::poll-interval', () => this._poller.setInterval(this._settings.get_uint('poll-interval')),
            'changed::claude-path', () => this._poller.refresh({force: true}),
            this);

        this._applyAccounts();
        this._poller.start();
    }

    _applyAccounts() {
        const accounts = parseAccounts(this._settings.get_string('accounts'));
        // Poller first, so the indicator renders with the new state map.
        this._poller.setAccounts(accounts);
        this._indicator.setAccounts(accounts);
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._poller?.destroy();
        this._poller = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
