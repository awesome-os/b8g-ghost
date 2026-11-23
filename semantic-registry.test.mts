import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSemanticModuleEntry } from './semantic-registry.mts';

test('comments, whitespace, declaration reordering, and local variable renames yield IDENTICAL abi_hash and impl_hash', () => {
  const srcA = `
    // Original file with comments
    int add(int a, int b) {
      int sum = a + b;
      return sum;
    }
    int mul(int x, int y) {
      return x * y;
    }
  `;

  const srcB = `
    /* Completely reformatted & reordered with renamed params and locals */
    int mul(int left, int right) { return left * right; }
    int add(int first, int second) {
      int total = first + second;
      return total;
    }
  `;

  const a = computeSemanticModuleEntry('math.c', srcA);
  const b = computeSemanticModuleEntry('math.c', srcB);

  assert.notEqual(a.blob_sha256, b.blob_sha256, 'Raw Git blob hashes differ');
  assert.equal(a.abi_hash, b.abi_hash, 'Semantic abi_hash MUST be identical');
  assert.equal(a.impl_hash, b.impl_hash, 'Semantic impl_hash MUST be identical (alpha-equivalent)');
});

test('changing function body changes impl_hash while preserving abi_hash (safe b8g-ghost hot-swap)', () => {
  const v1 = `int add(int a, int b) { return a + b; }`;
  const v2 = `int add(int a, int b) { return (a + b) + 0; }`;

  const r1 = computeSemanticModuleEntry('math.c', v1);
  const r2 = computeSemanticModuleEntry('math.c', v2);

  assert.equal(r1.abi_hash, r2.abi_hash, 'Public ABI did not change');
  assert.notEqual(r1.impl_hash, r2.impl_hash, 'Implementation hash MUST change');
});

test('changing public signature changes abi_hash (ABI break detected mathematically)', () => {
  const v1 = `int add(int a, int b) { return a + b; }`;
  const v2 = `int64_t add(int64_t a, int64_t b) { return a + b; }`;

  const r1 = computeSemanticModuleEntry('math.c', v1);
  const r2 = computeSemanticModuleEntry('math.c', v2);

  assert.notEqual(r1.abi_hash, r2.abi_hash, 'Signature change MUST change abi_hash');
});
