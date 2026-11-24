/**
 * @file sections/b8g-ghost/src/b8g_ghost_abi_napi.c
 * @description Zero-node-gyp, pure C11 Node-API (N-API v8) addon: `b8g-ghost-abi.node`.
 *
 * Exposes to Node.js 18/20/22/24/26, Electron, Deno, and Bun:
 *   - `abiInfo()`                                  -> { abiMagic, ghostMagic, name }
 *   - `resolve(filename, sha256Hex, downloadUrl)`  -> { path, casHit } (real C11 b8g_ghost_resolve)
 *   - `dlopen(path)`                               -> BigInt native module handle
 *   - `callU32_0(handle, symbolName)`              -> number (calls uint32_t fn(void) natively)
 *   - `callI32_1(handle, symbolName, arg0)`        -> number (calls int32_t fn(int32_t) natively)
 *   - `createArena(byteLength)`                    -> zero-copy 64-byte-aligned B8G_ARENA_V1 ArrayBuffer
 *
 * Resolves N-API symbols dynamically from the host process (node.exe / libnode), so
 * holo-compiler (`zig cc`) cross-compiles it for all 4 OSes with ZERO node-gyp and ZERO node.lib!
 */
#include "b8g_ghost.h"

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <malloc.h>
  #define NAPI_EXPORT __declspec(dllexport)
#else
  #include <dlfcn.h>
  #define NAPI_EXPORT __attribute__((visibility("default")))
#endif

/* Minimal stable N-API v8 ABI definitions (pure C, ABI-frozen since Node 10) */
typedef struct napi_env__*           napi_env;
typedef struct napi_value__*         napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int32_t                      napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void* finalize_data, void* finalize_hint);

#define NAPI_OK 0
#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef struct {
  int32_t     nm_version;
  uint32_t    nm_flags;
  const char* nm_filename;
  napi_value (*nm_register_func)(napi_env env, napi_value exports);
  const char* nm_modname;
  void*       nm_priv;
  void*       reserved[4];
} napi_module;

/* Host-resolved N-API function pointers (zero node.lib dependency!) */
typedef napi_status (*fn_napi_create_object)(napi_env, napi_value*);
typedef napi_status (*fn_napi_create_function)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef napi_status (*fn_napi_set_named_property)(napi_env, napi_value, const char*, napi_value);
typedef napi_status (*fn_napi_get_cb_info)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef napi_status (*fn_napi_get_value_string_utf8)(napi_env, napi_value, char*, size_t, size_t*);
typedef napi_status (*fn_napi_create_string_utf8)(napi_env, const char*, size_t, napi_value*);
typedef napi_status (*fn_napi_create_uint32)(napi_env, uint32_t, napi_value*);
typedef napi_status (*fn_napi_create_int32)(napi_env, int32_t, napi_value*);
typedef napi_status (*fn_napi_get_value_int32)(napi_env, napi_value, int32_t*);
typedef napi_status (*fn_napi_get_boolean)(napi_env, int, napi_value*);
typedef napi_status (*fn_napi_create_bigint_uint64)(napi_env, uint64_t, napi_value*);
typedef napi_status (*fn_napi_get_value_bigint_uint64)(napi_env, napi_value, uint64_t*, int*);
typedef napi_status (*fn_napi_create_external_arraybuffer)(napi_env, void*, size_t, napi_finalize, void*, napi_value*);
typedef napi_status (*fn_napi_throw_error)(napi_env, const char*, const char*);

static fn_napi_create_object               p_create_object;
static fn_napi_create_function             p_create_function;
static fn_napi_set_named_property          p_set_named_property;
static fn_napi_get_cb_info                 p_get_cb_info;
static fn_napi_get_value_string_utf8       p_get_value_string_utf8;
static fn_napi_create_string_utf8          p_create_string_utf8;
static fn_napi_create_uint32               p_create_uint32;
static fn_napi_create_int32                p_create_int32;
static fn_napi_get_value_int32             p_get_value_int32;
static fn_napi_get_boolean                 p_get_boolean;
static fn_napi_create_bigint_uint64        p_create_bigint_uint64;
static fn_napi_get_value_bigint_uint64     p_get_value_bigint_uint64;
static fn_napi_create_external_arraybuffer p_create_external_arraybuffer;
static fn_napi_throw_error                 p_throw_error;

