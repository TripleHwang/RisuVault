'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { atomicWriteJson, readVerifiedJson, recoverTransactions } = require('./file-store.cjs');

const MANIFEST_PATH = 'kv/manifest.json';
const HEX_MIGRATION_MARKER = 'migration/legacy-hex-save-folder.json';

function digest(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function digestAsync(data) {
    return Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', data)).toString('hex');
}

async function inspectFileAsync(filePath) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { hash: hash.digest('hex'), size };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    const failures = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                results[index] = await mapper(items[index], index);
            } catch (error) {
                // Do not leave concurrent file preparations writing after the caller
                // has observed a failure.  Settle every scheduled input first.
                failures[index] = error;
            }
        }
    });
    await Promise.all(workers);
    const failure = failures.find(Boolean);
    if (failure) throw failure;
    return results;
}

async function syncDirectoryAsync(directory) {
    let handle;
    try {
        handle = await fsp.open(directory, 'r');
        await handle.sync();
    } catch (error) {
        // Windows does not permit opening a directory as a normal file.  On
        // platforms that support it, this is the durability barrier after rename.
        if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error?.code)) throw error;
    } finally {
        await handle?.close().catch(() => {});
    }
}

function writeObject(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (digest(fs.readFileSync(temp)) !== hash) {
        fs.unlinkSync(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        fs.renameSync(temp, target);
    } catch (error) {
        if (fs.existsSync(target)) fs.unlinkSync(temp);
        else throw error;
    }
}

async function writeObjectAsync(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    try {
        await fsp.access(target);
        return;
    } catch {}
    await fsp.mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (await digestAsync(await fsp.readFile(temp)) !== hash) {
        await fsp.unlink(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        await fsp.rename(temp, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(temp);
        } catch {
            throw error;
        }
    }
}

async function writeObjectFromFileAsync(dataRoot, sourcePath, onObjectReady = () => {}) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    await fsp.mkdir(directory, { recursive: true });
    // Upstream 0.9.11 stopped copying the spool file through a temp object and
    // renames it into the store instead, so a backup import no longer writes
    // every asset twice. That is a same-filesystem rename here: the entry
    // staging directory lives under the data root, next to kv/objects. The
    // separate checksum re-read went with the copy -- the bytes that get
    // hashed are now literally the bytes that get renamed.
    const handle = await fsp.open(sourcePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }

    const inspected = await inspectFileAsync(sourcePath);
    const target = path.join(directory, inspected.hash);
    let exists = true;
    try {
        await fsp.access(target);
    } catch {
        exists = false;
    }
    if (exists) {
        await fsp.unlink(sourcePath).catch(() => {});
        // The object is on disk and about to be referenced by a manifest that
        // has not been committed yet; without the retention mark a concurrent
        // sweep is free to collect it out from under the pending commit.
        onObjectReady(inspected.hash, false);
        return inspected;
    }

    let renamed = false;
    try {
        await fsp.rename(sourcePath, target);
        renamed = true;
        await syncDirectoryAsync(directory);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(sourcePath);
        } catch {
            throw error;
        }
    }
    onObjectReady(inspected.hash, renamed);
    return inspected;
}

