/**
 * @file sections/b8g-ghost/ghost-debloat-ingest.mts
 * @description Live 4-Stage Ghost Debloat & C-Lib Un-Vendoring Ingestor for PyPI .whl / Maven .jar / npm .tgz.
 *
 * Downloads a real upstream package (e.g. PyPI `pillow` wheel), strips dead bloat
 * (tests, docs, stubs, sourcemaps, debug symbols), rips out vendored C libraries
 * that already exist in canonical `awesome-os/b8g-ghost @ cas-v1` (webp, png, jpeg,
 * freetype, harfbuzz, brotli, zlib, expat, sqlite, lz4, ssl), replaces them with
 * a tiny `ghost-deps.json` CAS pointer manifest, and reports the real byte reduction.
 *
 * Run: node sections/b8g-ghost/ghost-debloat-ingest.mts [pypi-package-name]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { DEFAULT_GHOST_INDEX_URL } from './ghost-ffi.mts';

const VENDORED_LIB_PATTERNS: Array<{ re: RegExp; casHint: string }> = [
  { re: /webp|sharpyuv/i, casHint: 'libwebp' },
  { re: /brotli/i, casHint: 'libbrotli' },
  { re: /freetype/i, casHint: 'freetype' },
  { re: /harfbuzz/i, casHint: 'harfbuzz' },
  { re: /libpng|png1[68]/i, casHint: 'libpng' },
  { re: /jpeg|turbojpeg/i, casHint: 'libjpeg-turbo' },
  { re: /zlib|libz\b/i, casHint: 'zlib-ng' },
  { re: /expat/i, casHint: 'libexpat' },
  { re: /sqlite/i, casHint: 'libsqlite3' },
  { re: /lz4/i, casHint: 'liblz4' },
  { re: /libssl|libcrypto|boringssl/i, casHint: 'boringssl' },
];

const BLOAT_PATH_RE =
  /(^|\/)(tests?|docs?|examples?|benchmarks?|__pycache__)(\/|$)|\.(map|pdb|pyi|c|h|hpp|md|rst)$/i;

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  visit(root);
  return out;
}

function tarBin(): string {
  return process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
}

export async function debloatPyPiWheel(pkgName: string, outDir?: string) {
  const workDir = mkdtempSync(join(tmpdir(), `ghost-debloat-${pkgName}-`));
  const unpackDir = join(workDir, 'unpacked');
  mkdirSync(unpackDir, { recursive: true });

  try {
    // 1. Fetch live canonical Ghost CAS index
    const casIdx = (await (await fetch(DEFAULT_GHOST_INDEX_URL)).json()) as {
      entries: Record<string, { filename: string; sha256: string; download_url: string }>;
    };

    // 2. Query PyPI for a real native wheel (prefer manylinux x86_64 or win_amd64)
    const meta = (await (await fetch(`https://pypi.org/pypi/${pkgName}/json`)).json()) as {
      info: { version: string };
      urls: Array<{ filename: string; url: string; packagetype: string; size: number }>;
    };
    const wheel =
      meta.urls.find((u) => u.packagetype === 'bdist_wheel' && /manylinux.*x86_64/i.test(u.filename)) ??
      meta.urls.find((u) => u.packagetype === 'bdist_wheel' && /win_amd64/i.test(u.filename)) ??
      meta.urls.find((u) => u.packagetype === 'bdist_wheel');
    if (!wheel) throw new Error(`No wheel found on PyPI for ${pkgName}`);

    const whlPath = join(workDir, wheel.filename);
    const whlBytes = new Uint8Array(await (await fetch(wheel.url)).arrayBuffer());
    writeFileSync(whlPath, whlBytes);

    // 3. Unpack wheel (ZIP) via system tar (Win32 bsdtar) or unzip (Linux/macOS)
    if (process.platform === 'win32') {
      execFileSync(tarBin(), ['-xf', whlPath, '-C', unpackDir], { stdio: 'pipe' });
    } else {
      execFileSync('unzip', ['-q', '-o', whlPath, '-d', unpackDir], { stdio: 'pipe' });
    }

    const allFiles = walkFiles(unpackDir);
    let rawUnpackedBytes = 0;
    let bloatRemovedBytes = 0;
    let unvendoredBytes = 0;
    let keptFiles = 0;
    const unvendoredLibs: Array<{ vendoredFile: string; bytes: number; casReplacedBy: string; casSha256: string }> = [];

    for (const full of allFiles) {
      const rel = relative(unpackDir, full).replace(/\\/g, '/');
      const sz = statSync(full).size;
      rawUnpackedBytes += sz;

      // Stage 1: Static bloat purge
      if (BLOAT_PATH_RE.test(rel)) {
        rmSync(full, { force: true });
        bloatRemovedBytes += sz;
        continue;
      }

      // Stage 2: Native C-lib un-vendoring -> canonical cas-v1 pointer (preserve CPython .cpython-* bindings!)
      const base = basename(rel);
      const isNativeLib = /\.(so(\.\d+)*|dll|dylib)$/i.test(base) && !/\.cpython-/i.test(base);
      if (isNativeLib) {
        const match = VENDORED_LIB_PATTERNS.find((p) => p.re.test(base));
        if (match) {
          const casKey =
            Object.keys(casIdx.entries).find(
              (k) => k.toLowerCase().includes(match.casHint) && /linux-x64/i.test(k) && !k.includes('include')
            ) ??
            Object.keys(casIdx.entries).find(
              (k) => k.toLowerCase().includes(match.casHint) && !k.includes('include')
            );
          if (casKey) {
            const casEntry = casIdx.entries[casKey]!;
            rmSync(full, { force: true });
            unvendoredBytes += sz;
            unvendoredLibs.push({
              vendoredFile: rel,
              bytes: sz,
              casReplacedBy: casEntry.filename,
              casSha256: casEntry.sha256,
            });
            continue;
          }
        }
      }
      keptFiles++;
    }

    // Emit tiny ghost-deps.json replacing all stripped vendored C libraries
    const ghostDeps = {
      schema: 'b8g-ghost-debloated-pkg-v1',
      source_package: `${pkgName}@${meta.info.version}`,
      source_wheel: wheel.filename,
      cas_index: DEFAULT_GHOST_INDEX_URL,
      unvendored_native_deps: unvendoredLibs,
    };
    writeFileSync(join(unpackDir, 'ghost-deps.json'), JSON.stringify(ghostDeps, null, 2) + '\n');

    // Stage 3: Repack debloated Ghost archive
    const outFileName = `${pkgName}-${meta.info.version}.ghost.tar.gz`;
    const outPack = join(workDir, outFileName);
    execFileSync(tarBin(), ['-czf', outPack, '-C', unpackDir, '.'], { stdio: 'pipe' });
    const outBuf = readFileSync(outPack);
    const debloatedBytes = outBuf.byteLength;
    const outSha = createHash('sha256').update(outBuf).digest('hex');

    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, outSha), outBuf);
      writeFileSync(
        join(outDir, `${pkgName}.meta.json`),
        JSON.stringify(
          {
            filename: outFileName,
            sha256: outSha,
            bytes: debloatedBytes,
            original_bytes: whlBytes.byteLength,
            unvendored_count: unvendoredLibs.length,
            category: 'pypi-llm-stack',
            download_url: `https://github.com/awesome-os/b8g-ghost/releases/download/cas-v1/${outSha}`,
          },
          null,
          2
        ) + '\n'
      );
    }

    const savedBytes = whlBytes.byteLength - debloatedBytes;
    const reductionPct = ((savedBytes / whlBytes.byteLength) * 100).toFixed(1);

    console.log(`\n=== Ghost Debloat Ingestor: ${pkgName}@${meta.info.version} (${wheel.filename}) ===`);
    console.log(`Original PyPI .whl:        ${(whlBytes.byteLength / 1024).toFixed(1)} KB (${allFiles.length} files, ${(rawUnpackedBytes / 1024).toFixed(1)} KB unpacked)`);
    console.log(`Stage 1 Bloat Purged:      -${(bloatRemovedBytes / 1024).toFixed(1)} KB (tests/docs/stubs/maps)`);
    console.log(`Stage 2 C-Libs Un-Vendored: -${(unvendoredBytes / 1024).toFixed(1)} KB (${unvendoredLibs.length} duplicated C libs -> cas-v1 pointers)`);
    for (const u of unvendoredLibs) {
      console.log(`   - stripped ${basename(u.vendoredFile)} (${(u.bytes / 1024).toFixed(1)} KB) -> cas-v1:${u.casReplacedBy} (${u.casSha256.slice(0, 12)}...)`);
    }
    console.log(`Final Ghost Pack (.tar.gz): ${(debloatedBytes / 1024).toFixed(1)} KB (${keptFiles} files, sha256=${outSha.slice(0, 16)}...)`);
    console.log(`TOTAL REDUCTION:           -${(savedBytes / 1024).toFixed(1)} KB (-${reductionPct}% smaller!)`);
  } finally {
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('ghost-debloat-ingest.mts')) {
  const pkg = process.argv[2] ?? 'pillow';
  const outArg = process.argv.find((a) => a.startsWith('--out-dir='))?.split('=')[1];
  await debloatPyPiWheel(pkg, outArg);
}
