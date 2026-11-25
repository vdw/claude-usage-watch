// Builds a normalized UsageSnapshot from one CLI run.
//
// UsageSnapshot = {
//   status: 'ok' | 'stale' | 'logged-out' | 'no-credentials' | 'cli-missing'
//         | 'timeout' | 'error',
//   fiveHour: {label, pct, resetsAt, resetText} | null,
//   weekly:   [{label, pct, resetsAt, resetText}],
//   credentialExpiresAt: epoch ms | null,
//   fetchedAt: epoch ms,
//   error: string | null,
// }

import {parseEnvelope, parseUsageText, stripAnsi} from './parsers/usageParser.js';
import {resolveReset} from './time.js';

export function makeSnapshot(status, fields = {}) {
    return {
        status,
        fiveHour: null,
        weekly: [],
        credentialExpiresAt: null,
        fetchedAt: Date.now(),
        error: null,
        ...fields,
    };
}

export function hasData(snapshot) {
    return !!snapshot && (!!snapshot.fiveHour || snapshot.weekly.length > 0);
}

function lastLine(text) {
    const lines = stripAnsi(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

function resolveWindow(w, nowMs) {
    return {
        label: w.label,
        pct: w.pct,
        resetText: w.resetText,
        resetsAt: resolveReset(w.reset, nowMs),
    };
}

/**
 * @param {object} run
 * @param {string} run.stdout
 * @param {string} run.stderr
 * @param {number} run.exitStatus  process exit code
 * @param {number} [run.nowMs]
 */
export function buildSnapshot({stdout, stderr, exitStatus, nowMs = Date.now()}) {
    const envelope = parseEnvelope(stdout);

    if (!envelope) {
        const detail = lastLine(stderr) || lastLine(stdout) || 'no output';
        return makeSnapshot('error', {
            fetchedAt: nowMs,
            error: exitStatus !== 0 ? `claude exited with ${exitStatus}: ${detail}` : `Unexpected output: ${detail}`,
        });
    }

    const expires = Date.parse(envelope.credential_expires_at ?? '');
    const credentialExpiresAt = Number.isFinite(expires) ? expires : null;
    const result = typeof envelope.result === 'string' ? envelope.result : '';

    if (envelope.is_error) {
        return makeSnapshot('error', {
            fetchedAt: nowMs,
            credentialExpiresAt,
            error: lastLine(result) || lastLine(stderr) || `claude reported an error (${envelope.subtype ?? 'unknown'})`,
        });
    }

    const parsed = parseUsageText(result);
    if (!parsed.fiveHour && parsed.weekly.length === 0) {
        // A signed-out profile still exits 0 and prints the API-cost summary.
        if (!parsed.subscription && (/Estimated cost|Total cost/i.test(result) || /log ?in|sign ?in|auth/i.test(result))) {
            return makeSnapshot('logged-out', {
                fetchedAt: nowMs,
                credentialExpiresAt,
                error: 'No subscription usage reported',
            });
        }
        return makeSnapshot('error', {
            fetchedAt: nowMs,
            credentialExpiresAt,
            error: `Could not find usage in output: ${lastLine(result) || 'empty result'}`,
        });
    }

    return makeSnapshot('ok', {
        fetchedAt: nowMs,
        credentialExpiresAt,
        fiveHour: parsed.fiveHour ? resolveWindow(parsed.fiveHour, nowMs) : null,
        weekly: parsed.weekly.map(w => resolveWindow(w, nowMs)),
    });
}
