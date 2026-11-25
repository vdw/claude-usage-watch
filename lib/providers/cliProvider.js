// Fetches usage by running `claude -p … /usage` once per account.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {credentialsDir, expandHome} from '../accounts.js';
import {buildSnapshot, makeSnapshot} from '../snapshot.js';

const FALLBACK_PATHS = [
    '~/.local/bin/claude',
    '~/.claude/local/claude',
    '~/.npm-global/bin/claude',
    '~/.bun/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
];

function isExecutable(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR) &&
        GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}

/**
 * Find the claude binary. Looked up on every poll, because ~/.local/bin/claude
 * is a symlink that moves when Claude Code updates itself.
 */
export function findClaude(overridePath) {
    const home = GLib.get_home_dir();
    if (overridePath) {
        const p = expandHome(overridePath, home);
        if (p.includes('/'))
            return isExecutable(p) ? p : null;
        return GLib.find_program_in_path(p);
    }
    const inPath = GLib.find_program_in_path('claude');
    if (inPath)
        return inPath;
    for (const candidate of FALLBACK_PATHS) {
        const p = expandHome(candidate, home);
        if (isExecutable(p))
            return p;
    }
    return null;
}

function communicate(proc, cancellable) {
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class CliProvider {
    /**
     * @param {object} opts
     * @param {() => string} opts.getClaudePath  override from settings ('' = auto)
     * @param {string} opts.workDir  cwd for the CLI; must exist
     * @param {number} [opts.timeoutSeconds]
     */
    constructor({getClaudePath, workDir, timeoutSeconds = 20}) {
        this._getClaudePath = getClaudePath;
        this._workDir = workDir;
        this._timeoutSeconds = timeoutSeconds;
    }

    /**
     * @returns {Promise<object>} a UsageSnapshot. Throws only when
     *   `cancellable` is cancelled.
     */
    async fetchUsage(account, cancellable) {
        const home = GLib.get_home_dir();

        const claude = findClaude(this._getClaudePath());
        if (!claude) {
            return makeSnapshot('cli-missing', {
                error: 'claude CLI not found. Set its path in Preferences.',
            });
        }

        // The CLI creates a missing config dir, so check before running it.
        const dir = credentialsDir(account.configDir, home);
        if (!GLib.file_test(`${dir}/.credentials.json`, GLib.FileTest.IS_REGULAR)) {
            return makeSnapshot('no-credentials', {
                error: `No .credentials.json in ${dir}`,
            });
        }

        const launcher = new Gio.SubprocessLauncher({
            // stdin is /dev/null when no STDIN flag is given.
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.set_cwd(this._workDir);
        // The default profile keeps state in ~/.claude.json; setting the
        // variable to ~/.claude would point the CLI somewhere else.
        if (account.configDir)
            launcher.setenv('CLAUDE_CONFIG_DIR', dir, true);
        else
            launcher.unsetenv('CLAUDE_CONFIG_DIR');
        launcher.setenv('DISABLE_AUTOUPDATER', '1', true);
        launcher.setenv('NO_COLOR', '1', true);

        const cliArgs = [
            claude, '-p',
            '--no-session-persistence',
            '--setting-sources', '',
            '--output-format', 'json',
            '/usage',
        ];
        // coreutils `timeout` runs the CLI in its own process group and kills
        // the whole group, so no grandchild survives a hang. Without it we
        // can only kill the direct child.
        const timeoutBin = GLib.find_program_in_path('timeout');
        const argv = timeoutBin
            ? [timeoutBin, '--kill-after=3', `${this._timeoutSeconds}s`, ...cliArgs]
            : cliArgs;

        let proc;
        try {
            proc = launcher.spawnv(argv);
        } catch (e) {
            return makeSnapshot('error', {error: `Could not start claude: ${e.message}`});
        }

        const inner = new Gio.Cancellable();
        const stop = () => {
            // SIGTERM reaches `timeout`, which forwards it to the group.
            if (timeoutBin)
                proc.send_signal(15);
            else
                proc.force_exit();
            inner.cancel();
        };

        // Backstop in case `timeout` is missing or itself hangs.
        let timedOut = false;
        const backstop = this._timeoutSeconds + (timeoutBin ? 5 : 0);
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, backstop, () => {
            timedOut = true;
            proc.force_exit();
            inner.cancel();
            return GLib.SOURCE_REMOVE;
        });

        let cancelId = 0;
        if (cancellable) {
            if (cancellable.is_cancelled())
                stop();
            else
                // Gio.Cancellable.connect() is g_cancellable_connect(), not GObject.connect().
                cancelId = cancellable.connect(stop);
        }

        const timeoutSnapshot = () => makeSnapshot('timeout', {
            error: `claude did not answer within ${this._timeoutSeconds} s`,
        });

        let out;
        try {
            out = await communicate(proc, inner);
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            if (timedOut)
                return timeoutSnapshot();
            return makeSnapshot('error', {error: e.message});
        } finally {
            if (!timedOut)
                GLib.Source.remove(timeoutId);
            if (cancelId)
                cancellable.disconnect(cancelId);
        }

        const exitStatus = proc.get_if_exited() ? proc.get_exit_status() : -1;
        // 124: `timeout` fired; 137: it had to SIGKILL after --kill-after.
        if (timeoutBin && (exitStatus === 124 || exitStatus === 137))
            return timeoutSnapshot();
        return buildSnapshot({stdout: out.stdout, stderr: out.stderr, exitStatus});
    }
}
