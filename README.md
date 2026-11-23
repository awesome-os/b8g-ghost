# `b8g-ghost` — Ghost Libraries & Machine CAS Registry (`B8G_GHOST_V1`)

**`~15 KB` weightless C11 `ghost.dll` / `ghost.so` stubs that materialize real SHA-256-verified native libraries from the user's local machine CAS registry on first load — and auto-install from `awesome-os/sectium-browser` if missing.**

## How It Works

1. **Local Machine CAS Registry:**
   - Windows: `%B8G_CAS_DIR%` or `%LOCALAPPDATA%\AwesomeOS\cas\<sha256>\<filename>`
   - Linux/macOS: `$B8G_CAS_DIR` or `$HOME/.local/share/awesome-os/cas/<sha256>/<filename>`
2. **Ghost Stub (`ghost_*.dll` / `ghost_*.so`, `~15 KB`):**
   - Embeds `B8G_ABI_MAGIC_V3` (`0x33564742`), the target library's immutable **64-hex SHA-256**, and its **GitHub Release URL** (e.g., `awesome-os/sectium-browser @ v0.5.0-baseline`).
   - **CAS Hit (`< 0.1 ms`):** Verifies presence and `LoadLibraryA` / `dlopen`s the shared OS page-cached library directly — zero network, zero disk duplication.
   - **CAS Miss (Install-If-Missing):** Downloads atomically to `<filename>.tmp`, verifies **FIPS 180-4 SHA-256 bit-for-bit** in pure C11 (zero OpenSSL dependency), atomically renames into the CAS, and loads it seamlessly.
   - **Transparent Forwarding:** Caches resolved function pointers and forwards every C-ABI call as if the caller linked directly against the full library.

## License

BSD-3-Clause — Awesome-OS Contributors.
