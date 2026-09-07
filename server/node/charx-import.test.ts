import { describe, expect, test, vi } from 'vitest';
import { zipSync, strToU8, deflateSync, Zip, ZipPassThrough } from 'fflate';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { importCharXStream, DEFAULT_CHARX_LIMITS } = require('./charx-import.cjs');
const fsSync = require('node:fs');

async function* chunks(bytes: Uint8Array, size = 13) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

function withJpegPreamble(archive: Uint8Array, length = 326_838) {
  const preamble = new Uint8Array(length).fill(0);
  preamble.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const prefixed = new Uint8Array(preamble.length + archive.length);
  prefixed.set(preamble); prefixed.set(archive, preamble.length);
  return prefixed;
}

async function writeLargeCharX(destination: string) {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination);
    const zip = new Zip((error, data, final) => {
      if (error) { reject(error); return; }
      output.write(data);
      if (final) output.end();
    });
    output.once('error', reject); output.once('finish', resolve);
    const card = new ZipPassThrough('card.json'); zip.add(card); card.push(strToU8('{"spec":"chara_card_v3"}'), true);
    const oneMiB = new Uint8Array(1024 * 1024).fill(71);
    for (let assetIndex = 0; assetIndex < 3; assetIndex++) {
      const asset = new ZipPassThrough(`large-${assetIndex}.png`); zip.add(asset);
      for (let part = 0; part < 44; part++) asset.push(oneMiB, part === 43);
    }
    zip.end();
  });
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function u16le(value: number) { const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, value, true); return out; }
function u32le(value: number) { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return out; }
function zipWithDescriptors(signed: boolean, assetText = 'pixels', method = 0) {
  const records: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const [name, text] of [['card.json', '{"spec":"chara_card_v3"}'], ['a.png', assetText]] as const) {
    const nameBytes = strToU8(name), data = strToU8(text), compressed = method ? deflateSync(data, { level: 0 }) : data, crc = crc32(data);
    // Bit 3 means the local CRC and sizes are intentionally unknown until the data descriptor.
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16le(20), u16le(8), u16le(method), u16le(0), u16le(0), u32le(0), u32le(0), u32le(0), u16le(nameBytes.length), u16le(0), nameBytes, compressed, ...(signed ? [Buffer.from([0x50, 0x4b, 0x07, 0x08])] : []), u32le(crc), u32le(compressed.length), u32le(data.length)]);
    records.push(local);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16le(20), u16le(20), u16le(8), u16le(method), u16le(0), u16le(0), u32le(crc), u32le(compressed.length), u32le(data.length), u16le(nameBytes.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(0), u32le(offset), nameBytes]));
    offset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  return Buffer.concat([...records, centralBytes, Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16le(0), u16le(0), u16le(2), u16le(2), u32le(centralBytes.length), u32le(offset), u16le(0)]);
}

async function rootDuplicateZip(rootName: 'card.json' | 'module.risum') {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const pieces: Uint8Array[] = [];
    const zip = new Zip((error, data, final) => { if (error) reject(error); else { pieces.push(data); if (final) resolve(Buffer.concat(pieces)); } });
    for (const [name, content] of [['card.json', '{"spec":"chara_card_v3"}'], [rootName, rootName === 'card.json' ? '{"spec":"chara_card_v3"}' : 'one'], [rootName, rootName === 'card.json' ? '{"spec":"chara_card_v3"}' : 'two']] as const) {
      const entry = new ZipPassThrough(name); zip.add(entry); entry.push(strToU8(content), true);
    }
    zip.end();
  });
}

