'use strict';

const os = require('os');
const path = require('path');

function isTermux(env) {
    return String(env.PREFIX || '').includes('com.termux');
}

function isSharedAndroidPath(candidate) {
    const normalized = candidate.replace(/\\/g, '/').toLowerCase();
    return normalized === '/sdcard'
        || normalized.startsWith('/sdcard/')
        || normalized === '/storage/emulated/0'
        || normalized.startsWith('/storage/emulated/0/')
        || normalized === '/storage/self/primary'
        || normalized.startsWith('/storage/self/primary/');
}

function resolveDataRoot(options = {}) {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const platform = options.platform || process.platform;
    const explicit = typeof env.RISUBARD_DATA_ROOT === 'string'
        ? env.RISUBARD_DATA_ROOT.trim()
        : '';

    if (explicit) {
        const pathApi = platform === 'win32' ? path.win32 : path.posix;
        const resolved = pathApi.resolve(explicit);
        if ((platform === 'android' || isTermux(env)) && isSharedAndroidPath(resolved)) {
            throw new Error('Shared Android storage cannot be used as the canonical RisuVault data root');
        }
        return resolved;
    }

    if (platform === 'android' || isTermux(env)) {
        const home = env.HOME || os.homedir();
        const xdg = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
        return path.resolve(xdg, 'risubard');
    }

    return path.resolve(cwd, 'save');
}

module.exports = { resolveDataRoot, isSharedAndroidPath };
