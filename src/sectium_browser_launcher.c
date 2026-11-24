/**
 * @file sections/b8g-ghost/src/sectium_browser_launcher.c
 * @description Self-Hydrating Single-Binary `sectium-browser.exe` (Zero-Installer).
 *
 * Downloads the canonical `manifests/index.json` from `awesome-os/b8g-ghost`,
 * hydrates & FIPS 180-4 SHA-256 verifies the core Sectium Browser shards directly
 * from `https://github.com/awesome-os/b8g-ghost/releases/download/cas-v1/<sha256>`
 * into `%LOCALAPPDATA%\AwesomeOS\cas\<sha256>\<filename>`, and launches the
 * verified Sectium Browser Shell (`01-browser-split-shell.exe`).
 *
 * Flags:
 *   --hydrate-only   Hydrate & SHA-256 verify all shards into Machine CAS, then exit 0.
 *   --shell=<name>   Choose shell binary (default: 01-browser-split-shell.exe).
 */
#include "b8g_ghost.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <process.h>
#else
  #include <unistd.h>
#endif

#define GHOST_INDEX_URL "https://raw.githubusercontent.com/awesome-os/b8g-ghost/main/manifests/index.json"
#define GHOST_CAS_BASE  "https://github.com/awesome-os/b8g-ghost/releases/download/cas-v1/"

static int fetch_index_json(char **out_buf, size_t *out_len) {
  char tmp_path[512];
#if defined(_WIN32)
  const char *tmp = getenv("TEMP");
  if (!tmp || !tmp[0]) tmp = ".";
  snprintf(tmp_path, sizeof(tmp_path), "%s\\b8g-ghost-index-%lu.json", tmp, (unsigned long)GetCurrentProcessId());
  char cmd[1024];
  snprintf(cmd, sizeof(cmd), "curl.exe -fsSL --retry 2 \"%s\" -o \"%s\"", GHOST_INDEX_URL, tmp_path);
#else
  snprintf(tmp_path, sizeof(tmp_path), "/tmp/b8g-ghost-index-%d.json", (int)getpid());
  char cmd[1024];
  snprintf(cmd, sizeof(cmd), "curl -fsSL --retry 2 \"%s\" -o \"%s\"", GHOST_INDEX_URL, tmp_path);
#endif
  if (system(cmd) != 0) return -1;

  FILE *fp = fopen(tmp_path, "rb");
  if (!fp) return -1;
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  if (sz <= 0 || sz > 16 * 1024 * 1024) {
    fclose(fp);
    remove(tmp_path);
    return -1;
  }
  char *buf = (char *)malloc((size_t)sz + 1);
  if (!buf) {
    fclose(fp);
    remove(tmp_path);
    return -1;
  }
  size_t n = fread(buf, 1, (size_t)sz, fp);
  buf[n] = '\0';
  fclose(fp);
  remove(tmp_path);
  *out_buf = buf;
  *out_len = n;
  return 0;
}

/* Minimal zero-dependency JSON extractor for `"<filename>": { ... "sha256": "<64-hex>" ... }` */
static int lookup_sha256_in_index(const char *json, const char *filename, char out_sha[65]) {
  char key[300];
  snprintf(key, sizeof(key), "\"%s\"", filename);
  const char *pos = strstr(json, key);
  if (!pos) return -1;
  const char *sha_key = strstr(pos, "\"sha256\"");
  if (!sha_key) return -1;
  const char *colon = strchr(sha_key + 8, ':');
  if (!colon) return -1;
  const char *q1 = strchr(colon, '"');
  if (!q1) return -1;
  q1++;
  for (int i = 0; i < 64; i++) {
    char c = q1[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return -1;
    out_sha[i] = (c >= 'A' && c <= 'F') ? (char)(c + 32) : c;
  }
  out_sha[64] = '\0';
  return 0;
}

static int hydrate_component(const char *json, const char *filename, char *out_path, size_t out_cap) {
  char sha[65];
  if (lookup_sha256_in_index(json, filename, sha) != 0) {
    fprintf(stderr, "[sectium-browser] Missing \"%s\" in canonical Ghost index!\n", filename);
    return -1;
  }
  char url[256];
  snprintf(url, sizeof(url), "%s%s", GHOST_CAS_BASE, sha);

  b8g_ghost_spec_t spec;
  spec.abi_magic    = B8G_ABI_MAGIC_V3;
  spec.ghost_magic  = B8G_GHOST_MAGIC;
  spec.filename     = filename;
  spec.sha256_hex   = sha;
  spec.download_url = url;

  int was_hit = 0;
  int rc = b8g_ghost_resolve(&spec, out_path, out_cap, &was_hit);
  if (rc != 0) {
    fprintf(stderr, "[sectium-browser] FAILED to hydrate %s (rc=%d)\n", filename, rc);
    return rc;
  }
  printf("[sectium-browser] [%s] %s (sha256=%.16s...) -> %s\n",
         was_hit ? "CAS-HIT " : "HYDRATED", filename, sha, out_path);
  return 0;
}

int main(int argc, char **argv) {
  int hydrate_only = 0;
  const char *shell_name = "01-browser-split-shell.exe";

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--hydrate-only") == 0) {
      hydrate_only = 1;
    } else if (strncmp(argv[i], "--shell=", 8) == 0) {
      shell_name = argv[i] + 8;
    }
  }

  printf("[sectium-browser] Self-Hydrating Ghost Launcher (Lumi White Dragon | O(1) cas-v1)\n");
  char *index_json = NULL;
  size_t index_len = 0;
  if (fetch_index_json(&index_json, &index_len) != 0) {
    fprintf(stderr, "[sectium-browser] ERROR: Unable to fetch %s\n", GHOST_INDEX_URL);
    return 1;
  }

  char display_path[512] = {0};
  char brotli_path[512]  = {0};
  char icon_path[512]    = {0};
  char shell_path[512]   = {0};

  int ok = 1;
#if defined(_WIN32)
  if (hydrate_component(index_json, "libsectium_display.dll", display_path, sizeof(display_path)) != 0) ok = 0;
  if (hydrate_component(index_json, "libbrotli-win64.dll", brotli_path, sizeof(brotli_path)) != 0) ok = 0;
  if (hydrate_component(index_json, "lumi-white-dragon.ico", icon_path, sizeof(icon_path)) != 0) ok = 0;
  if (hydrate_component(index_json, shell_name, shell_path, sizeof(shell_path)) != 0) ok = 0;
#else
  if (hydrate_component(index_json, "libsectium_display-linux-x64.so", display_path, sizeof(display_path)) != 0) ok = 0;
  if (hydrate_component(index_json, "libbrotli-linux-x64.so", brotli_path, sizeof(brotli_path)) != 0) ok = 0;
#endif

  free(index_json);
  if (!ok) return 2;

  if (hydrate_only) {
    printf("[sectium-browser] VERIFIED! All components hydrated & SHA-256 verified in Machine CAS.\n");
    return 0;
  }

#if defined(_WIN32)
  SetEnvironmentVariableA("B8G_SECTIUM_DISPLAY_DLL", display_path);
  SetEnvironmentVariableA("B8G_SECTIUM_ICON", icon_path);
  printf("[sectium-browser] Launching %s ...\n", shell_path);
  intptr_t rc = _spawnl(_P_NOWAIT, shell_path, shell_path, NULL);
  if (rc == -1) {
    fprintf(stderr, "[sectium-browser] Failed to spawn %s\n", shell_path);
    return 3;
  }
  return 0;
#else
  printf("[sectium-browser] Hydrated display=%s\n", display_path);
  return 0;
#endif
}
