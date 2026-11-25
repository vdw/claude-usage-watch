// Account list helpers. Pure: no gi:// imports, so prefs, the shell and the
// tests can all use it.

export const DEFAULT_ACCOUNTS = Object.freeze([
    {id: 'personal', label: 'Personal', shortTag: 'P', configDir: '', enabled: true},
]);

export function newAccountId() {
    return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeOne(raw, usedIds) {
    if (!raw || typeof raw !== 'object')
        return null;

    const label = typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim() : 'Account';
    let shortTag = typeof raw.shortTag === 'string' ? raw.shortTag.trim() : '';
    if (!shortTag)
        shortTag = label.charAt(0).toUpperCase();

    let id = typeof raw.id === 'string' && raw.id ? raw.id : newAccountId();
    while (usedIds.has(id))
        id = newAccountId();
    usedIds.add(id);

    return {
        id,
        label,
        shortTag: shortTag.slice(0, 4),
        configDir: typeof raw.configDir === 'string' ? raw.configDir.trim() : '',
        enabled: raw.enabled !== false,
    };
}

/** Parse the `accounts` setting. Bad JSON or bad entries never throw. */
export function parseAccounts(json) {
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];

    const used = new Set();
    return list.map(a => normalizeOne(a, used)).filter(Boolean);
}

export function serializeAccounts(accounts) {
    return JSON.stringify(accounts.map(a => ({
        id: a.id,
        label: a.label,
        shortTag: a.shortTag,
        configDir: a.configDir,
        enabled: a.enabled,
    })));
}

/** Expand a leading `~` or `~/`. */
export function expandHome(path, home) {
    if (path === '~')
        return home;
    if (path.startsWith('~/'))
        return `${home}${path.slice(1)}`;
    return path;
}

/** Shorten a path under home back to `~/…` for display. */
export function contractHome(path, home) {
    if (path === home)
        return '~';
    if (path.startsWith(`${home}/`))
        return `~${path.slice(home.length)}`;
    return path;
}

/**
 * The directory that holds `.credentials.json` for an account. An empty
 * configDir is the CLI default, `~/.claude`.
 */
export function credentialsDir(configDir, home) {
    return configDir ? expandHome(configDir, home).replace(/\/+$/, '') : `${home}/.claude`;
}

/** `.claude-work` → {label: 'Work', shortTag: 'W'}; `.claude` → Personal. */
export function guessLabel(dirName) {
    const m = /^\.claude[-_.]?(.*)$/.exec(dirName);
    const rest = m ? m[1] : dirName;
    if (!rest)
        return {label: 'Personal', shortTag: 'P'};
    const words = rest.split(/[-_.]+/).filter(Boolean);
    const label = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return {label, shortTag: label.charAt(0).toUpperCase()};
}
