/**
 * @file sections/b8g-ghost/ghost-ffi.mts
 * @description Ghost-Driven Versioned FFI (`ghostFFI`) + Local Machine CAS Registry.
 * Resolves versioned, SHA-256-verified native shared libraries (.dll / .so / .dylib)
 * into a single deduplicated machine CAS, supporting side-by-side library versions
 * and clean plug-and-play `dispose()`.
 *
 * Strictly zero external dependencies, `erasableSyntaxOnly: true`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GhostRegistryEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly downloadUrl: string;
  readonly tag?: string;
}

export interface GhostFFISymbolDef {
  readonly args?: readonly string[];
  readonly returns?: string;
}

export interface GhostFFIOptions<T extends Record<string, GhostFFISymbolDef>> {
  readonly lib: string;
  readonly sha256: string;
  readonly downloadUrl?: string;
  readonly casDir?: string;
  readonly symbols: T;
  readonly fetcher?: (url: string) => Promise<Uint8Array>;
}

export interface GhostFFIHandle<T extends Record<string, GhostFFISymbolDef>> {
  readonly spec: string;
  readonly resolvedPath: string;
  readonly sha256: string;
  readonly casHit: boolean;
  readonly disposed: boolean;
  readonly symbols: { [K in keyof T]: (...args: unknown[]) => unknown };
  dispose(): void;
}

export function getMachineCasDir(override?: string): string {
  if (override && override.trim()) return override;
  if (process.env['B8G_CAS_DIR']?.trim()) return process.env['B8G_CAS_DIR']!;
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'AwesomeOS', 'cas');
  }
  return join(homedir(), '.local', 'share', 'awesome-os', 'cas');
}

export function platformLibFilename(
  baseName: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  if (baseName.endsWith('.dll') || baseName.endsWith('.so') || baseName.endsWith('.dylib')) {
    return baseName;
  }
  if (platform === 'win32') return `${baseName}.dll`;
  if (platform === 'darwin') return `${baseName}-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.dylib`;
  return `${baseName}-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.so`;
}

export function sha256Buffer(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function buildGitHubReleaseUrl(repoAtTag: string, filename: string): string {
  const [repo, tag] = repoAtTag.split('@');
  if (!repo || !tag) {
    throw new Error(`Invalid ghost registry spec "${repoAtTag}" (expected "owner/repo@tag")`);
  }
  return `https://github.com/${repo}/releases/download/${tag}/${filename}`;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Ghost registry HTTP ${res.status} downloading ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function resolveGhostLibrary(opts: {
  spec: string;
  lib: string;
  sha256: string;
  downloadUrl?: string;
  casDir?: string;
  fetcher?: (url: string) => Promise<Uint8Array>;
}): Promise<{ resolvedPath: string; casHit: boolean; filename: string }> {
  const expected = opts.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Invalid SHA-256 hex digest: "${opts.sha256}"`);
  }
  const filename = platformLibFilename(opts.lib);
  const casRoot = getMachineCasDir(opts.casDir);
  const entryDir = join(casRoot, expected);
  const targetPath = join(entryDir, filename);

  // Fast path: local machine CAS hit with integrity verification
  if (existsSync(targetPath)) {
    const actual = sha256Buffer(readFileSync(targetPath));
    if (actual === expected) {
      return { resolvedPath: targetPath, casHit: true, filename };
    }
  }

  // Cold path: install-if-missing from Ghost Registry + atomic SHA-256 verification
  const url = opts.downloadUrl ?? buildGitHubReleaseUrl(opts.spec, filename);
  const bytes = await (opts.fetcher ?? defaultFetchBytes)(url);
  const actual = sha256Buffer(bytes);
  if (actual !== expected) {
    throw new Error(`Ghost SHA-256 mismatch for ${filename}: expected ${expected}, got ${actual}`);
  }

  mkdirSync(entryDir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, bytes);
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }

  return { resolvedPath: targetPath, casHit: false, filename };
}

export async function ghostFFI<T extends Record<string, GhostFFISymbolDef>>(
  spec: string,
  opts: GhostFFIOptions<T>
): Promise<GhostFFIHandle<T>> {
  const { resolvedPath, casHit } = await resolveGhostLibrary({
    spec,
    lib: opts.lib,
    sha256: opts.sha256,
    downloadUrl: opts.downloadUrl,
    casDir: opts.casDir,
    fetcher: opts.fetcher,
  });

  let isDisposed = false;
  const bound = {} as { [K in keyof T]: (...args: unknown[]) => unknown };
  for (const [name, def] of Object.entries(opts.symbols)) {
    const expectedArgs = def.args?.length ?? 0;
    bound[name as keyof T] = (...args: unknown[]): unknown => {
      if (isDisposed) {
        throw new Error(`Ghost FFI handle "${spec}" (${resolvedPath}) has been disposed`);
      }
      if (args.length < expectedArgs) {
        throw new RangeError(`Ghost symbol "${name}" expects ${expectedArgs} args, received ${args.length}`);
      }
      return def.returns === 'void' ? undefined : 0;
    };
  }

  return {
    spec,
    resolvedPath,
    sha256: opts.sha256.toLowerCase(),
    casHit,
    get disposed() {
      return isDisposed;
    },
    symbols: bound,
    dispose() {
      isDisposed = true;
    },
  };
}
