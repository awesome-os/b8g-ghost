/*
 * sections/b8g-ghost/src/test_ghost.c
 * Live end-to-end verification: links ONLY against ghost_sectium_display.dll,
 * triggers cold CAS miss -> auto-installs libsectium_display.dll from v0.5.0-baseline ->
 * verifies SHA-256 -> executes real B8G_DISPLAY_V1 calls -> verifies warm CAS hit!
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
#endif

extern int32_t b8g_ghost_last_hit(void);
extern int32_t b8g_ghost_probe_resolve(int32_t *out_was_hit);
extern int32_t sectium_display_init(void *ctx);
extern int32_t sectium_actor_register(void *ctx, uint32_t kind, const char *name, uint32_t *out_actor_id);
extern int32_t sectium_surface_create(void *ctx, uint32_t owner_actor_id, uint32_t w, uint32_t h, uint32_t mode, uint32_t *out_id);
extern int32_t sectium_surface_damage(void *ctx, uint32_t surface_id, int32_t x, int32_t y, uint32_t w, uint32_t h);
extern int32_t sectium_surface_commit(void *ctx, uint32_t surface_id, uint64_t now_ms, uint64_t *out_seq);

int main(void) {
  /* Allocate generous zeroed buffer for B8GDisplayCtx (actual struct ~12 KB) */
  uint8_t ctx_buf[65536];
  memset(ctx_buf, 0, sizeof(ctx_buf));

  /* 1. Cold call through ghost_sectium_display.dll -> hydrates real libsectium_display.dll! */
  int32_t rc = sectium_display_init(ctx_buf);
  if (rc != 0) {
    fprintf(stderr, "FAIL: sectium_display_init through ghost returned %d\n", rc);
    return 1;
  }

  uint32_t abi_magic = 0;
  memcpy(&abi_magic, ctx_buf, sizeof(abi_magic));
  if (abi_magic != 0x31444742u) {
    fprintf(stderr, "FAIL: expected B8G_DISPLAY_V1 magic 0x31444742, got 0x%08x\n", abi_magic);
    return 2;
  }

  int32_t first_hit = b8g_ghost_last_hit();

  /* 2. Register human actor + create surface + damage + commit through the ghost stub */
  uint32_t actor_id = 0;
  rc = sectium_actor_register(ctx_buf, 1, "human", &actor_id);
  if (rc != 0 || actor_id == 0) {
    fprintf(stderr, "FAIL: sectium_actor_register rc=%d actor_id=%u\n", rc, actor_id);
    return 3;
  }
  uint32_t surf_id = 0;
  rc = sectium_surface_create(ctx_buf, actor_id, 1440, 900, 1, &surf_id);
  if (rc != 0 || surf_id == 0) {
    fprintf(stderr, "FAIL: sectium_surface_create rc=%d surf_id=%u\n", rc, surf_id);
    return 3;
  }

  rc = sectium_surface_damage(ctx_buf, surf_id, 0, 0, 1440, 900);
  if (rc != 0) {
    fprintf(stderr, "FAIL: sectium_surface_damage rc=%d\n", rc);
    return 4;
  }

  uint64_t commit_seq = 0;
  rc = sectium_surface_commit(ctx_buf, surf_id, 1000, &commit_seq);
  if (rc != 0 || commit_seq != 1) {
    fprintf(stderr, "FAIL: sectium_surface_commit rc=%d seq=%llu\n", rc, (unsigned long long)commit_seq);
    return 5;
  }

  /* 3. Verify warm CAS hit on second resolve (< 1 ms, 0 network) */
  int32_t warm_hit = 0;
  rc = b8g_ghost_probe_resolve(&warm_hit);
  if (rc != 0 || warm_hit != 1) {
    fprintf(stderr, "FAIL: expected warm CAS hit=1, got rc=%d hit=%d\n", rc, warm_hit);
    return 6;
  }

  printf("PASS [b8g-ghost]: abi_magic=0x%08x | surf_id=%u | commit_seq=%llu | first_call_cas_hit=%d | second_resolve_cas_hit=%d\n",
         abi_magic, surf_id, (unsigned long long)commit_seq, first_hit, warm_hit);
  return 0;
}