describe('importCharXStream', () => {
  test('imports a ZIP with a JPEG preamble whose offsets remain ZIP-relative', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const card = { spec: 'chara_card_v3', name: 'Ada' };
    const archive = withJpegPreamble(zipSync({ 'card.json': strToU8(JSON.stringify(card)), 'a.png': strToU8('pixels') }));
    const calls: unknown[] = [];
    try {
      const result = await importCharXStream(chunks(archive), {
        stagingRoot,
        publishAssets: async (entries: unknown[]) => calls.push(entries),
      });
      expect(result.card).toEqual(card);
      expect(Object.keys(result.assets)).toEqual(['a.png']);
      expect(calls).toHaveLength(1);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects a corrupted central local offset in a JPEG-prefixed ZIP before publishing', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = withJpegPreamble(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('pixels') }));
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const eocdOffset = archive.length - 22;
    const actualCentralOffset = eocdOffset - view.getUint32(eocdOffset + 12, true);
    view.setUint32(actualCentralOffset + 42, view.getUint32(actualCentralOffset + 42, true) + 1, true);
    let published = 0;
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => { published++; } }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
      expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('imports a valid card-only archive and publishes only after validation', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const card = { spec: 'chara_card_v3', name: 'Ada' };
    const archive = zipSync({ 'card.json': strToU8(JSON.stringify(card)) });
    const calls: unknown[] = [];
    try {
      const result = await importCharXStream(chunks(archive), {
        stagingRoot,
        publishAssets: async (entries: unknown[]) => calls.push(entries),
      });
      expect(result.card).toEqual(card);
      expect(result.moduleBase64).toBeNull();
      expect(result.assets).toEqual({});
      expect(calls).toEqual([[]]);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('imports module and content-addressed duplicate assets', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({
      'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3' })),
      'module.risum': strToU8('module'),
      'a.png': strToU8('pixels'),
      'nested/b.png': strToU8('pixels'),
      'ignored.json': strToU8('{"x":1}'),
    });
    let published: any[] = [];
    try {
      const result = await importCharXStream(chunks(archive), {
        stagingRoot,
        publishAssets: async (entries: any[]) => { published = entries; await Promise.all(entries.map((e) => readFile(e.sourcePath))); },
      });
      expect(result.moduleBase64).toBe(Buffer.from('module').toString('base64'));
      expect(Object.keys(result.assets)).toEqual(['a.png', 'nested/b.png']);
      expect(new Set(Object.values(result.assets)).size).toBe(1);
      expect(published).toHaveLength(1);
      expect(new Set(Object.values(result.assets))).toEqual(new Set(published.map((entry) => entry.key)));
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('reports bounded extraction progress only after the source is consumed and finishes complete', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('pixels') });
    let sourceConsumed = false;
    const extractionProgress: any[] = [];
    async function* source() {
      yield archive;
      sourceConsumed = true;
    }
    try {
      await importCharXStream(source(), {
        stagingRoot,
        publishAssets: async () => {},
        onProgress: progress => {
          if (progress.phase === 'extracting') {
            expect(sourceConsumed).toBe(true);
            extractionProgress.push(progress);
          }
        },
      });
      expect(extractionProgress[0]).toMatchObject({ phase: 'extracting', completed: 0, total: expect.any(Number) });
      expect(extractionProgress.at(-1)).toMatchObject({ phase: 'extracting', completed: extractionProgress.at(-1).total });
      expect(extractionProgress.filter((progress) => progress.terminal)).toEqual([extractionProgress.at(-1)]);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test.each([
    ['missing card', { 'x.png': strToU8('x') }],
    ['non-v3 card', { 'card.json': strToU8('{"spec":"v2"}') }],
    ['malformed card', { 'card.json': strToU8('{') }],
    ['unsafe backslash name', { 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a\\b.png': strToU8('x') }],
  ])('rejects %s as INVALID_CHARX', async (_name, files) => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(zipSync(files)), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX', status: 400 });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects truncated archives and malformed UTF-8 card text', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const valid = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    const badUtf8 = zipSync({ 'card.json': new Uint8Array([0xc3, 0x28]) });
    try {
      await expect(importCharXStream(chunks(valid.subarray(0, valid.length - 5)), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
      await expect(importCharXStream(chunks(badUtf8), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('enforces compressed and metadata limits', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3', text: 'long-value' })) });
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, limits: { cardBytes: 3 } }))
        .rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, limits: { compressedBytes: 1 } }))
        .rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('excludes an oversized asset but imports the card', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'big.png': strToU8('12345') });
    try {
      const result = await importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, limits: { assetBytes: 3 } });
      expect(result.assets).toEqual({});
      expect(result.excludedFiles).toEqual(['big.png']);
      expect(result.warnings).toHaveLength(1);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('ignores directory entries and reports progress while streaming', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'nested/': [new Uint8Array(), { level: 0 }], 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'nested/a.png': strToU8('x') });
    const progress: any[] = [];
    try {
      const result = await importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, onProgress: (p: any) => progress.push(p) });
      expect(result.assets['nested/a.png']).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
      expect(progress.length).toBeGreaterThan(1);
      expect(progress.filter((event) => !event.phase).at(-1).compressedBytes).toBe(archive.length);
      expect(await (await import('node:fs/promises')).readdir(stagingRoot)).toEqual([]);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('checks disk space before import and before publishing assets', async () => {
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('abc') });
    const lowRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const publishRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot: lowRoot, expectedCompressedBytes: archive.length, getAvailableBytes: () => 0, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
      let calls = 0;
      await expect(importCharXStream(chunks(archive), { stagingRoot: publishRoot, getAvailableBytes: () => ++calls < 3 ? 999999999 : 0, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
    } finally { await Promise.all([rm(lowRoot, { recursive: true, force: true }), rm(publishRoot, { recursive: true, force: true })]); }
  });

  test('rejects asynchronous capacity callbacks because writes require a synchronous answer', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      const result = importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') })), { stagingRoot, getAvailableBytes: async () => Number.MAX_SAFE_INTEGER, publishAssets: async () => {} });
      await expect(result).rejects.toBeInstanceOf(TypeError);
      await expect(result).rejects.toThrow('getAvailableBytes must return a finite number synchronously');
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('checks capacity at the asset-write phase for descriptor assets with unknown metadata', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0; const phases: string[] = [];
    try {
      await expect(importCharXStream(chunks(zipWithDescriptors(false)), { stagingRoot, getAvailableBytes: ({ phase }: any) => { phases.push(phase); return phase === 'asset-write' ? 0 : Number.MAX_SAFE_INTEGER; }, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
      expect(phases).toContain('asset-write'); expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('checks capacity at true prepublish only after successful staging', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0; const phases: string[] = [];
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('asset') });
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, getAvailableBytes: ({ phase }: any) => { phases.push(phase); return phase === 'publish' ? 0 : Number.MAX_SAFE_INTEGER; }, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE', status: 507 });
      expect(phases).toContain('publish'); expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('uses actual asset writes for capacity when central advertised size is forged low', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0; const phases: string[] = [];
    const forged = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': new Uint8Array(1024).fill(7) });
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength); let central = view.getUint32(forged.length - 6, true);
    central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
    view.setUint32(central + 24, 0, true);
    try {
      await expect(importCharXStream(chunks(forged), { stagingRoot, getAvailableBytes: ({ phase }: any) => { phases.push(phase); return phase === 'asset-write' ? 0 : Number.MAX_SAFE_INTEGER; }, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
      expect(phases).toContain('asset-write'); expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('aborts and removes its owned staging directory on publish failure', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('abc') });
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => { throw new Error('no'); } }))
        .rejects.toMatchObject({ code: 'ASSET_COMMIT_FAILED' });
      expect((await (await import('node:fs/promises')).readdir(stagingRoot))).toEqual([]);
      const controller = new AbortController(); controller.abort();
      await expect(importCharXStream(chunks(archive), { stagingRoot, signal: controller.signal, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'IMPORT_ABORTED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('uses stable abort and asset-commit error codes and null for no module', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    try {
      const controller = new AbortController(); controller.abort();
      await expect(importCharXStream(chunks(archive), { stagingRoot, signal: controller.signal, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'IMPORT_ABORTED' });
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => { throw new Error('no'); } }))
        .rejects.toMatchObject({ code: 'ASSET_COMMIT_FAILED' });
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {} }))
        .resolves.toMatchObject({ moduleBase64: null });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects EOCD central-directory count mismatches', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    // EOCD has total central-directory entry count at -12.
    const corrupt = archive.slice(); corrupt[corrupt.length - 12] = 2;
    try {
      await expect(importCharXStream(chunks(corrupt), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects forged central names that do not match their local header', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    const forged = archive.slice();
    const centralOffset = new DataView(forged.buffer, forged.byteOffset, forged.byteLength).getUint32(forged.length - 6, true);
    forged[centralOffset + 46] = 'z'.charCodeAt(0);
    try {
      await expect(importCharXStream(chunks(forged), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects a decodable stored payload whose bytes no longer match the validated CRC', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0;
    const corrupt = zipWithDescriptors(false); const view = new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength);
    let central = view.getUint32(corrupt.length - 6, true);
    central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
    const localOffset = view.getUint32(central + 42, true); const nameLength = view.getUint16(localOffset + 26, true);
    corrupt[localOffset + 30 + nameLength] ^= 1;
    try {
      await expect(importCharXStream(chunks(corrupt), { stagingRoot, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects a non-empty directory before extraction or publishing', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0;
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'dir/': strToU8('not-empty') });
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test.each([true, false])('imports a valid %s data-descriptor archive', async (signed) => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0;
    const archive = zipWithDescriptors(signed); const descriptorAt = 30 + 'card.json'.length + strToU8('{"spec":"chara_card_v3"}').length;
    const readSpy = vi.spyOn(fsSync, 'readSync');
    try {
      await expect(importCharXStream(chunks(archive, 7), { stagingRoot, publishAssets: async () => { published++; } })).resolves.toMatchObject({ assets: { 'a.png': expect.any(String) } });
      expect(published).toBe(1);
      expect(readSpy.mock.calls.some((call) => call[4] === descriptorAt && call[3] === 4)).toBe(true);
      expect(readSpy.mock.calls.some((call) => call[4] === descriptorAt + 4 && call[3] === (signed ? 12 : 8))).toBe(true);
    } finally { readSpy.mockRestore(); await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('does not mistake a stored payload collision for an unsigned data descriptor', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); const payload = Buffer.alloc(64, 65); let published = Buffer.alloc(0);
    // At byte 20, this has descriptor-shaped compressed/original sizes but a deliberately wrong CRC.
    payload.writeUInt32LE(20, 24); payload.writeUInt32LE(20, 28);
    try {
      await expect(importCharXStream(chunks(zipWithDescriptors(false, payload.toString('latin1')), 64), { stagingRoot, publishAssets: async (entries: any[]) => { published = await readFile(entries[0].sourcePath); } })).resolves.toMatchObject({ assets: { 'a.png': expect.any(String) } });
      expect(published).toEqual(payload);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('extracts a deflated unknown-size descriptor entry without interpreting compressed payload bytes', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); const payload = Buffer.alloc(64, 65); let published = Buffer.alloc(0);
    // level-0 DEFLATE has a five-byte stored-block prefix, so byte 20 begins at compressed offset 25.
    payload.writeUInt32LE(25, 24); payload.writeUInt32LE(25, 28);
    try {
      await expect(importCharXStream(chunks(zipWithDescriptors(false, payload.toString('latin1'), 8), 64), { stagingRoot, publishAssets: async (entries: any[]) => { published = await readFile(entries[0].sourcePath); } })).resolves.toMatchObject({ assets: { 'a.png': expect.any(String) } });
      expect(published).toEqual(payload);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects duplicate normalized central names before their unchanged local headers diverge', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0;
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('a'), 'b.png': strToU8('b') });
    const forged = archive.slice(); const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
    const central = view.getUint32(forged.length - 6, true); let second = central;
    for (let found = 0; found < 2; found++) second += 46 + view.getUint16(second + 28, true) + view.getUint16(second + 30, true) + view.getUint16(second + 32, true);
    forged.set(strToU8('a.png'), second + 46);
    try {
      await expect(importCharXStream(chunks(forged), { stagingRoot, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('enforces advertised and actual metadata, entry and total decompressed limits', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const base = { 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'module.risum': strToU8('module'), 'a.png': strToU8('asset') };
    try {
      await expect(importCharXStream(chunks(zipSync(base)), { stagingRoot, publishAssets: async () => {}, limits: { entries: 2 } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
      await expect(importCharXStream(chunks(zipSync(base)), { stagingRoot, publishAssets: async () => {}, limits: { moduleBytes: 2 } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
      await expect(importCharXStream(chunks(zipSync(base)), { stagingRoot, publishAssets: async () => {}, limits: { decompressedBytes: 3 } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects an over-limit central entry count before extracting any entry payload', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-')); let published = 0;
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('first'), 'b.png': strToU8('second') });
    const firstDataOffset = 30 + 'card.json'.length;
    const readSpy = vi.spyOn(fsSync, 'readSync');
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, limits: { entries: 2 }, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED', status: 413 });
      expect(published).toBe(0);
      expect(readSpy.mock.calls.some((call) => call[4] === firstDataOffset)).toBe(false);
    } finally { readSpy.mockRestore(); await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test.each(['../a.png', '/a.png', 'C:a.png', 'a\\b.png', 'a/./b.png', 'a/../b.png'])('rejects unsafe name %s', async (name) => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), [name]: strToU8('x') })), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects NFC duplicate names while preserving case-sensitive names', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'é.png': strToU8('x'), 'é.png': strToU8('y') })), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('x'), 'A.png': strToU8('y') })), { stagingRoot, publishAssets: async () => {} })).resolves.toMatchObject({ assets: expect.objectContaining({ 'a.png': expect.any(String), 'A.png': expect.any(String) }) });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('preserves a decomposed Unicode asset name referenced verbatim by card.json', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const assetName = 'assets/e\u0301.png';
    const card = { spec: 'chara_card_v3', image: assetName };
    try {
      const result = await importCharXStream(chunks(zipSync({
        'card.json': strToU8(JSON.stringify(card)),
        [assetName]: strToU8('pixels'),
      })), { stagingRoot, publishAssets: async () => {} });
      expect(result.card.image).toBe(assetName);
      expect(Object.keys(result.assets)).toEqual([assetName]);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('maps staging ENOSPC to insufficient storage and cleans staging', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const fs = require('node:fs');
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => { const e: any = new Error('full'); e.code = 'ENOSPC'; throw e; });
    try {
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('x') })), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE', status: 507 });
      expect(await (await import('node:fs/promises')).readdir(stagingRoot)).toEqual([]);
    } finally { spy.mockRestore(); await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('aborts without source read-ahead, finalizes the source, and closes staging files', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const asset = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31) & 255);
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': asset });
    const controller = new AbortController(); const sourceChunkSize = Math.ceil(archive.length / 2); let reads = 0, finalized = false, published = 0; const events: string[] = [];
    const originalWriteSync = fsSync.writeSync.bind(fsSync);
    const writeSpy = vi.spyOn(fsSync, 'writeSync').mockImplementation((...args: any[]) => { events.push('write'); return originalWriteSync(...args); });
    async function* source() { try { for (let at = 0; at < archive.length; at += sourceChunkSize) { reads++; events.push(`source:${reads}`); yield archive.subarray(at, at + sourceChunkSize); if (reads === 1) controller.abort(); } } finally { finalized = true; } }
    try {
      await expect(importCharXStream(source(), { stagingRoot, signal: controller.signal, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'IMPORT_ABORTED' });
      expect(reads).toBe(2); // The for-await loop requests at most one input chunk ahead of its completed synchronous writes.
      expect(finalized).toBe(true); expect(published).toBe(0);
      expect(events.indexOf('write')).toBeGreaterThan(events.indexOf('source:1'));
      expect(events.indexOf('source:2')).toBeGreaterThan(events.indexOf('write'));
      expect(events.slice(0, events.indexOf('source:2')).filter((event) => event === 'write')).toHaveLength(1);
      expect(sourceChunkSize).toBeLessThanOrEqual(DEFAULT_CHARX_LIMITS.queuedWriteBytes);
      expect(await (await import('node:fs/promises')).readdir(stagingRoot)).toEqual([]);
    } finally { writeSpy.mockRestore(); await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects encrypted and unsupported-compression local entries', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    const encrypted = archive.slice(); encrypted[6] |= 1;
    const unsupported = archive.slice(); unsupported[8] = 99;
    try {
      await expect(importCharXStream(chunks(encrypted), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      await expect(importCharXStream(chunks(unsupported), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test.each(['card.json', 'module.risum'] as const)('rejects duplicate root %s from an otherwise-valid archive before publishing', async (duplicate) => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    let published = 0;
    try {
      await expect(importCharXStream(chunks(await rootDuplicateZip(duplicate)), { stagingRoot, publishAssets: async () => { published++; } })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      expect(published).toBe(0);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('imports a 132 MiB archive from an fs stream without retaining archive data', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archivePath = join(stagingRoot, 'large.charx');
    try {
      await writeLargeCharX(archivePath);
      let maxReadChunk = 0;
      async function* source() {
        for await (const chunk of createReadStream(archivePath, { highWaterMark: 64 * 1024 })) {
          maxReadChunk = Math.max(maxReadChunk, chunk.length); yield chunk;
        }
      }
      const result = await importCharXStream(source(), {
        stagingRoot,
        publishAssets: async (entries: any[]) => { await Promise.all(entries.map((entry) => readFile(entry.sourcePath))); },
      });
      expect(Object.keys(result.assets)).toHaveLength(3);
      expect(maxReadChunk).toBeLessThanOrEqual(64 * 1024);
      expect((await (await import('node:fs/promises')).readdir(stagingRoot)).sort()).toEqual(['large.charx']);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  }, 120_000);
});

describe('the entry-count guard', () => {
  test('refuses one entry past the limit and accepts the limit itself', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-entries-'));
    const build = (count: number) => {
      const files: Record<string, Uint8Array> = { 'card.json': strToU8('{"spec":"chara_card_v3"}') };
      for (let index = 0; index < count; index++) files[`a${index}.png`] = strToU8('p');
      return zipSync(files);
    };
    const run = (count: number, entries: number) => importCharXStream(
      chunks(build(count)),
      { stagingRoot, publishAssets: async () => {}, limits: { entries } },
    );

    await expect(run(4, 5)).resolves.toBeDefined();
    await expect(run(5, 5)).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
    // The shipped value, so raising or lowering it cannot go unnoticed.
    expect(DEFAULT_CHARX_LIMITS.entries).toBe(50000);
  });
});
