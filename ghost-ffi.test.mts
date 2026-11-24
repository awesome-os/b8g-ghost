import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ghostFFI, ghostFFIByName, sha256Buffer } from './ghost-ffi.mts';

test('ghostFFI hydrates cold CAS, hits warm CAS, supports side-by-side versions, and disposes cleanly', async () => {
  const casDir = mkdtempSync(join(tmpdir(), 'b8g-ghost-ffi-'));
  try {
    const v1Bytes = new TextEncoder().encode('fake-v1-shared-lib-binary');
    const v2Bytes = new TextEncoder().encode('fake-v2-shared-lib-binary');
    const v1Hash = sha256Buffer(v1Bytes);
    const v2Hash = sha256Buffer(v2Bytes);
    let fetchCount = 0;

    const fakeFetcher = async (url: string): Promise<Uint8Array> => {
      fetchCount++;
      return url.includes('v1.0.0') ? v1Bytes : v2Bytes;
    };

    // 1. Cold CAS miss -> downloads & verifies v1
    const libV1 = await ghostFFI('awesome-os/sectium-browser@v1.0.0', {
      lib: 'libsectium_display',
      sha256: v1Hash,
      casDir,
      fetcher: fakeFetcher,
      symbols: {
        sectium_display_init: { args: ['ptr'], returns: 'i32' },
      },
    });
    assert.equal(libV1.casHit, false);
    assert.equal(fetchCount, 1);
    assert.equal(libV1.symbols.sectium_display_init(0x1000), 0);

    // 2. Warm CAS hit -> zero network fetches
    const libV1Warm = await ghostFFI('awesome-os/sectium-browser@v1.0.0', {
      lib: 'libsectium_display',
      sha256: v1Hash,
      casDir,
      fetcher: fakeFetcher,
      symbols: {
        sectium_display_init: { args: ['ptr'], returns: 'i32' },
      },
    });
    assert.equal(libV1Warm.casHit, true);
    assert.equal(fetchCount, 1);

    // 3. Side-by-side v2 in the exact same process (different SHA-256 CAS slot, zero conflict)
    const libV2 = await ghostFFI('awesome-os/sectium-browser@v2.0.0', {
      lib: 'libsectium_display',
      sha256: v2Hash,
      casDir,
      fetcher: fakeFetcher,
      symbols: {
        sectium_display_init: { args: ['ptr'], returns: 'i32' },
      },
    });
    assert.equal(libV2.casHit, false);
    assert.notEqual(libV1.resolvedPath, libV2.resolvedPath);

    // 4. Clean dispose rejects subsequent calls
    libV1.dispose();
    assert.equal(libV1.disposed, true);
    assert.throws(() => libV1.symbols.sectium_display_init(0x1000), /has been disposed/);
    // v2 remains completely unaffected
    assert.equal(libV2.symbols.sectium_display_init(0x2000), 0);
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('ghostFFI rejects tampered binaries on SHA-256 mismatch', async () => {
  const casDir = mkdtempSync(join(tmpdir(), 'b8g-ghost-bad-'));
  try {
    const goodHash = sha256Buffer(new TextEncoder().encode('expected-good-binary'));
    await assert.rejects(
      () =>
        ghostFFI('awesome-os/sectium-browser@v0.5.0-baseline', {
          lib: 'libsectium_display',
          sha256: goodHash,
          casDir,
          fetcher: async () => new TextEncoder().encode('tampered-malicious-binary'),
          symbols: { init: { args: [], returns: 'i32' } },
        }),
      /Ghost SHA-256 mismatch/
    );
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('ghostFFIByName auto-resolves native OS or wasm32-wasi fallback from unified ghost-index.json', async () => {
  const casDir = mkdtempSync(join(tmpdir(), 'b8g-ghost-idx-'));
  try {
    const winBytes = new TextEncoder().encode('brotli-win64-dll-bytes');
    const wasiBytes = new TextEncoder().encode('sqlite-wasi-wasm-bytes');
    const winHash = sha256Buffer(winBytes);
    const wasiHash = sha256Buffer(wasiBytes);

    const mockIndex = {
      schema: 'b8g-ghost-unified-index-v1',
      baseline_tag: 'v0.7.0-baseline',
      entries: {
        'libbrotli-win64.dll': {
          filename: 'libbrotli-win64.dll',
          sha256: winHash,
          download_url: 'https://github.com/awesome-os/upstream-mirrors/releases/download/v0.2.0-holo-5os/libbrotli-win64.dll',
        },
        'libsqlite3-wasm32-wasi.wasm': {
          filename: 'libsqlite3-wasm32-wasi.wasm',
          sha256: wasiHash,
          download_url: 'https://github.com/awesome-os/upstream-mirrors/releases/download/v0.2.0-holo-5os/libsqlite3-wasm32-wasi.wasm',
        },
      },
    };

    const fetcher = async (url: string): Promise<Uint8Array> =>
      url.endsWith('.wasm') ? wasiBytes : winBytes;

    // 1. Native Win64 match
    const brotli = await ghostFFIByName('libbrotli', {
      index: mockIndex,
      platform: 'win32',
      casDir,
      fetcher,
      symbols: { BrotliDecoderVersion: { args: [], returns: 'u32' } },
    });
    assert.equal(brotli.sha256, winHash);
    assert.equal(brotli.casHit, false);

    // 2. Automatic wasm32-wasi fallback when native OS binary isn't in index
    const sqlite = await ghostFFIByName('libsqlite3', {
      index: mockIndex,
      platform: 'linux',
      arch: 'arm64',
      casDir,
      fetcher,
      symbols: { sqlite3_libversion_number: { args: [], returns: 'i32' } },
    });
    assert.equal(sqlite.sha256, wasiHash);
    assert.ok(sqlite.resolvedPath.endsWith('libsqlite3-wasm32-wasi.wasm'));
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});
