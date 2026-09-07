'use strict';

const { Unzip, UnzipInflate } = require('fflate');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) { let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); table[index] = value >>> 0; }
  return table;
})();

/**
 * What a CharX archive may contain before the import refuses it.
 *
 * These are sized for a self-hosted server importing the user's own character
 * files, not for an open upload endpoint. The caps that actually protect the
 * machine keep their shape: `entries` is the zip-bomb guard and does not scale
 * with file size, `diskHeadroomBytes` still refuses an import that would fill
 * the disk, and the two caps on data that is buffered in memory rather than
 * streamed to disk -- `cardBytes` and `moduleBytes` -- stay far below the ones
 * on assets, which are written out as they arrive.
 *
 * `compressedBytes` matches the 2 GB body limit the upload route already
 * enforces, so it is no longer the lower of the two: an archive that reaches
 * the handler is one the handler will now try to read.
 *
 * Every value is overridable per call through `options.limits`.
 */
const DEFAULT_CHARX_LIMITS = Object.freeze({
  compressedBytes: 2 * 1024 * 1024 * 1024,
  decompressedBytes: 8 * 1024 * 1024 * 1024,
  // Not a size cap: this one bounds how many separate files the import stages
  // and publishes, so it is the zip-bomb guard that does not scale with the
  // archive's bytes. Raised from 10,000 after a real 587 MB character was
  // refused at 14,174 entries -- images plus their metadata sidecars, not an
  // attack. What actually bounds the damage is unchanged: the decompressed
  // total, the per-entry caps, and the disk-headroom check.
  entries: 50000,
  cardBytes: 16 * 1024 * 1024,
  moduleBytes: 64 * 1024 * 1024,
  assetBytes: 512 * 1024 * 1024,
  queuedWriteBytes: 8 * 1024 * 1024,
  diskHeadroomBytes: 256 * 1024 * 1024,
});

class CharXImportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CharXImportError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) { return new CharXImportError('INVALID_CHARX', message); }
function limit(message) { return new CharXImportError('CHARX_LIMIT_EXCEEDED', message, 413); }
function noSpace(message = 'Insufficient disk space for CharX import') { return new CharXImportError('INSUFFICIENT_STORAGE', message, 507); }
function aborted() { return new CharXImportError('IMPORT_ABORTED', 'CharX import aborted', 499); }
function normalizeError(error, fallback) {
  if (error instanceof CharXImportError) return error;
  if (error && error.code === 'ENOSPC') return noSpace();
  return fallback || invalid('Unable to import CharX archive');
}

function validateName(name, seen) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw invalid('Invalid archive entry name');
  const normalizedKey = name.normalize('NFC');
  if (seen.has(normalizedKey)) throw invalid('Duplicate archive entry name');
  seen.add(normalizedKey);
  const components = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  if (!components.length || components.some((part) => part === '.' || part === '..' || part === '')) throw invalid('Invalid archive entry name');
  return name;
}

function utf8Json(chunks) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw invalid('card.json must be valid UTF-8'); }
  try { return JSON.parse(text); } catch { throw invalid('card.json must contain valid JSON'); }
}

