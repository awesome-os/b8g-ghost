import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_GHOST_INDEX_URL } from './ghost-ffi.mts';
import { compileToNativeGhost } from './ghost-wasm-jit.mts';

const req = createRequire(import.meta.url);
const addonPath = resolve(process.cwd(), 'sections', 'b8g-ghost', 'b8g-ghost-abi.node');
const ghostAbi = req(addonPath) as {
  abiInfo(): { abiMagic: number; ghostMagic: number; name: string };
  resolve(filename: string, sha256Hex: string, downloadUrl: string): { path: string; casHit: boolean };
  dlopen(path: string): bigint;
  callU32_0(handle: bigint, symbolName: string): number;
  callI32_1(handle: bigint, symbolName: string, arg0: number): number;
  createArena(byteLength: number): ArrayBuffer;
};

test('b8g-ghost-abi.node: N-API zero-node-gyp addon exposes B8G_ABI_MAGIC_V3 + zero-copy B8G_ARENA_V1', () => {
  const info = ghostAbi.abiInfo();
  assert.equal(info.abiMagic, 0x33564742);
  assert.equal(info.ghostMagic, 0x54534847);
  assert.equal(info.name, 'b8g-ghost-abi.node');

  const arena = ghostAbi.createArena(4096);
  assert.equal(arena.byteLength, 4096);
  const view = new Uint32Array(arena);
  assert.equal(view[0], 0x33564742);
});

test('b8g-ghost-abi.node: live O(1) cas-v1 hydration + real native BrotliDecoderVersion() call', async () => {
  const idx = (await (await fetch(DEFAULT_GHOST_INDEX_URL)).json()) as {
    entries: Record<string, { filename: string; sha256: string; download_url: string }>;
  };
  const brotli = idx.entries['libbrotli-win64.dll'];
  assert.ok(brotli, 'libbrotli-win64.dll must exist in canonical cas-v1 index');

  const res = ghostAbi.resolve(brotli.filename, brotli.sha256, brotli.download_url);
  assert.ok(res.path.endsWith('libbrotli-win64.dll'));
  const handle = ghostAbi.dlopen(res.path);
  assert.ok(handle > 0n);

  const ver = ghostAbi.callU32_0(handle, 'BrotliDecoderVersion');
  assert.ok(ver > 0x01000000, `Expected Brotli >= 1.x version, got 0x${ver.toString(16)}`);
  console.log(`[b8g-ghost-abi.node] LIVE Native BrotliDecoderVersion() = 0x${ver.toString(16)} (casHit=${res.casHit})`);
});

test('b8g-ghost-abi.node: Dual-Tier Ghost CAS-JIT compiles C -> native .dll and executes fib(30) == 832040 in Node', () => {
  const jit = compileToNativeGhost({
    name: 'ghost_jit_fib',
    source: `
      __declspec(dllexport) int fib(int n) {
        int a = 0, b = 1;
        for (int i = 0; i < n; i++) { int t = a + b; a = b; b = t; }
        return a;
      }
    `,
  });
  const handle = ghostAbi.dlopen(jit.libPath);
  const fib30 = ghostAbi.callI32_1(handle, 'fib', 30);
  assert.equal(fib30, 832040);
  console.log(`[b8g-ghost-abi.node] LIVE Native CAS-JIT fib(30) = ${fib30} (casHit=${jit.casHit}, ${jit.compileMs.toFixed(1)}ms)`);
});
