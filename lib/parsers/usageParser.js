// Parses the output of `claude -p --output-format json /usage`.
// Pure: no gi:// imports. Reset times come back as tokens; lib/time.js turns
// them into absolute times.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
}

/**
 * Find and parse the JSON result envelope in stdout. Returns null when there
 * is none. Tolerates stray lines before or after the JSON object.
 */
export function parseEnvelope(stdout) {
    const text = stripAnsi(stdout ?? '').trim();
    if (!text)
        return null;

    const candidates = [text];
    const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
    candidates.push(...lines.reverse());

    for (const c of candidates) {
        try {
            const obj = JSON.parse(c);
            if (obj && typeof obj === 'object' && !Array.isArray(obj))
                return obj;
        } catch {
            // try the next candidate
        }
    }
    return null;
}

const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Tokenize a reset string such as `Nov 25, 3:20pm (Europe/Athens)`,
 * `4pm (Europe/Athens)`, `Nov 29 at 21:00` or `in 2h 13m`.
 *
 * Returns {month, day, hour, minute, zone} (month/day null when absent),
 * {relativeMs}, or null if the string is not understood.
 */
export function parseResetString(input) {
    if (typeof input !== 'string')
        return null;
    let s = input.trim();

    let zone = null;
    const zm = /\(([^()]+)\)\s*$/.exec(s);
    if (zm) {
        zone = zm[1].trim();
        s = s.slice(0, zm.index).trim();
    }

    const rel = /^in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/i.exec(s);
    if (rel && (rel[1] || rel[2] || rel[3])) {
        const d = Number(rel[1] ?? 0), h = Number(rel[2] ?? 0), m = Number(rel[3] ?? 0);
        return {relativeMs: ((d * 24 + h) * 60 + m) * 60000};
    }

    let month = null, day = null;
    const dm = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?\s*(?:at\s+)?/.exec(s);
    if (dm) {
        month = MONTHS[dm[1].slice(0, 3).toLowerCase()] ?? null;
        if (month === null)
            return null;
        day = Number(dm[2]);
        s = s.slice(dm[0].length).trim();
    }

    let hour, minute;
    const t12 = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(s);
    const t24 = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (t12) {
        hour = Number(t12[1]);
        if (hour < 1 || hour > 12)
            return null;
        hour %= 12;
        if (t12[3].toLowerCase() === 'p')
            hour += 12;
        minute = Number(t12[2] ?? 0);
    } else if (t24) {
        hour = Number(t24[1]);
        minute = Number(t24[2]);
    } else if (s === '' && month !== null) {
        hour = 0;
        minute = 0;
    } else {
        return null;
    }

    if (hour > 23 || minute > 59 || (day !== null && (day < 1 || day > 31)))
        return null;

    return {month, day, hour, minute, zone};
}

const PCT = String.raw`(?:<\s*)?(\d+(?:\.\d+)?)\s*%\s*used`;
const RESET = String.raw`(?:\s*[·•|,\-–—]\s*resets?\s+(.+?))?`;
const SESSION_RE = new RegExp(String.raw`^\s*Current session\s*:\s*${PCT}${RESET}\s*$`, 'im');
const WEEK_RE = new RegExp(String.raw`^\s*Current week(?:\s*\(([^)]+)\))?\s*:\s*${PCT}${RESET}\s*$`, 'gim');

/**
 * Pull the limit lines out of the `/usage` text.
 * Returns {fiveHour, weekly, subscription}. Each window is
 * {label, pct, resetText, reset} where `reset` is parseResetString output.
 */
export function parseUsageText(text) {
    const clean = stripAnsi(text ?? '');

    let fiveHour = null;
    const sm = SESSION_RE.exec(clean);
    if (sm) {
        fiveHour = {
            label: 'session',
            pct: Number(sm[1]),
            resetText: sm[2] ?? null,
            reset: sm[2] ? parseResetString(sm[2]) : null,
        };
    }

    const weekly = [];
    for (const m of clean.matchAll(WEEK_RE)) {
        weekly.push({
            label: (m[1] ?? 'all models').trim(),
            pct: Number(m[2]),
            resetText: m[3] ?? null,
            reset: m[3] ? parseResetString(m[3]) : null,
        });
    }

    return {
        fiveHour,
        weekly,
        subscription: /using your subscription/i.test(clean),
    };
}