function readExact(fd, position, length) {
  const out = Buffer.allocUnsafe(length);
  if (fs.readSync(fd, out, 0, length, position) !== length) throw invalid('Truncated ZIP archive');
  return out;
}
function u16(b, at) { return b[at] | (b[at + 1] << 8); }
function u32(b, at) { return b[at] + b[at + 1] * 0x100 + b[at + 2] * 0x10000 + b[at + 3] * 0x1000000; }
function crc32Update(crc, bytes) { for (const byte of bytes) crc = (CRC32_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)) >>> 0; return crc; }
function zipName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw invalid('Invalid UTF-8 ZIP entry name'); }
}
function validateCentralDirectory(fd, archiveSize, eocdOffset, entryLimit) {
  const e = readExact(fd, eocdOffset, 22);
  const centralSize = u32(e, 12), declaredCentralOffset = u32(e, 16), count = u16(e, 10);
  const actualCentralOffset = eocdOffset - centralSize;
  const offsetBias = actualCentralOffset - declaredCentralOffset;
  if (u16(e, 4) || u16(e, 6) || u16(e, 8) !== count || !Number.isSafeInteger(archiveSize) || !Number.isSafeInteger(eocdOffset) || !Number.isSafeInteger(actualCentralOffset) || !Number.isSafeInteger(offsetBias) || actualCentralOffset < 0 || offsetBias < 0 || actualCentralOffset + centralSize !== eocdOffset || eocdOffset + 22 > archiveSize) throw invalid('Invalid ZIP central directory');
  if (count > entryLimit) throw limit('Archive has too many entries');
  let at = actualCentralOffset; const names = new Set(), entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocdOffset) throw invalid('Truncated ZIP central directory');
    const h = readExact(fd, at, 46);
    if (u32(h, 0) !== 0x02014b50) throw invalid('Invalid ZIP central directory');
    const flags = u16(h, 8), method = u16(h, 10), compressedSize = u32(h, 20), originalSize = u32(h, 24);
    const nameLength = u16(h, 28), extraLength = u16(h, 30), commentLength = u16(h, 32), diskStart = u16(h, 34), declaredLocalOffset = u32(h, 42);
    const localOffset = declaredLocalOffset + offsetBias;
    const end = at + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) || (method !== 0 && method !== 8) || diskStart || end > eocdOffset || compressedSize === 0xffffffff || originalSize === 0xffffffff || declaredLocalOffset >= declaredCentralOffset || !Number.isSafeInteger(localOffset) || localOffset >= actualCentralOffset) throw invalid('Unsupported or invalid ZIP entry');
    const nameBytes = readExact(fd, at + 46, nameLength); const name = validateName(zipName(nameBytes), names);
    if (name.endsWith('/') && (compressedSize || originalSize)) throw invalid('Directory entries must be empty');
    const local = readExact(fd, localOffset, 30);
    if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== flags || u16(local, 8) !== method) throw invalid('ZIP local header mismatch');
    const localNameLength = u16(local, 26), localExtraLength = u16(local, 28);
    const dataEnd = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
    if (dataEnd > actualCentralOffset || zipName(readExact(fd, localOffset + 30, localNameLength)) !== name) throw invalid('ZIP local header mismatch');
    let descriptorLength = 0;
    if (flags & 8) {
      const first = readExact(fd, dataEnd, 4);
      const signed = u32(first, 0) === 0x08074b50;
      const descriptor = signed ? Buffer.concat([first, readExact(fd, dataEnd + 4, 12)]) : Buffer.concat([first, readExact(fd, dataEnd + 4, 8)]);
      const base = signed ? 4 : 0;
      if (dataEnd + (signed ? 16 : 12) > actualCentralOffset || u32(descriptor, base) !== u32(h, 16) || u32(descriptor, base + 4) !== compressedSize || u32(descriptor, base + 8) !== originalSize) throw invalid('Invalid ZIP data descriptor');
      descriptorLength = signed ? 16 : 12;
    }
    entries.push({ name, flags, method, crc: u32(h, 16), compressedSize, originalSize, localOffset, headerLength: 30 + localNameLength + localExtraLength, dataOffset: localOffset + 30 + localNameLength + localExtraLength, descriptorLength });
    at = end;
  }
  if (at !== actualCentralOffset + centralSize) throw invalid('Invalid ZIP central directory');
  return entries;
}