static void* host_sym(const char* name) {
#if defined(_WIN32)
  HMODULE self = GetModuleHandleA(NULL);
  void* p = (void*)GetProcAddress(self, name);
  if (!p) {
    HMODULE node_dll = GetModuleHandleA("node.dll");
    if (node_dll) p = (void*)GetProcAddress(node_dll, name);
  }
  return p;
#else
  return dlsym(RTLD_DEFAULT, name);
#endif
}

static int init_napi_table(void) {
  p_create_object               = (fn_napi_create_object)host_sym("napi_create_object");
  p_create_function             = (fn_napi_create_function)host_sym("napi_create_function");
  p_set_named_property          = (fn_napi_set_named_property)host_sym("napi_set_named_property");
  p_get_cb_info                 = (fn_napi_get_cb_info)host_sym("napi_get_cb_info");
  p_get_value_string_utf8       = (fn_napi_get_value_string_utf8)host_sym("napi_get_value_string_utf8");
  p_create_string_utf8          = (fn_napi_create_string_utf8)host_sym("napi_create_string_utf8");
  p_create_uint32               = (fn_napi_create_uint32)host_sym("napi_create_uint32");
  p_create_int32                = (fn_napi_create_int32)host_sym("napi_create_int32");
  p_get_value_int32             = (fn_napi_get_value_int32)host_sym("napi_get_value_int32");
  p_get_boolean                 = (fn_napi_get_boolean)host_sym("napi_get_boolean");
  p_create_bigint_uint64        = (fn_napi_create_bigint_uint64)host_sym("napi_create_bigint_uint64");
  p_get_value_bigint_uint64     = (fn_napi_get_value_bigint_uint64)host_sym("napi_get_value_bigint_uint64");
  p_create_external_arraybuffer = (fn_napi_create_external_arraybuffer)host_sym("napi_create_external_arraybuffer");
  p_throw_error                 = (fn_napi_throw_error)host_sym("napi_throw_error");
  return p_create_object && p_create_function && p_set_named_property && p_get_cb_info;
}

static napi_value fn_abi_info(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj, v_abi, v_ghost, v_name;
  p_create_object(env, &obj);
  p_create_uint32(env, B8G_ABI_MAGIC_V3, &v_abi);
  p_create_uint32(env, B8G_GHOST_MAGIC, &v_ghost);
  p_create_string_utf8(env, "b8g-ghost-abi.node", NAPI_AUTO_LENGTH, &v_name);
  p_set_named_property(env, obj, "abiMagic", v_abi);
  p_set_named_property(env, obj, "ghostMagic", v_ghost);
  p_set_named_property(env, obj, "name", v_name);
  return obj;
}

static napi_value fn_resolve(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  p_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 3) {
    p_throw_error(env, "EINVAL", "resolve(filename, sha256Hex, downloadUrl) requires 3 arguments");
    return NULL;
  }
  char filename[256] = {0}, sha[128] = {0}, url[512] = {0};
  size_t len = 0;
  p_get_value_string_utf8(env, args[0], filename, sizeof(filename), &len);
  p_get_value_string_utf8(env, args[1], sha, sizeof(sha), &len);
  p_get_value_string_utf8(env, args[2], url, sizeof(url), &len);

  b8g_ghost_spec_t spec;
  spec.abi_magic    = B8G_ABI_MAGIC_V3;
  spec.ghost_magic  = B8G_GHOST_MAGIC;
  spec.filename     = filename;
  spec.sha256_hex   = sha;
  spec.download_url = url;

  char out_path[512] = {0};
  int was_hit = 0;
  int rc = b8g_ghost_resolve(&spec, out_path, sizeof(out_path), &was_hit);
  if (rc != 0) {
    p_throw_error(env, "EGHOST", "b8g_ghost_resolve failed (download or SHA-256 mismatch)");
    return NULL;
  }

  napi_value obj, v_path, v_hit;
  p_create_object(env, &obj);
  p_create_string_utf8(env, out_path, NAPI_AUTO_LENGTH, &v_path);
  p_get_boolean(env, was_hit != 0, &v_hit);
  p_set_named_property(env, obj, "path", v_path);
  p_set_named_property(env, obj, "casHit", v_hit);
  return obj;
}

static napi_value fn_dlopen(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  p_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) {
    p_throw_error(env, "EINVAL", "dlopen(path) requires 1 argument");
    return NULL;
  }
  char path[512] = {0};
  size_t len = 0;
  p_get_value_string_utf8(env, args[0], path, sizeof(path), &len);

#if defined(_WIN32)
  void* h = (void*)LoadLibraryA(path);
#else
  void* h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
