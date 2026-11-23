/*
 * sections/b8g-ghost/src/ghost_sectium_display.c
 * ~15 KB Ghost Stub for `libsectium_display` (v0.5.0-baseline).
 * Materializes the real SHA-256-verified library from the user's machine CAS on first call
 * (downloading from awesome-os/sectium-browser @ v0.5.0-baseline on cold miss) and forwards
 * all B8G_DISPLAY_V1 C11 ABI calls transparently.
 */
#define B8G_GHOST_BUILDING_DLL 1
#include "../include/b8g_ghost.h"

#include <stdint.h>
#include <stddef.h>

#if defined(_WIN32)
static const b8g_ghost_spec_t SECTIUM_DISPLAY_SPEC = {
  .abi_magic    = B8G_ABI_MAGIC_V3,
  .ghost_magic  = B8G_GHOST_MAGIC,
  .filename     = "libsectium_display.dll",
  .sha256_hex   = "50badeec9a1882ea6997b327f207bc91366561c5e3bff56572cfb1e7fc85b923",
  .download_url = "https://github.com/awesome-os/sectium-browser/releases/download/v0.5.0-baseline/libsectium_display.dll"
};
#elif defined(__APPLE__)
static const b8g_ghost_spec_t SECTIUM_DISPLAY_SPEC = {
  .abi_magic    = B8G_ABI_MAGIC_V3,
  .ghost_magic  = B8G_GHOST_MAGIC,
  .filename     = "libsectium_display-macos-arm64.dylib",
  .sha256_hex   = "8ed596430b5b2c67477abe5e55901ef1a54773b7180165a00564dc25c0dcdb1a",
  .download_url = "https://github.com/awesome-os/sectium-browser/releases/download/v0.5.0-baseline/libsectium_display-macos-arm64.dylib"
};
#elif defined(__aarch64__)
static const b8g_ghost_spec_t SECTIUM_DISPLAY_SPEC = {
  .abi_magic    = B8G_ABI_MAGIC_V3,
  .ghost_magic  = B8G_GHOST_MAGIC,
  .filename     = "libsectium_display-linux-arm64.so",
  .sha256_hex   = "c3c71874045b6a8babbcae78cc57b0f45b10a4b01d8f0f2dd7f5cc6a85d27f27",
  .download_url = "https://github.com/awesome-os/sectium-browser/releases/download/v0.5.0-baseline/libsectium_display-linux-arm64.so"
};
#else
static const b8g_ghost_spec_t SECTIUM_DISPLAY_SPEC = {
  .abi_magic    = B8G_ABI_MAGIC_V3,
  .ghost_magic  = B8G_GHOST_MAGIC,
  .filename     = "libsectium_display-linux-x64.so",
  .sha256_hex   = "79b3427b1634cb6cb72a0481baae4b900d0d5b3ccbc82caffb286796eb2c32a3",
  .download_url = "https://github.com/awesome-os/sectium-browser/releases/download/v0.5.0-baseline/libsectium_display-linux-x64.so"
};
#endif

typedef int32_t (*fn_init_t)(void *ctx);
typedef int32_t (*fn_actor_register_t)(void *ctx, uint32_t kind, const char *name, uint32_t *out_actor_id);
typedef int32_t (*fn_surface_create_t)(void *ctx, uint32_t owner_actor_id, uint32_t w, uint32_t h, uint32_t mode, uint32_t *out_id);
typedef int32_t (*fn_surface_damage_t)(void *ctx, uint32_t surface_id, int32_t x, int32_t y, uint32_t w, uint32_t h);
typedef int32_t (*fn_surface_commit_t)(void *ctx, uint32_t surface_id, uint64_t now_ms, uint64_t *out_seq);

static void               *g_real_handle = NULL;
static int                 g_last_hit = -1;
static fn_init_t           g_init = NULL;
static fn_actor_register_t g_actor_register = NULL;
static fn_surface_create_t g_surface_create = NULL;
static fn_surface_damage_t g_surface_damage = NULL;
static fn_surface_commit_t g_surface_commit = NULL;

static int ensure_materialized(void) {
  if (g_real_handle) return 0;
  int hit = 0;
  int rc = b8g_ghost_load(&SECTIUM_DISPLAY_SPEC, &g_real_handle, &hit);
  if (rc != 0) return rc;
  g_last_hit = hit;
  g_init           = (fn_init_t)b8g_ghost_sym(g_real_handle, "sectium_display_init");
  g_actor_register = (fn_actor_register_t)b8g_ghost_sym(g_real_handle, "sectium_actor_register");
  g_surface_create = (fn_surface_create_t)b8g_ghost_sym(g_real_handle, "sectium_surface_create");
  g_surface_damage = (fn_surface_damage_t)b8g_ghost_sym(g_real_handle, "sectium_surface_damage");
  g_surface_commit = (fn_surface_commit_t)b8g_ghost_sym(g_real_handle, "sectium_surface_commit");
  return (g_init && g_actor_register && g_surface_create && g_surface_damage && g_surface_commit) ? 0 : -10;
}

B8G_GHOST_API int32_t b8g_ghost_last_hit(void) {
  return g_last_hit;
}

B8G_GHOST_API int32_t b8g_ghost_probe_resolve(int32_t *out_was_hit) {
  char path[1024];
  int hit = 0;
  int rc = b8g_ghost_resolve(&SECTIUM_DISPLAY_SPEC, path, sizeof(path), &hit);
  if (out_was_hit) *out_was_hit = hit;
  return rc;
}

B8G_GHOST_API int32_t sectium_display_init(void *ctx) {
  if (ensure_materialized() != 0) return -1;
  return g_init(ctx);
}

B8G_GHOST_API int32_t sectium_actor_register(void *ctx, uint32_t kind, const char *name, uint32_t *out_actor_id) {
  if (ensure_materialized() != 0) return -1;
  return g_actor_register(ctx, kind, name, out_actor_id);
}

B8G_GHOST_API int32_t sectium_surface_create(void *ctx, uint32_t owner_actor_id, uint32_t w, uint32_t h, uint32_t mode, uint32_t *out_id) {
  if (ensure_materialized() != 0) return -1;
  return g_surface_create(ctx, owner_actor_id, w, h, mode, out_id);
}

B8G_GHOST_API int32_t sectium_surface_damage(void *ctx, uint32_t surface_id, int32_t x, int32_t y, uint32_t w, uint32_t h) {
  if (ensure_materialized() != 0) return -1;
  return g_surface_damage(ctx, surface_id, x, y, w, h);
}

B8G_GHOST_API int32_t sectium_surface_commit(void *ctx, uint32_t surface_id, uint64_t now_ms, uint64_t *out_seq) {
  if (ensure_materialized() != 0) return -1;
  return g_surface_commit(ctx, surface_id, now_ms, out_seq);
}
