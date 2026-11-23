/**
 * @file sections/b8g-ghost/ghost-wasm-jit.mts
 * @description Dual-Tier Ghost Wasm-JIT + Native AOT-CAS Engine.
 *
 * Tier 1 (Sandboxed Universal JIT):
 *   Compiles C / C++ / LLVM-IR -> wasm32 via `holo-compiler` (`zig cc -target wasm32-freestanding -O3`)
 *   keyed by Semantic Canonical SHA-256 (`semantic-registry.mts`), caches the `.wasm` artifact
 *   in the local Machine CAS (`<cas>/wasm/<key>/`), and executes inside V8's Liftoff + Turboshaft JIT.
 *
 * Tier 2 (Persistent Native AOT-JIT):
 *   Compiles the same source once to a native shared library (`.dll` / `.so` / `.dylib`) inside
 *   `<cas>/native/<key>/` so subsequent runs across all processes skip JIT warmup completely.
 *
 * Strictly zero external dependencies, `erasableSyntaxOnly: true`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getMachineCasDir, platformLibFilename } from './ghost-ffi.mts';
import { computeSemanticModuleEntry } from './semantic-registry.mts';

export interface GhostWasmCompileResult {
  readonly name: string;
  readonly casKey: string;
  readonly abiHash: string;
  readonly implHash: string;
  readonly wasmPath: string;
  readonly wasmBytes: Uint8Array;
  readonly casHit: boolean;
  readonly compileMs: number;
}

export interface GhostWasmInstanceResult {
  readonly compile: GhostWasmCompileResult;
  readonly instantiateMs: number;
  readonly exports: WebAssembly.Exports;
}

export interface GhostNativeAotResult {
  readonly name: string;
  readonly casKey: string;
  readonly libPath: string;
  readonly sizeBytes: number;
  readonly casHit: boolean;
  readonly compileMs: number;
}

function resolveZigExecutable(): string {
  const localZig = resolve(process.cwd(), process.platform === 'win32' ? 'bin/zig.cmd' : 'bin/zig');
  if (existsSync(localZig)) return localZig;
  return 'zig';
}

function runZigCc(args: readonly string[]): void {
  const zigBin = resolveZigExecutable();
  if (process.platform === 'win32' && zigBin.endsWith('.cmd')) {
    execFileSync('cmd.exe', ['/c', zigBin, 'cc', ...args], { stdio: 'pipe' });
  } else {
    execFileSync(zigBin, ['cc', ...args], { stdio: 'pipe' });
  }
}

export function computeGhostSourceKey(source: string, targetTag: string, moduleName = 'ghost'): {
  casKey: string;
  abiHash: string;
  implHash: string;
} {
  const sem = computeSemanticModuleEntry(moduleName, source);
  const casKey = createHash('sha256')
    .update(`${targetTag}:${sem.abi_hash}:${sem.impl_hash}`)
    .digest('hex');
  return { casKey, abiHash: sem.abi_hash, implHash: sem.impl_hash };
}

/**
 * Tier 1: Compile C source -> wasm32-freestanding (O3) with Semantic CAS deduplication.
 * Comments, whitespace, and local variable renames hit the exact same cached `.wasm` artifact.
 */