function createFileKv(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    fs.mkdirSync(dataRoot, { recursive: true });
    recoverTransactions(dataRoot);

    let manifest = fs.existsSync(path.join(dataRoot, MANIFEST_PATH))
        ? readVerifiedJson(dataRoot, MANIFEST_PATH)
        : { schemaVersion: 1, updatedAt: 0, entries: {} };
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.entries !== 'object') {
        throw new Error('Unsupported or corrupt file KV manifest');
    }
    const objectWriteConcurrency = options.objectWriteConcurrency
        ?? Math.min(8, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));
    const manifestWriter = options.manifestWriter ?? (next => atomicWriteJson(dataRoot, MANIFEST_PATH, next, {
        validate: value => value?.schemaVersion === 1 && typeof value?.entries === 'object',
    }));
    let manifestCommitTail = Promise.resolve();
    const inFlightManifests = new Set();
    const pendingReplacementMutationJournals = new Set();
    const preparedObjectReferences = new Map();

    function retainPreparedObject(hash) {
        preparedObjectReferences.set(hash, (preparedObjectReferences.get(hash) ?? 0) + 1);
    }

    function releasePreparedObjects(hashes) {
        for (const hash of hashes) {
            const remaining = (preparedObjectReferences.get(hash) ?? 1) - 1;
            if (remaining > 0) preparedObjectReferences.set(hash, remaining);
            else preparedObjectReferences.delete(hash);
        }
    }

    async function commitManifest(next) {
        inFlightManifests.add(next);
        try {
            await manifestWriter(next);
            manifest = next;
        } finally {
            inFlightManifests.delete(next);
        }
    }

    function queueManifestCommit(commit) {
        const queued = manifestCommitTail.then(commit);
        manifestCommitTail = queued.catch(() => {});
        return queued;
    }

    function saveManifest() {
        atomicWriteJson(dataRoot, MANIFEST_PATH, manifest, {
            validate: value => value?.schemaVersion === 1 && typeof value?.entries === 'object',
        });
    }

    // A synchronous mutation can run while a staged-file writer is awaiting I/O.
    // Apply it to both the live manifest and every in-flight staged snapshot so a
    // later staged publish cannot overwrite the synchronous write with stale data.
    function mutateManifest(mutate) {
        for (const journal of pendingReplacementMutationJournals) journal.push(mutate);
        const targets = new Set([manifest, ...inFlightManifests]);
        for (const target of targets) {
            mutate(target);
            target.updatedAt = Date.now();
        }
        saveManifest();
    }

    function kvGet(key) {
        const entry = manifest.entries[key];
        if (!entry) return null;
        const objectPath = path.join(dataRoot, 'kv', 'objects', entry.object);
        let value;
        try { value = fs.readFileSync(objectPath); } catch { return null; }
        if (digest(value) !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        return value;
    }

    function kvSet(key, value) {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const hash = digest(data);
        writeObject(dataRoot, hash, data);
        const entry = { object: hash, size: data.length, updatedAt: Date.now() };
        mutateManifest(target => { target.entries[key] = entry; });
    }

    function prepareEntries(entries) {
        return entries.map(({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = await digestAsync(data);
            await writeObjectAsync(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    function validateFileEntries(entries) {
        if (!Array.isArray(entries)) throw new TypeError('File KV entries must be an array');
        const keys = new Set();
        const sourcePaths = new Set();
        const sourceInodes = new Set();
        const objectsDirectory = path.resolve(dataRoot, 'kv', 'objects');
        const realObjectsDirectory = fs.existsSync(objectsDirectory)
            ? fs.realpathSync.native(objectsDirectory)
            : objectsDirectory;
        return entries.map((entry, index) => {
            if (!entry || typeof entry.key !== 'string' || !entry.key || entry.key.includes('\0')) {
                throw new TypeError(`Invalid file KV key at entry ${index}`);
            }
            if (typeof entry.sourcePath !== 'string' || !entry.sourcePath) {
                throw new TypeError(`Invalid file KV source path at entry ${index}`);
            }
            if (keys.has(entry.key)) throw new Error(`Duplicate file KV key: ${entry.key}`);
            keys.add(entry.key);
            const sourcePath = path.resolve(entry.sourcePath);
            let canonicalSourcePath = sourcePath;
            try {
                const sourceLstat = fs.lstatSync(sourcePath);
                if (sourceLstat.isSymbolicLink()) {
                    throw new Error(`Unsafe symbolic-link file KV source path: ${entry.sourcePath}`);
                }
                canonicalSourcePath = fs.realpathSync.native(sourcePath);
                const sourceStat = fs.statSync(sourcePath);
                const inodeIdentity = `${sourceStat.dev}:${sourceStat.ino}`;
                if (sourceInodes.has(inodeIdentity)) {
                    throw new Error(`Ambiguous hard-link file KV source path: ${entry.sourcePath}`);
                }
                sourceInodes.add(inodeIdentity);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            const relativeToObjects = path.relative(realObjectsDirectory, canonicalSourcePath);
            if (relativeToObjects === '' || (!relativeToObjects.startsWith(`..${path.sep}`) && relativeToObjects !== '..' && !path.isAbsolute(relativeToObjects))) {
                throw new Error(`Unsafe file KV source path inside object store: ${entry.sourcePath}`);
            }
            if (sourcePaths.has(canonicalSourcePath)) throw new Error(`Ambiguous file KV source path: ${entry.sourcePath}`);
            sourcePaths.add(canonicalSourcePath);
            return { key: entry.key, sourcePath };
        });
    }

    async function prepareFileEntriesAsync(entries, retainedHashes) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, sourcePath }) => {
            const prepared = await writeObjectFromFileAsync(dataRoot, sourcePath, hash => {
                if (!retainedHashes) return;
                retainPreparedObject(hash);
                retainedHashes.push(hash);
            });
            return [key, { object: prepared.hash, size: prepared.size, updatedAt: Date.now() }];
        });
    }

    async function kvSetManyFromFilesAsync(entries) {
        const prepared = await prepareFileEntriesAsync(entries);
        if (!entries.length) return;
        await queueManifestCommit(async () => {
            const next = { schemaVersion: 1, updatedAt: Date.now(), entries: { ...manifest.entries } };
            for (const [key, entry] of prepared) next.entries[key] = entry;
            await commitManifest(next);
        });
    }

    function kvSetMany(entries) {
        const prepared = prepareEntries(entries);
        if (prepared.length) mutateManifest(target => {
            for (const [key, entry] of prepared) target.entries[key] = entry;
        });
    }

    async function kvSetManyAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        if (prepared.length) mutateManifest(target => {
            for (const [key, entry] of prepared) target.entries[key] = entry;
        });
    }

    function kvReplacePrefixes(entries, prefixes) {
        const prepared = prepareEntries(entries);
        mutateManifest(target => {
            const next = { ...target.entries };
            for (const key of Object.keys(next)) {
                if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
            }
            for (const [key, entry] of prepared) next[key] = entry;
            target.entries = next;
        });
    }

    function kvReplaceAll(entries) {
        const prepared = Object.fromEntries(prepareEntries(entries));
        mutateManifest(target => { target.entries = { ...prepared }; });
    }

    async function kvReplacePrefixesAsync(entries, prefixes) {
        const prepared = await prepareEntriesAsync(entries);
        mutateManifest(target => {
            const next = { ...target.entries };
            for (const key of Object.keys(next)) {
                if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
            }
            for (const [key, entry] of prepared) next[key] = entry;
            target.entries = next;
        });
    }

    async function kvReplacePrefixesFromFilesAsync(entries, prefixes) {
        const prepared = await prepareFileEntriesAsync(entries);
        mutateManifest(target => {
            const next = { ...target.entries };
            for (const key of Object.keys(next)) {
                if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
            }
            for (const [key, entry] of prepared) next[key] = entry;
            target.entries = next;
        });
    }

    async function kvReplaceAllAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        mutateManifest(target => { target.entries = Object.fromEntries(prepared); });
    }

    async function kvReplaceAllFromFilesAsync(entries) {
        const validEntries = validateFileEntries(entries);
        const deferredMutations = [];
        const retainedHashes = [];
        pendingReplacementMutationJournals.add(deferredMutations);
        return queueManifestCommit(async () => {
            try {
                const prepared = await prepareFileEntriesAsync(validEntries, retainedHashes);
                const next = {
                    schemaVersion: 1,
                    updatedAt: Date.now(),
                    entries: Object.fromEntries(prepared),
                };
                for (const mutate of deferredMutations) {
                    mutate(next);
                    next.updatedAt = Date.now();
                }
                pendingReplacementMutationJournals.delete(deferredMutations);
                await commitManifest(next);
            } finally {
                pendingReplacementMutationJournals.delete(deferredMutations);
                releasePreparedObjects(retainedHashes);
            }
        });
    }

    function kvDel(key) {
        if (!(key in manifest.entries)
            && ![...inFlightManifests].some(target => key in target.entries)
            && pendingReplacementMutationJournals.size === 0) return;
        mutateManifest(target => { delete target.entries[key]; });
    }

    function kvDelMany(keys) {
        let count = 0;
        let bytes = 0;
        const removable = [];
        for (const key of new Set(keys)) {
            const entry = manifest.entries[key];
            if (entry) {
                bytes += entry.size ?? 0;
                count += 1;
                removable.push(key);
                continue;
            }
            // Same rule as kvDel: a key absent from the live manifest may still
            // be present in an in-flight staged snapshot or arrive through a
            // pending replacement journal, so the deletion must still be journaled.
            if ([...inFlightManifests].some(target => key in target.entries)
                || pendingReplacementMutationJournals.size > 0) removable.push(key);
        }
        if (removable.length) mutateManifest(target => {
            for (const key of removable) delete target.entries[key];
        });
        return { count, bytes };
    }

    function kvSize(key) {
        return manifest.entries[key]?.size ?? 0;
    }

    function kvGetUpdatedAt(key) {
        return manifest.entries[key]?.updatedAt ?? null;
    }

    // Read-only manifest metadata: callers can validate object identity without
    // opening the content-addressed object file.
    function kvGetMetadata(key) {
        const entry = manifest.entries[key];
        return entry ? { object: entry.object, size: entry.size, updatedAt: entry.updatedAt } : null;
    }

    function kvCopyValue(source, destination) {
        const entry = manifest.entries[source];
        if (!entry) return;
        const copied = { ...entry, updatedAt: Date.now() };
        mutateManifest(target => { target.entries[destination] = copied; });
    }

    function kvDelPrefix(prefix) {
        const changed = [manifest, ...inFlightManifests]
            .some(target => Object.keys(target.entries).some(key => key.startsWith(prefix)))
            || pendingReplacementMutationJournals.size > 0;
        if (changed) mutateManifest(target => {
            for (const key of Object.keys(target.entries)) {
                if (key.startsWith(prefix)) delete target.entries[key];
            }
        });
    }

    function kvList(prefix = '') {
        return Object.keys(manifest.entries).filter(key => key.startsWith(prefix)).sort();
    }

    function kvListWithSizes(prefix = '') {
        return kvList(prefix).map(key => ({ key, size: manifest.entries[key].size }));
    }

    function referencedObjects() {
        return new Set(Object.values(manifest.entries).map(entry => entry.object));
    }

    function reclaimableObjects() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return [];
        const referenced = referencedObjects();
        return fs.readdirSync(directory)
            .filter(name => /^[a-f0-9]{64}$/.test(name) && !referenced.has(name) && !preparedObjectReferences.has(name));
    }

    function reclaimableChunkBytes() {
        return reclaimableObjects().reduce((total, name) => {
            try { return total + fs.statSync(path.join(dataRoot, 'kv', 'objects', name)).size; }
            catch { return total; }
        }, 0);
    }

    function objectStoreBytes() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return 0;
        return fs.readdirSync(directory).reduce((total, name) => {
            if (!/^[a-f0-9]{64}$/.test(name)) return total;
            try { return total + fs.statSync(path.join(directory, name)).size; }
            catch { return total; }
        }, 0);
    }

    function gcChunks(options = {}) {
        const minAgeMs = Number.isFinite(options.minAgeMs) ? Math.max(0, options.minAgeMs) : 0;
        const maxDeletes = Number.isFinite(options.maxDeletes)
            ? Math.max(0, Math.floor(options.maxDeletes))
            : Number.POSITIVE_INFINITY;
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const objects = reclaimableObjects();
        let count = 0;
        let bytes = 0;
        for (const name of objects) {
            if (count >= maxDeletes) break;
            const objectPath = path.join(dataRoot, 'kv', 'objects', name);
            try {
                const stat = fs.statSync(objectPath);
                if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) continue;
                fs.unlinkSync(objectPath);
                count += 1;
                bytes += stat.size;
            } catch {}
        }
        return { count, bytes };
    }

    function snapshotFootprint(key) {
        const entry = manifest.entries[key];
        if (!entry) return 0;
        const live = manifest.entries['database/database.bin'];
        return live && live.object === entry.object ? 0 : entry.size;
    }

    function migrateLegacyHexFiles() {
        if (fs.existsSync(path.join(dataRoot, HEX_MIGRATION_MARKER))) return;
        const files = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^[a-fA-F0-9]+$/.test(entry.name) && entry.name.length % 2 === 0);
        let imported = 0;
        const importedEntries = [];
        for (const entry of files) {
            const key = Buffer.from(entry.name, 'hex').toString('utf8');
            if (!key || key in manifest.entries) continue;
            const data = fs.readFileSync(path.join(dataRoot, entry.name));
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            importedEntries.push([key, { object: hash, size: data.length, updatedAt: fs.statSync(path.join(dataRoot, entry.name)).mtimeMs }]);
            imported += 1;
        }
        if (imported) mutateManifest(target => {
            for (const [key, entry] of importedEntries) target.entries[key] = entry;
        });
        atomicWriteJson(dataRoot, HEX_MIGRATION_MARKER, { schemaVersion: 1, imported, completedAt: Date.now() });
    }

    migrateLegacyHexFiles();

    return {
        kvGet,
        kvSet,
        kvSetMany,
        kvSetManyFromFilesAsync,
        kvSetManyAsync,
        kvReplacePrefixes,
        kvReplacePrefixesAsync,
        kvReplacePrefixesFromFilesAsync,
        kvReplaceAll,
        kvReplaceAllAsync,
        kvReplaceAllFromFilesAsync,
        kvDel,
        kvDelMany,
        kvSize,
        kvGetUpdatedAt,
        kvGetMetadata,
        kvCopyValue,
        kvDelPrefix,
        kvList,
        kvListWithSizes,
        gcChunks,
        reclaimableChunkBytes,
        objectStoreBytes,
        snapshotFootprint,
    };
}

module.exports = { createFileKv };
