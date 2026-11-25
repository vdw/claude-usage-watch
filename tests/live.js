// Live check against the real CLI and real accounts.
// Usage: gjs -m tests/live.js [configDir ...]   ('' = default profile)
// With no arguments it uses the accounts from the extension's settings
// if the schema is installed, else the default profile and ~/.claude-work.

import GLib from 'gi://GLib';

import {CliProvider, findClaude} from '../lib/providers/cliProvider.js';

const args = ARGV.length ? ARGV : ['', '~/.claude-work'];
const workDir = `${GLib.get_user_cache_dir()}/claude-usage-watch`;
GLib.mkdir_with_parents(workDir, 0o700);

const claudePath = GLib.getenv('CLAUDE_PATH') ?? '';
const provider = new CliProvider({getClaudePath: () => claudePath, workDir,
    timeoutSeconds: Number(GLib.getenv('TIMEOUT') ?? 20)});
print(`claude: ${findClaude(claudePath)}`);

const loop = new GLib.MainLoop(null, false);
(async () => {
    for (const configDir of args) {
        const t0 = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const s = await provider.fetchUsage({id: configDir || 'default', configDir});
        print(`\n[${configDir || '(default)'}] ${Date.now() - t0} ms`);
        print(JSON.stringify(s, (k, v) =>
            /At$/.test(k) && typeof v === 'number' ? new Date(v).toISOString() : v, 2));
    }
    loop.quit();
})();
loop.run();