async function importCharXStream(source, options) {
  const { stagingRoot, publishAssets, expectedCompressedBytes = 0, getAvailableBytes, onProgress = () => {}, signal } = options || {};
  const limits = { ...DEFAULT_CHARX_LIMITS, ...(options && options.limits) };
  if (!stagingRoot || typeof publishAssets !== 'function') throw new TypeError('stagingRoot and publishAssets are required');
  if (signal && signal.aborted) throw aborted();
  if (expectedCompressedBytes > limits.compressedBytes) throw limit('Compressed archive exceeds limit');
  /** getAvailableBytes must synchronously return a finite byte count immediately before each write (for example fs.statfsSync). */
  const checkSpace = (phase, needed) => {
    if (!getAvailableBytes) return;
    const available = getAvailableBytes({ phase, needed });
    if (available && typeof available.then === 'function') throw new TypeError('getAvailableBytes must return a finite number synchronously');
    if (!Number.isFinite(available) || available < needed + limits.diskHeadroomBytes) throw noSpace();
  };
  checkSpace('preflight', expectedCompressedBytes || 0);

  await fsp.mkdir(stagingRoot, { recursive: true });
  const ownedDir = await fsp.mkdtemp(path.join(stagingRoot, 'charx-'));
  const archivePath = path.join(ownedDir, 'archive.charx');
  let archiveFd = fs.openSync(archivePath, 'wx');
  const seen = new Set();
  const cards = [];
  const modules = [];
  const assets = Object.create(null);
  const assetFiles = new Map();
  const excludedFiles = [];
  const warnings = [];
  let cardCount = 0, moduleCount = 0, entryCount = 0, compressed = 0, decompressed = 0, advertisedTotal = 0;
  const zipTail = new Uint8Array(65557); let zipTailLength = 0;
  let currentError;
  let active = new Set();
  let extractingEntry;

  const checkAbort = () => { if (signal && signal.aborted) throw aborted(); if (currentError) throw currentError; };
  const closeAsset = (state) => {
    if (state.fd !== undefined) { fs.fsyncSync(state.fd); fs.closeSync(state.fd); state.fd = undefined; }
    if (state.excluded) { try { fs.unlinkSync(state.sourcePath); } catch {} return; }
    const key = state.hash.digest('hex');
    const target = `assets/${key}.png`;
    if (!assetFiles.has(target)) assetFiles.set(target, state.sourcePath);
    else { try { fs.unlinkSync(state.sourcePath); } catch {} }
    assets[state.name] = target;
  };
  const unzip = new Unzip((file) => {
    try {
      checkAbort();
      const name = validateName(file.name, seen);
      if (!extractingEntry || extractingEntry.name !== name) throw invalid('ZIP extraction metadata mismatch');
      const advertised = Number(file.originalSize) || 0;
      advertisedTotal += advertised;
      if (advertisedTotal > limits.decompressedBytes) throw limit('Archive exceeds decompressed limit');
      if (file.size && file.size > limits.decompressedBytes) throw limit('Archive entry exceeds decompressed limit');
      entryCount++;
      if (entryCount > limits.entries) throw limit('Archive has too many entries');
      if (file.name.endsWith('/')) {
        const state = { crc: 0xffffffff, expectedCrc: extractingEntry.crc };
        active.add(state);
        file.ondata = (err, data, final) => {
          try {
            if (err) throw invalid('Unsupported or corrupt ZIP entry');
            checkAbort(); state.crc = crc32Update(state.crc, data); decompressed += data.length;
            if (decompressed > limits.decompressedBytes) throw limit('Archive exceeds decompressed limit');
            if (final) { if (((state.crc ^ 0xffffffff) >>> 0) !== state.expectedCrc) throw invalid('ZIP entry CRC mismatch'); active.delete(state); }
          } catch (e) { currentError = normalizeError(e, invalid('Unable to extract archive entry')); }
        };
        file.start(); return;
      }
      const rootCard = name === 'card.json';
      const rootModule = name === 'module.risum';
      if (rootCard && advertised > limits.cardBytes) throw limit('card.json exceeds limit');
      if (rootModule && advertised > limits.moduleBytes) throw limit('module.risum exceeds limit');
      if (!rootCard && !rootModule && !name.endsWith('.json') && advertised > limits.assetBytes) {
        excludedFiles.push(name); warnings.push(`Excluded oversized asset: ${name}`);
        let crc = 0xffffffff;
        file.ondata = (err, data, final) => {
          if (err) { currentError = invalid('Unsupported or corrupt ZIP entry'); return; }
          crc = crc32Update(crc, data);
          decompressed += data.length;
          if (decompressed > limits.decompressedBytes) currentError = limit('Archive exceeds decompressed limit');
          if (final && ((crc ^ 0xffffffff) >>> 0) !== extractingEntry.crc) currentError = invalid('ZIP entry CRC mismatch');
        };
        file.start(); return;
      }
      if (rootCard && ++cardCount > 1) throw invalid('Archive must contain exactly one card.json');
      if (rootModule && ++moduleCount > 1) throw invalid('Archive may contain only one module.risum');
      const ignored = (!rootCard && !rootModule && name.endsWith('.json'));
      const state = { name, kind: rootCard ? 'card' : rootModule ? 'module' : ignored ? 'ignored' : 'asset', size: 0, chunks: [], excluded: false, fd: undefined, sourcePath: undefined, hash: undefined, crc: 0xffffffff, expectedCrc: extractingEntry.crc };
      if (state.kind === 'asset') {
        state.sourcePath = path.join(ownedDir, `asset-${randomBytes(16).toString('hex')}`);
        state.fd = fs.openSync(state.sourcePath, 'wx');
        state.hash = createHash('sha256');
      }
      active.add(state);
      file.ondata = (err, data, final) => {
        try {
          if (err) throw invalid('Unsupported or corrupt ZIP entry');
          checkAbort();
          decompressed += data.length;
          if (decompressed > limits.decompressedBytes) throw limit('Archive exceeds decompressed limit');
          state.crc = crc32Update(state.crc, data);
          state.size += data.length;
          if (state.kind === 'card') {
            if (state.size > limits.cardBytes) throw limit('card.json exceeds limit');
            state.chunks.push(Buffer.from(data));
          } else if (state.kind === 'module') {
            if (state.size > limits.moduleBytes) throw limit('module.risum exceeds limit');
            state.chunks.push(Buffer.from(data));
          } else if (state.kind === 'asset' && !state.excluded) {
            if (state.size > limits.assetBytes) {
              state.excluded = true;
              fs.closeSync(state.fd); state.fd = undefined;
              try { fs.unlinkSync(state.sourcePath); } catch {}
              excludedFiles.push(state.name); warnings.push(`Excluded oversized asset: ${state.name}`);
            } else {
              // UnzipInflate and writeSync are synchronous: queued decompressed write bytes are always zero.
              checkSpace('asset-write', data.length);
              fs.writeSync(state.fd, data);
              state.hash.update(data);
            }
          }
          if (final) { if (((state.crc ^ 0xffffffff) >>> 0) !== state.expectedCrc) throw invalid('ZIP entry CRC mismatch'); active.delete(state); if (state.kind === 'asset') closeAsset(state); else if (state.kind === 'card') cards.push(state.chunks); else if (state.kind === 'module') modules.push(state.chunks); }
        } catch (e) { currentError = normalizeError(e, invalid('Unable to extract archive entry')); }
      };
      file.start();
    } catch (e) { currentError = normalizeError(e, invalid('Unable to read archive entry')); }
  });
  unzip.register(UnzipInflate);
  try {
    for await (const input of source) {
      checkAbort();
      const chunk = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (chunk.length >= zipTail.length) { zipTail.set(chunk.subarray(chunk.length - zipTail.length)); zipTailLength = zipTail.length; }
      else {
        const keep = Math.min(zipTailLength, zipTail.length - chunk.length);
        if (keep) zipTail.copyWithin(0, zipTailLength - keep, zipTailLength);
        zipTail.set(chunk, keep); zipTailLength = keep + chunk.length;
      }
      compressed += chunk.length;
      if (compressed > limits.compressedBytes) throw limit('Compressed archive exceeds limit');
      checkSpace('archive-write', chunk.length);
      fs.writeSync(archiveFd, chunk);
      checkAbort();
      onProgress({ compressedBytes: compressed, decompressedBytes: decompressed });
    }
    checkAbort();
    let eocd = -1;
    for (let i = zipTailLength - 22; i >= 0; i--) {
      if (zipTail[i] === 0x50 && zipTail[i + 1] === 0x4b && zipTail[i + 2] === 0x05 && zipTail[i + 3] === 0x06 && i + 22 + zipTail[i + 20] + (zipTail[i + 21] << 8) === zipTailLength) { eocd = i; break; }
    }
    if (eocd < 0) throw invalid('Truncated or invalid ZIP archive');
    const eocdAbsolute = compressed - zipTailLength + eocd;
    fs.fsyncSync(archiveFd); fs.closeSync(archiveFd); archiveFd = undefined;
    const readFd = fs.openSync(archivePath, 'r');
    let entries;
    try { entries = validateCentralDirectory(readFd, compressed, eocdAbsolute, limits.entries); } finally { fs.closeSync(readFd); }
    const extractionTotal = entries.reduce((total, entry) => total + entry.originalSize, 0);
    let extractionCompleted = 0;
    // Source upload is finished and ZIP metadata is valid; now report bounded
    // per-entry work that the browser can render as server-side processing.
    onProgress({ phase: 'extracting', completed: 0, total: extractionTotal });
    const extractFd = fs.openSync(archivePath, 'r');
    try {
      for (const entry of entries) {
        checkAbort();
        extractingEntry = entry;
        const header = readExact(extractFd, entry.localOffset, entry.headerLength);
        header[6] &= ~8; header.writeUInt32LE(entry.crc, 14); header.writeUInt32LE(entry.compressedSize, 18); header.writeUInt32LE(entry.originalSize, 22);
        // Unzip waits for one byte past a zero-length local header before delivering its final empty chunk.
        unzip.push(entry.compressedSize ? header : Buffer.concat([header, Buffer.from([0])]), false);
        for (let position = entry.dataOffset, remaining = entry.compressedSize; remaining;) {
          const length = Math.min(remaining, 64 * 1024);
          unzip.push(readExact(extractFd, position, length), false);
          position += length; remaining -= length; checkAbort();
        }
        extractionCompleted += entry.originalSize;
        onProgress({ phase: 'extracting', completed: extractionCompleted, total: extractionTotal });
      }
      extractingEntry = undefined;
      unzip.push(new Uint8Array(0), true);
    } catch (e) { throw currentError || normalizeError(e, invalid('Invalid or unsupported ZIP archive')); } finally { fs.closeSync(extractFd); }
    checkAbort();
    if (active.size) throw invalid('Truncated ZIP archive');
    // This is the only terminal marker. Per-entry events may also reach the
    // total when trailing ZIP entries are empty, so callers must not infer
    // completion from numeric equality alone.
    onProgress({ phase: 'extracting', completed: extractionTotal, total: extractionTotal, terminal: true });
    if (cardCount !== 1 || cards.length !== 1) throw invalid('Archive must contain exactly one card.json');
    const card = utf8Json(cards[0]);
    if (!card || card.spec !== 'chara_card_v3') throw invalid('card.json must be a chara_card_v3 card');
    const moduleBase64 = modules.length ? Buffer.concat(modules[0]).toString('base64') : null;
    let stagedBytes = 0;
    for (const sourcePath of assetFiles.values()) stagedBytes += fs.statSync(sourcePath).size;
    checkSpace('publish', stagedBytes);
    const published = [...assetFiles.entries()].map(([key, sourcePath]) => ({ key, sourcePath }));
    try { await publishAssets(published); } catch (e) { if (e && e.code === 'ENOSPC') throw noSpace(); throw new CharXImportError('ASSET_COMMIT_FAILED', 'Unable to publish CharX assets', 500); }
    return { card, moduleBase64, assets, excludedFiles, warnings };
  } catch (e) {
    throw normalizeError(e);
  } finally {
    try { if (archiveFd !== undefined) fs.closeSync(archiveFd); } catch {}
    // UnzipInflate is synchronous and has no terminate()/worker to release; close every file descriptor before removing the owned directory.
    for (const state of active) { try { if (state.fd !== undefined) fs.closeSync(state.fd); } catch {} }
    try { await fsp.rm(ownedDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { CharXImportError, DEFAULT_CHARX_LIMITS, importCharXStream };
