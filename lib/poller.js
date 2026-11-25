// Polls every enabled account one after another, keeps the last good
// snapshot, and backs off on repeated failures.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {hasData, makeSnapshot} from './snapshot.js';

const TRANSIENT = new Set(['timeout', 'error']);
const MAX_BACKOFF_SECONDS = 30 * 60;

export class Poller {
    /**
     * @param {object} opts
     * @param {{fetchUsage: Function}} opts.provider
     * @param {number} opts.intervalSeconds
     * @param {(id: string, snapshot: object) => void} opts.onUpdate
     * @param {(busy: boolean) => void} [opts.onBusyChanged]
     * @param {number} [opts.minRefetchSeconds]  a non-forced cycle skips
     *   accounts fetched more recently than this (e.g. when one is added)
     */
    constructor({provider, intervalSeconds, onUpdate, onBusyChanged = () => {}, minRefetchSeconds = 30}) {
        this._minRefetchMs = minRefetchSeconds * 1000;
        this._provider = provider;
        this._interval = Math.max(60, intervalSeconds);
        this._onUpdate = onUpdate;
        this._onBusyChanged = onBusyChanged;
        this._accounts = [];
        this._states = new Map();
        this._cancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._cycle = null;
        this._destroyed = false;
    }

    get busy() {
        return this._cycle !== null;
    }

    getSnapshot(id) {
        return this._states.get(id)?.snapshot ?? null;
    }

    /** Oldest fetch time among enabled accounts; 0 if any has never been fetched. */
    oldestFetch() {
        let oldest = Infinity;
        for (const a of this._accounts) {
            const s = this.getSnapshot(a.id);
            oldest = Math.min(oldest, s ? s.lastAttemptAt ?? s.fetchedAt : 0);
        }
        return oldest === Infinity ? Date.now() : oldest;
    }

    setAccounts(accounts) {
        const enabled = accounts.filter(a => a.enabled);
        const added = [];
        for (const a of enabled) {
            const st = this._states.get(a.id);
            if (!st || st.configDir !== a.configDir) {
                this._states.set(a.id, {configDir: a.configDir, snapshot: null, failures: 0, nextAllowedAt: 0});
                added.push(a);
            }
        }
        for (const id of [...this._states.keys()]) {
            if (!enabled.some(a => a.id === id))
                this._states.delete(id);
        }
        this._accounts = enabled;
        if (added.length && !this._destroyed && this._started)
            this.refresh();
    }

    setInterval(seconds) {
        this._interval = Math.max(60, seconds);
        if (this._timerId)
            this._schedule();
    }

    start() {
        this._started = true;
        this.refresh();
    }

    /**
     * Run a cycle now, or join the one in flight. `force` ignores backoff.
     * @returns {Promise<void>}
     */
    refresh({force = false} = {}) {
        if (this._destroyed)
            return Promise.resolve();
        if (this._cycle)
            return this._cycle;

        this._removeTimer();
        this._onBusyChanged(true);
        this._cycle = this._runCycle(force)
            .catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`claude-usage-watch: poll cycle failed: ${e}`);
            })
            .finally(() => {
                this._cycle = null;
                if (this._destroyed)
                    return;
                this._schedule();
                this._onBusyChanged(false);
            });
        return this._cycle;
    }

    async _runCycle(force) {
        const done = new Set();
        for (;;) {
            if (this._destroyed)
                return;
            // Re-read the list each step, so accounts added mid-cycle are included.
            const account = this._accounts.find(a => !done.has(a.id));
            if (!account)
                return;
            done.add(account.id);

            const st = this._states.get(account.id);
            if (!force) {
                if (Date.now() < st.nextAllowedAt)
                    continue;
                const last = st.snapshot ? st.snapshot.lastAttemptAt ?? st.snapshot.fetchedAt : 0;
                if (Date.now() - last < this._minRefetchMs)
                    continue;
            }

            let snap;
            try {
                // eslint-disable-next-line no-await-in-loop
                snap = await this._provider.fetchUsage(account, this._cancellable);
            } catch (e) {
                if (this._cancellable.is_cancelled())
                    return;
                snap = makeSnapshot('error', {error: String(e?.message ?? e)});
            }
            if (this._destroyed)
                return;

            const current = this._states.get(account.id);
            if (current !== st || st.configDir !== account.configDir)
                continue; // removed or re-pointed while the CLI ran

            this._merge(st, snap);
            this._onUpdate(account.id, st.snapshot);
        }
    }

    _merge(st, snap) {
        if (!TRANSIENT.has(snap.status)) {
            st.failures = 0;
            st.nextAllowedAt = 0;
            st.snapshot = snap;
            return;
        }

        st.failures++;
        const prev = st.snapshot;
        if (hasData(prev)) {
            st.snapshot = {
                ...prev,
                status: 'stale',
                error: snap.error,
                staleSince: prev.staleSince ?? prev.fetchedAt,
                lastAttemptAt: snap.fetchedAt,
            };
        } else {
            st.snapshot = snap;
        }
        if (st.failures >= 2) {
            const wait = Math.min(this._interval * 2 ** (st.failures - 1), MAX_BACKOFF_SECONDS);
            st.nextAllowedAt = Date.now() + wait * 1000;
        }
    }

    _schedule() {
        this._removeTimer();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._timerId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _removeTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._removeTimer();
        this._cancellable.cancel();
        this._states.clear();
        this._accounts = [];
    }
}
