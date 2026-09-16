'use strict';

function patchCollection(operations) {
    if (!Array.isArray(operations) || operations.length === 0) return null;
    const insideBotPresets = value => typeof value === 'string'
        && (value === '/botPresets' || value.startsWith('/botPresets/'));
    for (const operation of operations) {
        if (!operation || typeof operation !== 'object' || !insideBotPresets(operation.path)) return null;
        if (Object.prototype.hasOwnProperty.call(operation, 'from') && !insideBotPresets(operation.from)) return null;
    }
    return 'botPresets';
}

function createDirectWriteTracker() {
    const pending = new Map();
    return {
        observe(key, operations) {
            const next = patchCollection(operations);
            if (!pending.has(key)) {
                pending.set(key, next);
                return;
            }
            const previous = pending.get(key);
            pending.set(key, previous && previous === next ? previous : null);
        },
        take(key) {
            const value = pending.get(key) || null;
            pending.delete(key);
            return value;
        },
        clear(key) {
            pending.delete(key);
        },
    };
}

module.exports = { createDirectWriteTracker, patchCollection };
