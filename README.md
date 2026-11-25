# `b8g-ghost` — Ghost Libraries, Machine CAS Registry & Versioned FFI (`B8G_GHOST_V1`)

**`~10 KB` (Linux `.so`) / `~23 KB` (Win64 `.dll`) content-addressed Ghost Libraries + Versioned FFI (`ghostFFI`).**

*"pnpm / Nix-store benefits for native C/C++/Rust/Zig shared libraries — with zero daemon, zero DSL, and zero DLL hell."*

---

## 1. How It Works

Every native shared library is addressed by its **immutable SHA-256 hash** inside a single deduplicated **Local Machine CAS Registry**:

- **Windows:** `%LOCALAPPDATA%\AwesomeOS\cas\<sha256>\<filename>` (or `%B8G_CAS_DIR%`)
- **Linux / macOS:** `~/.local/share/awesome-os/cas/<sha256>/<filename>` (or `$B8G_CAS_DIR`)

1. **CAS Hit (`< 0.1 ms`):** Loads directly from the shared OS page cache (`LoadLibraryA` / `dlopen`) — zero network, zero disk duplication.
2. **CAS Miss (Install-If-Missing):** Downloads atomically from the pinned GitHub Release registry (e.g. `awesome-os/sectium-browser@v0.5.0-baseline`), verifies **FIPS 180-4 SHA-256 bit-for-bit**, commits atomically into the CAS, and loads seamlessly.
3. **Side-by-Side Versions + Clean Dispose:** Multiple versions of the same library (`v1` and `v2`) coexist safely in the same process (`RTLD_LOCAL` / isolated SHA-256 paths) and unload cleanly via `dispose()`.

---

## 2. Usage A — Versioned Ghost FFI in TypeScript / JS (`ghostFFI`)

No `node-gyp`, no `apt install`, no broken `/usr/lib` version mismatches:

```ts
import { ghostFFI } from './ghost-ffi.mts';

const display = await ghostFFI('awesome-os/sectium-browser@v0.5.0-baseline', {
  lib: 'libsectium_display', // auto-resolves .dll / -linux-x64.so / -linux-arm64.so / -macos-arm64.dylib
  sha256: '50badeec9a1882ea6997b327f207bc91366561c5e3bff56572cfb1e7fc85b923',
  symbols: {
    sectium_display_init:   { args: ['ptr'], returns: 'i32' },
    sectium_surface_commit: { args: ['ptr', 'u32', 'u64', 'ptr'], returns: 'i32' },
  },
});

console.log(display.resolvedPath, 'casHit=', display.casHit);
display.symbols.sectium_display_init(ctxPtr);

// Clean plug-and-play dispose when done
display.dispose();
```

---

## 3. Usage B — Native C11 Ghost Library (`ghost_sectium_display.dll` / `.so`)

Link your C/C++/Rust/Zig app against the **`~10–23 KB` ghost stub** instead of bundling a 40 MB `.dll`/`.so`:

```c
#include "b8g_ghost.h"

static const b8g_ghost_spec_t SPEC = {
  .abi_magic    = B8G_ABI_MAGIC_V3,
  .ghost_magic  = B8G_GHOST_MAGIC,
  .filename     = "libsectium_display.dll",
  .sha256_hex   = "50badeec9a1882ea6997b327f207bc91366561c5e3bff56572cfb1e7fc85b923",
  .download_url = "https://github.com/awesome-os/sectium-browser/releases/download/v0.5.0-baseline/libsectium_display.dll"
};

void *handle = NULL;
int was_hit = 0;
if (b8g_ghost_load(&SPEC, &handle, &was_hit) == 0) {
  /* Call any exported C symbol at native speed via b8g_ghost_sym(handle, "...") */
}
```

### Auto-Generate Ghost Specs From Any `RollingReleaseManifest.json`

```bash
node ghost-gen.mts RollingReleaseManifest.json > ghost_specs.h
```

## Verification

```bash
node --test ghost-ffi.test.mts
```

## License

BSD-3-Clause — Awesome-OS Contributors.

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/b8g-ghost@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://cpp/b8g-ghost?from=repository://github.com/awesome-os/b8g-ghost@main"
```