export function compileToWasmGhost(opts: {
  readonly name: string;
  readonly source: string;
  readonly casDir?: string;
  readonly extraFlags?: readonly string[];
}): GhostWasmCompileResult {
  const t0 = performance.now();
  const sem = computeSemanticModuleEntry(opts.name, opts.source);
  const { casKey, abiHash, implHash } = computeGhostSourceKey(opts.source, 'wasm32-freestanding-O3', opts.name);
  const casRoot = getMachineCasDir(opts.casDir);
  const entryDir = join(casRoot, 'wasm', casKey);
  const wasmPath = join(entryDir, `${opts.name}.wasm`);

  if (existsSync(wasmPath)) {
    const wasmBytes = new Uint8Array(readFileSync(wasmPath));
    return {
      name: opts.name,
      casKey,
      abiHash,
      implHash,
      wasmPath,
      wasmBytes,
      casHit: true,
      compileMs: performance.now() - t0,
    };
  }

  mkdirSync(entryDir, { recursive: true });
  const workDir = join(tmpdir(), `b8g-wasm-${casKey.slice(0, 12)}-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const srcPath = join(workDir, `${opts.name}.c`);
  const tmpOut = `${wasmPath}.tmp.${process.pid}`;
  const exportFlags = sem.symbols
    .filter((s) => s.kind === 'function')
    .map((s) => `-Wl,--export=${s.name}`);

  try {
    writeFileSync(srcPath, opts.source, 'utf8');
    runZigCc([
      '-target', 'wasm32-freestanding',
      '-O3',
      '-nostdlib',
      '-Wl,--no-entry',
      ...exportFlags,
      ...(opts.extraFlags ?? []),
      srcPath,
      '-o', tmpOut,
    ]);
    const wasmBytes = new Uint8Array(readFileSync(tmpOut));
    writeFileSync(wasmPath, wasmBytes);
    rmSync(tmpOut, { force: true });
    return {
      name: opts.name,
      casKey,
      abiHash,
      implHash,
      wasmPath,
      wasmBytes,
      casHit: false,
      compileMs: performance.now() - t0,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Tier 1 Execution: Instantiate a Ghost-CAS `.wasm` module directly inside V8's Liftoff + Turboshaft JIT.
 */
export async function instantiateWasmGhost(opts: {
  readonly name: string;
  readonly source: string;
  readonly casDir?: string;
  readonly imports?: WebAssembly.Imports;
  readonly extraFlags?: readonly string[];
}): Promise<GhostWasmInstanceResult> {
  const compile = compileToWasmGhost(opts);
  const t0 = performance.now();
  const mod = await WebAssembly.compile(compile.wasmBytes);
  const instance = await WebAssembly.instantiate(mod, opts.imports ?? {});
  return {
    compile,
    instantiateMs: performance.now() - t0,
    exports: instance.exports,
  };
}

/**
 * Tier 2: Compile hot C source -> Native OS shared library (.dll / .so / .dylib) into Machine CAS.
 * Eliminates JIT warmup permanently on subsequent runs across all processes.
 */
export function compileToNativeGhost(opts: {
  readonly name: string;
  readonly source: string;
  readonly casDir?: string;
  readonly extraFlags?: readonly string[];
}): GhostNativeAotResult {
  const t0 = performance.now();
  const targetTriple =
    process.platform === 'win32'
      ? 'x86_64-windows-gnu'
      : process.platform === 'darwin'
        ? 'aarch64-macos'
        : process.arch === 'arm64'
          ? 'aarch64-linux-gnu'
          : 'x86_64-linux-gnu';

  const { casKey } = computeGhostSourceKey(opts.source, `native-${targetTriple}-O3`);
  const casRoot = getMachineCasDir(opts.casDir);
  const entryDir = join(casRoot, 'native', casKey);
  const filename = platformLibFilename(opts.name);
  const libPath = join(entryDir, filename);

  if (existsSync(libPath)) {
    return {
      name: opts.name,
      casKey,
      libPath,
      sizeBytes: readFileSync(libPath).byteLength,
      casHit: true,
      compileMs: performance.now() - t0,
    };
  }

  mkdirSync(entryDir, { recursive: true });
  const workDir = join(tmpdir(), `b8g-native-${casKey.slice(0, 12)}-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const srcPath = join(workDir, `${opts.name}.c`);
  const tmpOut = `${libPath}.tmp.${process.pid}${process.platform === 'win32' ? '.dll' : ''}`;

  try {
    writeFileSync(srcPath, opts.source, 'utf8');
    const sharedFlags = process.platform === 'win32' ? ['-shared', '-s'] : ['-shared', '-fPIC', '-s'];
    runZigCc([
      '-target', targetTriple,
      '-O3',
      ...sharedFlags,
      ...(opts.extraFlags ?? []),
      srcPath,
      '-o', tmpOut,
    ]);
    const bytes = readFileSync(tmpOut);
    writeFileSync(libPath, bytes);
    rmSync(tmpOut, { force: true });
    return {
      name: opts.name,
      casKey,
      libPath,
      sizeBytes: bytes.byteLength,
      casHit: false,
      compileMs: performance.now() - t0,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
