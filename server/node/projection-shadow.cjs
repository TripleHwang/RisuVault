'use strict';

const { isDeepStrictEqual } = require('node:util');

function defaultScheduleTask(task) {
    const handle = setImmediate(() => { void task(); });
    handle.unref?.();
}

function createProjectionShadow(options = {}) {
    const repository = options.repository;
    const observation = options.observation;
    const scheduleTask = options.scheduleTask || defaultScheduleTask;
    const isPersisting = options.isPersisting || (() => false);
    const now = options.now || (() => performance.now());
    let pending = null;
    let scheduled = false;

    function record(row) {
        try { observation?.record(row); } catch {}
    }

    async function run() {
        scheduled = false;
        const candidate = pending;
        pending = null;
        if (!candidate) return;
        if (isPersisting()) {
            record({
                kind: 'projection-shadow',
                trigger: candidate.trigger,
                outcome: 'skipped',
                errorStage: 'persist-active',
                plannedFiles: candidate.plannedFiles,
            });
            return;
        }

        const startedAt = now();
        try {
            const projected = repository.exportLegacyDatabase();
            const semanticMatch = isDeepStrictEqual(projected, candidate.database);
            record({
                kind: 'projection-shadow',
                trigger: candidate.trigger,
                outcome: semanticMatch ? 'success' : 'mismatch',
                errorStage: semanticMatch ? undefined : 'semantic-compare',
                durationMs: Math.max(0, Math.round((now() - startedAt) * 1000) / 1000),
                plannedFiles: candidate.plannedFiles,
                semanticMatch,
            });
        } catch (error) {
            record({
                kind: 'projection-shadow',
                trigger: candidate.trigger,
                outcome: 'failure',
                errorStage: 'projection-read',
                errorName: String(error?.name || 'Error'),
                durationMs: Math.max(0, Math.round((now() - startedAt) * 1000) / 1000),
                plannedFiles: candidate.plannedFiles,
            });
        }
    }

    function schedule(candidate) {
        try {
            pending = {
                database: candidate.database,
                trigger: String(candidate.trigger || 'unspecified'),
                plannedFiles: Number.isFinite(candidate.plannedFiles) && candidate.plannedFiles >= 0
                    ? candidate.plannedFiles
                    : 0,
            };
            if (!scheduled) {
                scheduled = true;
                scheduleTask(run);
            }
            return true;
        } catch (error) {
            pending = null;
            scheduled = false;
            record({
                kind: 'projection-shadow',
                trigger: String(candidate?.trigger || 'unspecified'),
                outcome: 'failure',
                errorStage: 'schedule',
                errorName: String(error?.name || 'Error'),
            });
            return false;
        }
    }

    return { schedule };
}

module.exports = { createProjectionShadow };
