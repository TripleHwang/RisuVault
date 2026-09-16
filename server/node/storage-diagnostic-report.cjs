'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const LOG_NAMES = ['storage-observation.previous.jsonl', 'storage-observation.jsonl'];
const ISSUE_KINDS = new Set(['compatibility-persist', 'canonical-sync', 'projection-shadow']);

function percentile(values, ratio) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function durations(rows, kind) {
    return rows
        .filter(row => row.kind === kind && row.outcome === 'success' && Number.isFinite(row.durationMs) && row.durationMs >= 0)
        .map(row => row.durationMs);
}

function durationSummary(values) {
    return { p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

function safeStage(value) {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : 'unknown';
}

function safeCode(value, fallback) {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

async function readRows(dataRoot) {
    const rows = [];
    for (const name of LOG_NAMES) {
        let text;
        try { text = await fs.readFile(path.join(dataRoot, 'logs', name), 'utf8'); }
        catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        for (const line of text.split(/\r?\n/)) {
            if (!line) continue;
            try {
                const row = JSON.parse(line);
                if (row && typeof row === 'object' && ISSUE_KINDS.has(row.kind)) rows.push(row);
            } catch {}
        }
    }
    return rows;
}

function collectIssues(rows) {
    const grouped = new Map();
    function addIssue(issue) {
        const key = `${issue.area}\0${issue.stage}\0${issue.code}`;
        const previous = grouped.get(key);
        grouped.set(key, previous ? { ...previous, count: previous.count + 1 } : { ...issue, count: 1 });
    }
    for (const row of rows) {
        if (row.kind === 'canonical-sync' && row.fallbackUsed === true) {
            addIssue({
                area: 'canonical-direct-write',
                stage: 'fallback',
                code: safeCode(row.fallbackCode, 'UNKNOWN_ERROR'),
            });
        }
        const isMismatch = row.kind === 'projection-shadow' && row.outcome === 'mismatch';
        if (row.outcome !== 'failure' && !isMismatch) continue;
        const issue = {
            area: row.kind,
            stage: safeStage(row.errorStage),
            code: isMismatch
                ? 'SEMANTIC_MISMATCH'
                : safeCode(row.errorCode, row.kind === 'projection-shadow' ? 'SHADOW_FAILURE' : 'UNKNOWN_ERROR'),
        };
        addIssue(issue);
    }
    return [...grouped.values()].sort((a, b) =>
        a.area.localeCompare(b.area) || a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code));
}

async function generateStorageDiagnosticReport(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    const rows = await readRows(dataRoot);
    const saveRows = rows.filter(row => row.kind === 'compatibility-persist');
    const canonicalRows = rows.filter(row => row.kind === 'canonical-sync');
    const directRows = canonicalRows.filter(row => row.strategy === 'bot-presets-direct');
    const shadowRows = rows.filter(row => row.kind === 'projection-shadow');
    const issues = collectIssues(rows);
    const observed = saveRows.length + canonicalRows.length + shadowRows.length;

    return {
        reportType: 'risubard-storage-diagnostics',
        schemaVersion: 1,
        appVersion: String(options.appVersion || 'unknown').slice(0, 32),
        status: observed === 0 ? 'no-observations' : issues.length ? 'issues-detected' : 'no-issues-observed',
        saves: {
            attempts: saveRows.length,
            successes: saveRows.filter(row => row.outcome === 'success').length,
            failures: saveRows.filter(row => row.outcome === 'failure').length,
            durationMs: durationSummary(durations(rows, 'compatibility-persist')),
        },
        canonicalProjection: {
            attempts: canonicalRows.length,
            successes: canonicalRows.filter(row => row.outcome === 'success').length,
            failures: canonicalRows.filter(row => row.outcome === 'failure').length,
            durationMs: durationSummary(durations(rows, 'canonical-sync')),
        },
        directWrites: {
            attempts: directRows.length,
            successes: directRows.filter(row => row.outcome === 'success' && row.fallbackUsed !== true).length,
            fallbacks: directRows.filter(row => row.fallbackUsed === true).length,
            failures: directRows.filter(row => row.outcome === 'failure').length,
        },
        shadow: {
            checks: shadowRows.filter(row => ['success', 'mismatch', 'failure'].includes(row.outcome)).length,
            matches: shadowRows.filter(row => row.outcome === 'success' && row.semanticMatch === true).length,
            mismatches: shadowRows.filter(row => row.outcome === 'mismatch').length,
            failures: shadowRows.filter(row => row.outcome === 'failure').length,
            skipped: shadowRows.filter(row => row.outcome === 'skipped').length,
        },
        issues,
        privacy: {
            includesPersonalContent: false,
            includesRawLogs: false,
            omitted: ['timestamps', 'paths', 'names', 'messages', 'identifiers', 'hashes', 'database sizes', 'entity counts'],
        },
    };
}

module.exports = { generateStorageDiagnosticReport };
