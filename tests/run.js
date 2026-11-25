// Unit tests. Run from the repo root: gjs -m tests/run.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAccounts, serializeAccounts, credentialsDir, guessLabel, expandHome, contractHome} from '../lib/accounts.js';
import {parseEnvelope, parseResetString, parseUsageText, stripAnsi} from '../lib/parsers/usageParser.js';
import {resolveReset, formatDuration} from '../lib/time.js';
import {buildSnapshot, makeSnapshot} from '../lib/snapshot.js';
import {Poller} from '../lib/poller.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fixture = name => {
    const [, bytes] = GLib.file_get_contents(`${here}/fixtures/${name}`);
    return new TextDecoder().decode(bytes);
};

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function eq(actual, expected, msg = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg} expected ${e}, got ${a}`);
}
function ok(cond, msg) {
    if (!cond)
        throw new Error(msg ?? 'assertion failed');
}

// 2026-11-25 14:30 in Athens (UTC+2), around when the fixtures were captured.
const NOW = Date.UTC(2026, 10, 25, 12, 30);

// --- reset strings ---------------------------------------------------------

test('reset: date + time with minutes + zone', () => {
    eq(parseResetString('Nov 25, 3:20pm (Europe/Athens)'),
        {month: 11, day: 25, hour: 15, minute: 20, zone: 'Europe/Athens'});
});
test('reset: hour only', () => {
    eq(parseResetString('4pm (Europe/Athens)'),
        {month: null, day: null, hour: 16, minute: 0, zone: 'Europe/Athens'});
});
test('reset: 12am / 12pm', () => {
    eq(parseResetString('12am').hour, 0);
    eq(parseResetString('12pm').hour, 12);
    eq(parseResetString('12:30 a.m.').hour, 0);
});
test('reset: 24h with "at"', () => {
    eq(parseResetString('Nov 29 at 21:00'), {month: 11, day: 29, hour: 21, minute: 0, zone: null});
});
test('reset: relative', () => {
    eq(parseResetString('in 2h 13m'), {relativeMs: (2 * 60 + 13) * 60000});
    eq(parseResetString('in 3 days'), {relativeMs: 3 * 86400000});
});
test('reset: garbage', () => {
    eq(parseResetString('soon'), null);
    eq(parseResetString('Foo 3, 4pm'), null);
    eq(parseResetString('25pm'), null);
});

test('resolve: Athens date', () => {
    eq(resolveReset(parseResetString('Nov 25, 3:20pm (Europe/Athens)'), NOW), Date.UTC(2026, 10, 25, 13, 20));
    eq(resolveReset(parseResetString('Nov 29, 9pm (Europe/Athens)'), NOW), Date.UTC(2026, 10, 29, 19, 0));
});
test('resolve: time-only today / tomorrow', () => {
    eq(resolveReset(parseResetString('4pm (Europe/Athens)'), NOW), Date.UTC(2026, 10, 25, 14, 0));
    eq(resolveReset(parseResetString('9am (Europe/Athens)'), NOW), Date.UTC(2026, 10, 26, 7, 0));
});
test('resolve: year rollover', () => {
    const dec31 = Date.UTC(2026, 11, 31, 12, 0);
    eq(resolveReset(parseResetString('Jan 2, 9am (UTC)'), dec31), Date.UTC(2027, 0, 2, 9, 0));
});
test('resolve: just-passed date stays this year', () => {
    eq(resolveReset(parseResetString('Nov 25, 2pm (Europe/Athens)'), NOW), Date.UTC(2026, 10, 25, 12, 0));
});
test('resolve: unknown zone falls back to local', () => {
    ok(resolveReset(parseResetString('Nov 29, 9pm (Not/AZone)'), NOW) !== null);
});

test('formatDuration', () => {
    eq(formatDuration(0), 'now');
    eq(formatDuration(30000), '<1m');
    eq(formatDuration(72 * 60000), '1h 12m');
    eq(formatDuration((2 * 24 * 60 + 61) * 60000), '2d 1h');
    eq(formatDuration(59 * 60000 + 1), '1h 0m');
});

// --- envelope & text ------------------------------------------------------

test('envelope: clean JSON', () => {
    eq(parseEnvelope(fixture('personal-ok.json')).local_command, 'usage');
});
test('envelope: noise before JSON', () => {
    eq(parseEnvelope(fixture('edge-noisy.txt')).local_command, 'usage');
});
test('envelope: none', () => {
    eq(parseEnvelope(fixture('edge-garbage.txt')), null);
    eq(parseEnvelope(''), null);
    eq(parseEnvelope('[1,2]'), null);
});
test('stripAnsi', () => {
    eq(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
});
test('text: plain-text fixture parses the same as JSON', () => {
    const t = parseUsageText(fixture('personal-ok.txt'));
    eq(t.fiveHour.pct, 13);
    eq(t.weekly.map(w => [w.label, w.pct]), [['all models', 8]]);
});

// --- snapshots ------------------------------------------------------------

const snap = (name, exitStatus = 0) =>
    buildSnapshot({stdout: fixture(name), stderr: '', exitStatus, nowMs: NOW});

test('snapshot: personal ok', () => {
    const s = snap('personal-ok.json');
    eq(s.status, 'ok');
    eq(s.fiveHour.pct, 13);
    eq(s.fiveHour.resetsAt, Date.UTC(2026, 10, 25, 13, 20));
    eq(s.weekly.length, 1);
    eq(s.weekly[0].pct, 8);
    eq(s.weekly[0].resetsAt, Date.UTC(2026, 10, 29, 19, 0));
    eq(s.credentialExpiresAt, Date.parse('2026-11-30T07:59:15.192Z'));
});
test('snapshot: work ok', () => {
    const s = snap('work-ok.json');
    eq(s.status, 'ok');
    eq([s.fiveHour.pct, s.weekly[0].pct], [15, 2]);
    eq(s.fiveHour.resetsAt, Date.UTC(2026, 10, 25, 14, 0));
});
test('snapshot: logged out', () => {
    const s = snap('logged-out.json');
    eq(s.status, 'logged-out');
    eq(s.fiveHour, null);
    eq(s.credentialExpiresAt, null);
});
test('snapshot: 100%, extra weekly line, decimals', () => {
    const s = snap('edge-full.json');
    eq(s.status, 'ok');
    eq(s.fiveHour.pct, 100);
    eq(s.weekly.map(w => [w.label, w.pct]), [['all models', 91], ['Opus', 45.5]]);
    eq(s.weekly[0].resetsAt, Date.UTC(2026, 0, 2, 7, 0) + 365 * 86400000);
});
test('snapshot: missing reset', () => {
    const s = snap('edge-no-reset.json');
    eq(s.fiveHour.pct, 0);
    eq(s.fiveHour.resetsAt, null);
    ok(s.weekly[0].resetsAt > NOW);
});
test('snapshot: is_error envelope', () => {
    const s = snap('edge-is-error.json');
    eq(s.status, 'error');
    ok(s.error.includes('401'), s.error);
});
test('snapshot: unknown text', () => {
    eq(snap('edge-unknown.json').status, 'error');
});
test('snapshot: garbage + nonzero exit', () => {
    const s = snap('edge-garbage.txt', 5);
    eq(s.status, 'error');
    ok(s.error.includes('exited with 5'), s.error);
});

// --- accounts -------------------------------------------------------------

test('accounts: parse/normalize', () => {
    const list = parseAccounts('[{"id":"x","label":" Work ","configDir":"~/.claude-work"},{"id":"x"},42,null]');
    eq(list.length, 2);
    eq(list[0], {id: 'x', label: 'Work', shortTag: 'W', configDir: '~/.claude-work', enabled: true});
    ok(list[1].id !== 'x', 'duplicate id replaced');
    eq(parseAccounts('not json'), []);
    eq(parseAccounts('{}'), []);
    eq(parseAccounts(serializeAccounts(list)), list);
});
test('accounts: paths', () => {
    eq(credentialsDir('', '/home/u'), '/home/u/.claude');
    eq(credentialsDir('~/.claude-work/', '/home/u'), '/home/u/.claude-work');
    eq(expandHome('~', '/home/u'), '/home/u');
    eq(contractHome('/home/u/.claude-work', '/home/u'), '~/.claude-work');
    eq(guessLabel('.claude-work'), {label: 'Work', shortTag: 'W'});
    eq(guessLabel('.claude'), {label: 'Personal', shortTag: 'P'});
    eq(guessLabel('.claude-side-gig'), {label: 'Side Gig', shortTag: 'S'});
});

// --- poller (async, fake provider) ----------------------------------------

function fakeProvider(script) {
    const calls = [];
    let running = 0, maxRunning = 0;
    return {
        calls,
        get maxRunning() {
            return maxRunning;
        },
        fetchUsage(account, cancellable) {
            calls.push(account.id);
            running++;
            maxRunning = Math.max(maxRunning, running);
            const next = script[account.id].shift() ?? 'ok';
            return new Promise((resolve, reject) => {
                let cancelId = 0;
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                    running--;
                    cancellable.disconnect(cancelId);
                    resolve(next === 'ok'
                        ? makeSnapshot('ok', {fiveHour: {label: 'session', pct: 10, resetsAt: null}})
                        : makeSnapshot(next, {error: next}));
                    return GLib.SOURCE_REMOVE;
                });
                cancelId = cancellable.connect(() => {
                    GLib.Source.remove(id);
                    running--;
                    reject(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'cancelled'));
                });
            });
        },
    };
}

const accts = [
    {id: 'p', label: 'P', shortTag: 'P', configDir: '', enabled: true},
    {id: 'w', label: 'W', shortTag: 'W', configDir: '~/.w', enabled: true},
    {id: 'off', label: 'O', shortTag: 'O', configDir: '~/.o', enabled: false},
];

test('poller: sequential, joins, skips disabled', async () => {
    const prov = fakeProvider({p: [], w: []});
    const updates = [];
    const poller = new Poller({provider: prov, intervalSeconds: 300, minRefetchSeconds: 0, onUpdate: id => updates.push(id)});
    poller.setAccounts(accts);
    const a = poller.refresh();
    const b = poller.refresh({force: true});
    ok(a === b, 'second refresh joins the first');
    await a;
    eq(prov.calls, ['p', 'w']);
    eq(prov.maxRunning, 1);
    eq(updates, ['p', 'w']);
    poller.destroy();
});

test('poller: stale keeps numbers, backoff, recovery, auth replaces', async () => {
    const prov = fakeProvider({p: ['ok', 'timeout', 'error', 'error', 'ok', 'logged-out'], w: []});
    const poller = new Poller({provider: prov, intervalSeconds: 300, minRefetchSeconds: 0, onUpdate: () => {}});
    poller.setAccounts(accts.slice(0, 1));
    await poller.refresh();
    eq(poller.getSnapshot('p').status, 'ok');
    await poller.refresh();
    let s = poller.getSnapshot('p');
    eq([s.status, s.fiveHour.pct, s.error], ['stale', 10, 'timeout']);
    await poller.refresh();
    ok(poller._states.get('p').nextAllowedAt > Date.now(), 'backoff after 2 failures');
    const before = prov.calls.length;
    await poller.refresh();
    eq(prov.calls.length, before, 'skipped during backoff');
    await poller.refresh({force: true});
    eq(prov.calls.length, before + 1, 'force ignores backoff');
    await poller.refresh({force: true});
    eq(poller.getSnapshot('p').status, 'ok');
    eq(poller._states.get('p').failures, 0);
    await poller.refresh();
    s = poller.getSnapshot('p');
    eq([s.status, s.fiveHour], ['logged-out', null]);
    poller.destroy();
});

test('poller: error without previous data is shown as error', async () => {
    const prov = fakeProvider({p: ['timeout']});
    const poller = new Poller({provider: prov, intervalSeconds: 300, minRefetchSeconds: 0, onUpdate: () => {}});
    poller.setAccounts(accts.slice(0, 1));
    await poller.refresh();
    eq(poller.getSnapshot('p').status, 'timeout');
    poller.destroy();
});

test('poller: destroy mid-cycle cancels and stops', async () => {
    const prov = fakeProvider({p: [], w: []});
    const updates = [];
    const poller = new Poller({provider: prov, intervalSeconds: 300, minRefetchSeconds: 0, onUpdate: id => updates.push(id)});
    poller.setAccounts(accts);
    const cycle = poller.refresh();
    poller.destroy();
    await cycle;
    eq(prov.calls, ['p']);
    eq(updates, []);
    eq(poller._timerId, 0);
});

test('poller: non-forced cycle skips recently fetched accounts', async () => {
    const prov = fakeProvider({p: [], w: []});
    const poller = new Poller({provider: prov, intervalSeconds: 300, onUpdate: () => {}});
    poller.setAccounts(accts.slice(0, 1));
    await poller.refresh();
    poller.setAccounts(accts);
    await poller.refresh();
    eq(prov.calls, ['p', 'w'], 'only the new account is fetched');
    await poller.refresh({force: true});
    eq(prov.calls, ['p', 'w', 'p', 'w']);
    poller.destroy();
});

// --- runner ---------------------------------------------------------------

const loop = new GLib.MainLoop(null, false);
(async () => {
    for (const [name, fn] of tests) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await fn();
            passed++;
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`\n${passed} passed, ${failed} failed`);
    loop.quit();
})();
loop.run();
if (failed)
    imports.system.exit(1);
