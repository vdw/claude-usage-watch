// Turns reset tokens into absolute times and formats durations.

import GLib from 'gi://GLib';

const DAY_MS = 24 * 3600 * 1000;

function zoneFor(id) {
    if (id) {
        try {
            const tz = GLib.TimeZone.new_identifier(id);
            if (tz)
                return tz;
        } catch {
            // fall back to local time
        }
    }
    return GLib.TimeZone.new_local();
}

/**
 * Resolve parseResetString() output to epoch ms, relative to `nowMs`.
 * The CLI omits the year, so a date more than a day in the past is moved to
 * next year. A time with no date is today, or tomorrow if it has passed.
 */
export function resolveReset(tokens, nowMs) {
    if (!tokens)
        return null;
    if (typeof tokens.relativeMs === 'number')
        return nowMs + tokens.relativeMs;

    const tz = zoneFor(tokens.zone);
    const now = GLib.DateTime.new_from_unix_utc(Math.floor(nowMs / 1000)).to_timezone(tz);
    const year = now.get_year();
    const month = tokens.month ?? now.get_month();
    const day = tokens.day ?? now.get_day_of_month();

    const at = y => GLib.DateTime.new(tz, y, month, day, tokens.hour, tokens.minute, 0);

    let dt = at(year);
    if (!dt)
        return null;
    let ms = dt.to_unix() * 1000;

    if (tokens.month === null || tokens.month === undefined) {
        if (ms < nowMs - 60000)
            ms = dt.add_days(1).to_unix() * 1000;
    } else if (ms < nowMs - DAY_MS) {
        dt = at(year + 1);
        if (!dt)
            return null;
        ms = dt.to_unix() * 1000;
    }
    return ms;
}

/** 4_320_000 → "1h 12m"; 2 days → "2d 0h"; under a minute → "<1m". */
export function formatDuration(ms) {
    if (ms <= 0)
        return 'now';
    if (ms < 60000)
        return '<1m';
    const mins = Math.ceil(ms / 60000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}

/** Local wall-clock time: "21:00" today, "Sat 21:00" this week, else "Dec 3 21:00". */
export function formatClock(ms, use12h = false, nowMs = Date.now()) {
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_from_unix_local(Math.floor(nowMs / 1000));
    const time = use12h ? '%l:%M %p' : '%H:%M';
    let fmt;
    if (dt.get_year() === now.get_year() && dt.get_day_of_year() === now.get_day_of_year())
        fmt = time;
    else if (Math.abs(ms - nowMs) < 6 * DAY_MS)
        fmt = `%a ${time}`;
    else
        fmt = `%b %e ${time}`;
    return dt.format(fmt).replace(/\s+/g, ' ').trim();
}
