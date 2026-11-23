import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ghostFFI, sha256Buffer } from './ghost-ffi.mts';

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
