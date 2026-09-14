'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');

async function main() {
    const root = path.resolve(process.argv[2]);
    const expected = process.argv[3];
    const { validatePackage, startAndVerify } = require(path.join(root, 'server/node/portable-update.cjs'));
    const version = validatePackage(root);
    if (version !== expected) throw new Error(`Expected ${expected}, got ${version}`);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-smoke-'));
    try {
        const child = await startAndVerify(root, {
            ...process.env, PORT: '0', RISUBARD_DATA_ROOT: data,
            RISU_UPDATE_CHECK: 'false', OPEN_BROWSER: '0', NODE_PATH: '', NODE_OPTIONS: '',
        }, 60000, console.log);
        const exited = once(child, 'close');
        child.kill();
        await exited;
        console.log(`Portable v${version}: dependencies and isolated server startup passed`);
    } finally { await fs.promises.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
