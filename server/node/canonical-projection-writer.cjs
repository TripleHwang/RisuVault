'use strict';

function safeErrorCode(error) {
    return String(error?.code || error?.name || 'UNKNOWN_ERROR').slice(0, 128);
}

function writeCanonicalProjection(options = {}) {
    const { repository, database, directCollection } = options;
    if (!repository || typeof repository.importLegacyDatabase !== 'function') {
        throw new Error('Canonical projection repository is required');
    }
    if (!database || typeof database !== 'object') {
        throw new Error('Canonical projection database is required');
    }

    if (directCollection !== 'botPresets') {
        return {
            strategy: 'full-sync',
            fallbackUsed: false,
            result: repository.importLegacyDatabase(database, { mode: 'sync' }),
        };
    }

    try {
        return {
            strategy: 'bot-presets-direct',
            fallbackUsed: false,
            result: repository.syncLegacyCollection('botPresets', database.botPresets),
        };
    } catch (directError) {
        const fallbackCode = safeErrorCode(directError);
        try {
            return {
                strategy: 'bot-presets-direct',
                fallbackUsed: true,
                fallbackCode,
                result: repository.importLegacyDatabase(database, { mode: 'sync' }),
            };
        } catch (fallbackError) {
            if (fallbackError && typeof fallbackError === 'object') {
                fallbackError.canonicalWriteMeta = {
                    strategy: 'bot-presets-direct',
                    fallbackUsed: true,
                    fallbackCode,
                };
            }
            throw fallbackError;
        }
    }
}

module.exports = { writeCanonicalProjection };
