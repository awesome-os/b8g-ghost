import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileToNativeGhost, instantiateWasmGhost } from './ghost-wasm-jit.mts';

const FIB_SRC_V1 = `
int fib(int n) {
  int a = 0;
  int b = 1;
  for (int i = 0; i < n; i++) {
    int tmp = a + b;
    a = b;
    b = tmp;
  }
  return a;
}
`;

// Semantically identical (only comments, whitespace, and local variable names changed!)
const FIB_SRC_NOISE = `
// Refactored comments & local names — MUST hit the exact same Ghost CAS key!
int fib(int count) {
  int prev = 0;
  int curr = 1;
  for (int idx = 0; idx < count; idx++) {
    int next = prev + curr;
    prev = curr;
    curr = next;
  }
  return prev;
}
`;

test('Tier 1: Ghost Wasm-JIT compiles C -> wasm32, runs in V8 Liftoff/Turboshaft, and hits Semantic CAS on noise edits', async () => {
  const casDir = mkdtempSync(join(tmpdir(), 'b8g-wasm-jit-test-'));
  try {
    // 1. Cold compile -> wasm32 -> V8 JIT
    const cold = await instantiateWasmGhost({ name: 'fib', source: FIB_SRC_V1, casDir });
    assert.equal(cold.compile.casHit, false);
    assert.ok(cold.compile.wasmBytes.byteLength > 0);
    const fibCold = cold.exports['fib'] as (n: number) => number;
    assert.equal(fibCold(30), 832040);

    // 2. Warm run with comments/renames -> MUST be 100% Semantic CAS HIT (0 recompiles!)
    const warm = await instantiateWasmGhost({ name: 'fib', source: FIB_SRC_NOISE, casDir });
    assert.equal(warm.compile.casHit, true);
    assert.equal(warm.compile.casKey, cold.compile.casKey);
    const fibWarm = warm.exports['fib'] as (n: number) => number;
    assert.equal(fibWarm(30), 832040);

    console.log(
      `[ghost-wasm-jit] Tier-1 Wasm->V8: cold=${cold.compile.compileMs.toFixed(1)}ms | warm_CAS=${warm.compile.compileMs.toFixed(2)}ms | v8_inst=${warm.instantiateMs.toFixed(2)}ms | wasm=${cold.compile.wasmBytes.byteLength} B`
    );
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('Tier 2: Ghost Native AOT-CAS compiles C -> native shared lib once and caches permanently', () => {
  const casDir = mkdtempSync(join(tmpdir(), 'b8g-native-aot-test-'));
  try {
    const cold = compileToNativeGhost({ name: 'fib_native', source: FIB_SRC_V1, casDir });
    assert.equal(cold.casHit, false);
    assert.ok(cold.sizeBytes > 1024);

    const warm = compileToNativeGhost({ name: 'fib_native', source: FIB_SRC_NOISE, casDir });
    assert.equal(warm.casHit, true);
    assert.equal(warm.casKey, cold.casKey);

    console.log(
      `[ghost-wasm-jit] Tier-2 Native AOT-CAS: cold=${cold.compileMs.toFixed(1)}ms | warm_CAS=${warm.compileMs.toFixed(2)}ms | native=${cold.sizeBytes} B`
    );
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});