#endif
  if (!h) {
    p_throw_error(env, "EDLOPEN", "Failed to load native library");
    return NULL;
  }
  napi_value out;
  p_create_bigint_uint64(env, (uint64_t)(uintptr_t)h, &out);
  return out;
}

static napi_value fn_call_u32_0(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  p_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 2) {
    p_throw_error(env, "EINVAL", "callU32_0(handle, symbolName) requires 2 arguments");
    return NULL;
  }
  uint64_t hval = 0;
  int lossless = 0;
  p_get_value_bigint_uint64(env, args[0], &hval, &lossless);
  char sym[256] = {0};
  size_t len = 0;
  p_get_value_string_utf8(env, args[1], sym, sizeof(sym), &len);

  void* fn_ptr = b8g_ghost_sym((void*)(uintptr_t)hval, sym);
  if (!fn_ptr) {
    p_throw_error(env, "ESYM", "Symbol not found in loaded library");
    return NULL;
  }
  typedef uint32_t (*fn0_t)(void);
  uint32_t res = ((fn0_t)fn_ptr)();
  napi_value out;
  p_create_uint32(env, res, &out);
  return out;
}

static napi_value fn_call_i32_1(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  p_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 3) {
    p_throw_error(env, "EINVAL", "callI32_1(handle, symbolName, arg0) requires 3 arguments");
    return NULL;
  }
  uint64_t hval = 0;
  int lossless = 0;
  int32_t a0 = 0;
  p_get_value_bigint_uint64(env, args[0], &hval, &lossless);
  char sym[256] = {0};
  size_t len = 0;
  p_get_value_string_utf8(env, args[1], sym, sizeof(sym), &len);
  p_get_value_int32(env, args[2], &a0);

  void* fn_ptr = b8g_ghost_sym((void*)(uintptr_t)hval, sym);
  if (!fn_ptr) {
    p_throw_error(env, "ESYM", "Symbol not found in loaded library");
    return NULL;
  }
  typedef int32_t (*fn1_t)(int32_t);
  int32_t res = ((fn1_t)fn_ptr)(a0);
  napi_value out;
  p_create_int32(env, res, &out);
  return out;
}

static void arena_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  if (!data) return;
#if defined(_WIN32)
  _aligned_free(data);
#else
  free(data);
#endif
}

static napi_value fn_create_arena(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  p_get_cb_info(env, info, &argc, args, NULL, NULL);
  int32_t sz = 4096;
  if (argc >= 1) p_get_value_int32(env, args[0], &sz);
  if (sz < 64) sz = 64;
  size_t aligned_sz = ((size_t)sz + 63u) & ~(size_t)63u;

#if defined(_WIN32)
  void* mem = _aligned_malloc(aligned_sz, 64);
#else
  void* mem = NULL;
  if (posix_memalign(&mem, 64, aligned_sz) != 0) mem = NULL;
#endif
  if (!mem) {
    p_throw_error(env, "ENOMEM", "Failed to allocate 64-byte aligned B8G_ARENA_V1");
    return NULL;
  }
  memset(mem, 0, aligned_sz);
  /* Stamp B8G_ABI_MAGIC_V3 in header word 0 */
  ((uint32_t*)mem)[0] = B8G_ABI_MAGIC_V3;

  napi_value ab;
  p_create_external_arraybuffer(env, mem, aligned_sz, arena_finalize, NULL, &ab);
  return ab;
}

NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  if (!init_napi_table()) return exports;
  napi_value f;
  p_create_function(env, "abiInfo", NAPI_AUTO_LENGTH, fn_abi_info, NULL, &f);
  p_set_named_property(env, exports, "abiInfo", f);
  p_create_function(env, "resolve", NAPI_AUTO_LENGTH, fn_resolve, NULL, &f);
  p_set_named_property(env, exports, "resolve", f);
  p_create_function(env, "dlopen", NAPI_AUTO_LENGTH, fn_dlopen, NULL, &f);
  p_set_named_property(env, exports, "dlopen", f);
  p_create_function(env, "callU32_0", NAPI_AUTO_LENGTH, fn_call_u32_0, NULL, &f);
  p_set_named_property(env, exports, "callU32_0", f);
  p_create_function(env, "callI32_1", NAPI_AUTO_LENGTH, fn_call_i32_1, NULL, &f);
  p_set_named_property(env, exports, "callI32_1", f);
  p_create_function(env, "createArena", NAPI_AUTO_LENGTH, fn_create_arena, NULL, &f);
  p_set_named_property(env, exports, "createArena", f);
  return exports;
}
