#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef VERIFIED_PROVIDER_CONTROL_ROOT
#define VERIFIED_PROVIDER_CONTROL_ROOT "/tmp/omnai-verified-provider-no-control"
#endif

#if defined(VERIFIED_PROVIDER_FIXTURE_SAFE) || defined(VERIFIED_PROVIDER_FIXTURE_MALICIOUS)

extern char **environ;

static void fixture_write(int descriptor, const void *bytes, size_t length) {
  ssize_t ignored = write(descriptor, bytes, length);
  (void)ignored;
}

#if defined(VERIFIED_PROVIDER_FIXTURE_SAFE)
static int control_exists(const char *name) {
  char path[4096];
  int written = snprintf(path, sizeof(path), "%s/%s", VERIFIED_PROVIDER_CONTROL_ROOT, name);
  if (written < 0 || (size_t)written >= sizeof(path)) return 0;
  return access(path, F_OK) == 0;
}
#endif

static int write_control(const char *name) {
  char path[4096];
  int written = snprintf(path, sizeof(path), "%s/%s", VERIFIED_PROVIDER_CONTROL_ROOT, name);
  if (written < 0 || (size_t)written >= sizeof(path)) return -1;
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  const char value[] = "1";
  ssize_t ignored = write(fd, value, sizeof(value) - 1U);
  int saved = errno;
  close(fd);
  errno = saved;
  return ignored == (ssize_t)(sizeof(value) - 1U) ? 0 : -1;
}

#if defined(VERIFIED_PROVIDER_FIXTURE_SAFE)

static const char *const exact_environment[] = {
  "GIT_ATTR_NOSYSTEM=1",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_SYSTEM=/dev/null",
  "GIT_NO_LAZY_FETCH=1",
  "GIT_NO_REPLACE_OBJECTS=1",
  "GIT_OPTIONAL_LOCKS=0",
  "GIT_TERMINAL_PROMPT=0",
  "HOME=/nonexistent",
  "LANG=C",
  "LC_ALL=C",
  "TZ=UTC",
  "XDG_CONFIG_HOME=/nonexistent",
};

static int environment_is_exact(void) {
  size_t count = 0U;
  while (environ[count] != NULL) count += 1U;
  if (count != sizeof(exact_environment) / sizeof(exact_environment[0])) return 0;
  for (size_t expected = 0U; expected < count; expected += 1U) {
    int found = 0;
    for (size_t actual = 0U; actual < count; actual += 1U) {
      if (strcmp(exact_environment[expected], environ[actual]) == 0) {
        found = 1;
        break;
      }
    }
    if (!found) return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (!environment_is_exact()) {
    const char message[] = "fixture environment mismatch\n";
    fixture_write(STDERR_FILENO, message, sizeof(message) - 1U);
    return 91;
  }
  const char *command = argc >= 4 ? argv[3] : "";
  if (strcmp(command, "--version") == 0) {
    const char *version = control_exists("invalid-version")
      ? "git version 02.51.1\n"
      : "git version 2.51.1\n";
    fixture_write(STDOUT_FILENO, version, strlen(version));
    return 0;
  }
  if (strcmp(command, "print-environment") == 0) {
    const char value[] = "{\"GIT_ATTR_NOSYSTEM\":\"1\",\"GIT_CONFIG_GLOBAL\":\"/dev/null\",\"GIT_CONFIG_NOSYSTEM\":\"1\",\"GIT_CONFIG_SYSTEM\":\"/dev/null\",\"GIT_NO_LAZY_FETCH\":\"1\",\"GIT_NO_REPLACE_OBJECTS\":\"1\",\"GIT_OPTIONAL_LOCKS\":\"0\",\"GIT_TERMINAL_PROMPT\":\"0\",\"HOME\":\"/nonexistent\",\"LANG\":\"C\",\"LC_ALL\":\"C\",\"TZ\":\"UTC\",\"XDG_CONFIG_HOME\":\"/nonexistent\"}";
    fixture_write(STDOUT_FILENO, value, sizeof(value) - 1U);
    return 0;
  }
  if (strcmp(command, "emit-safe") == 0) {
    const char value[] = "safe descriptor output\n";
    fixture_write(STDOUT_FILENO, value, sizeof(value) - 1U);
    return 0;
  }
  if (strcmp(command, "block-until-release") == 0) {
    if (write_control("child-started") != 0) return 92;
    for (unsigned int attempt = 0U; attempt < 1000U; attempt += 1U) {
      if (control_exists("child-release")) {
        const char value[] = "safe delayed output\n";
        fixture_write(STDOUT_FILENO, value, sizeof(value) - 1U);
        return 0;
      }
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 10000000L };
      (void)nanosleep(&delay, NULL);
    }
    return 93;
  }
  if (strcmp(command, "overflow-output") == 0) {
    char block[4096];
    memset(block, 'x', sizeof(block));
    for (size_t total = 0U; total < 9U * 1024U * 1024U; total += sizeof(block)) {
      if (write(STDOUT_FILENO, block, sizeof(block)) < 0) return 94;
    }
    return 0;
  }
  if (strcmp(command, "never-complete") == 0) {
    for (;;) {
      struct timespec delay = { .tv_sec = 1, .tv_nsec = 0 };
      (void)nanosleep(&delay, NULL);
    }
  }
  if (strcmp(command, "descendant-holds-pipes") == 0) {
    pid_t descendant = fork();
    if (descendant < 0) return 97;
    if (descendant == 0) {
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 450000000L };
      (void)nanosleep(&delay, NULL);
      _exit(write_control("descendant-survived-timeout") == 0 ? 0 : 100);
    }
    return 0;
  }
  if (strcmp(command, "signaled-leader-closed-descendant") == 0) {
    pid_t descendant = fork();
    if (descendant < 0) return 101;
    if (descendant == 0) {
      (void)close(STDOUT_FILENO);
      (void)close(STDERR_FILENO);
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 450000000L };
      (void)nanosleep(&delay, NULL);
      _exit(write_control("descendant-survived-signaled-leader") == 0 ? 0 : 102);
    }
    if (raise(SIGTERM) != 0) return 103;
    return 104;
  }
  if (strcmp(command, "postcheck-closed-descendant") == 0) {
    pid_t descendant = fork();
    if (descendant < 0) return 105;
    if (descendant == 0) {
      (void)close(STDOUT_FILENO);
      (void)close(STDERR_FILENO);
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 450000000L };
      (void)nanosleep(&delay, NULL);
      _exit(write_control("descendant-survived-postcheck") == 0 ? 0 : 106);
    }
    if (write_control("postcheck-child-started") != 0) return 107;
    for (unsigned int attempt = 0U; attempt < 1000U; attempt += 1U) {
      if (control_exists("postcheck-child-release")) return 0;
      struct timespec delay = { .tv_sec = 0, .tv_nsec = 10000000L };
      (void)nanosleep(&delay, NULL);
    }
    return 108;
  }
  return 95;
}

#else

int main(void) {
  if (write_control("malicious-executed") != 0) return 96;
  const char value[] = "malicious output\n";
  fixture_write(STDOUT_FILENO, value, sizeof(value) - 1U);
  return 0;
}

#endif

#else

#include <linux/openat2.h>
#include <pthread.h>

#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif

#ifndef VERIFIED_PROVIDER_CANDIDATE_LOCAL
#define VERIFIED_PROVIDER_CANDIDATE_LOCAL "/usr/local/bin/git"
#endif

#ifndef VERIFIED_PROVIDER_CANDIDATE_SYSTEM
#define VERIFIED_PROVIDER_CANDIDATE_SYSTEM "/usr/bin/git"
#endif

#define PROVIDER_MAX_EXECUTABLE_BYTES (256U * 1024U * 1024U)
#define PROVIDER_MAX_OUTPUT_BYTES (8U * 1024U * 1024U)
#define PROVIDER_MAX_ARGUMENTS 128U
#define PROVIDER_MAX_ARGUMENT_BYTES (1024U * 1024U)
#define PROVIDER_MAX_REPOSITORY_ROOT_BYTES 4096U
#define PROVIDER_TIMEOUT_MILLISECONDS 30000L

/*
 * 背景：目标环境不带 node-gyp/Node 头文件，但 Node 可执行文件导出稳定 N-API ABI。
 * 目的：只声明本绑定实际消费的稳定 N-API ABI，不 vendoring 头文件或引入依赖。
 * 上下文：all-own property API 自 N-API v6 稳定并受 Node 20 支持；发布面仍仅 acquire/execute。
 */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int32_t napi_status;
typedef int32_t napi_valuetype;
typedef int32_t napi_key_collection_mode;
typedef int32_t napi_key_filter;
typedef int32_t napi_key_conversion;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

enum {
  NAPI_OK = 0,
  NAPI_UNDEFINED = 0,
  NAPI_STRING = 4,
  NAPI_OBJECT = 6,
};

enum {
  NAPI_KEY_INCLUDE_PROTOTYPES = 0,
  NAPI_KEY_OWN_ONLY = 1,
  NAPI_KEY_ALL_PROPERTIES = 0,
  NAPI_KEY_KEEP_NUMBERS = 0,
  NAPI_KEY_NUMBERS_TO_STRINGS = 1,
};

extern napi_status napi_create_buffer_copy(napi_env, size_t, const void *, void **, napi_value *);
extern napi_status napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern napi_status napi_create_int32(napi_env, int32_t, napi_value *);
extern napi_status napi_create_object(napi_env, napi_value *);
extern napi_status napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
extern napi_status napi_get_array_length(napi_env, napi_value, uint32_t *);
extern napi_status napi_get_all_property_names(
  napi_env,
  napi_value,
  napi_key_collection_mode,
  napi_key_filter,
  napi_key_conversion,
  napi_value *
);
extern napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern napi_status napi_get_element(napi_env, napi_value, uint32_t, napi_value *);
extern napi_status napi_get_named_property(napi_env, napi_value, const char *, napi_value *);
extern napi_status napi_get_undefined(napi_env, napi_value *);
extern napi_status napi_get_value_string_utf8(napi_env, napi_value, char *, size_t, size_t *);
extern napi_status napi_is_array(napi_env, napi_value, bool *);
extern napi_status napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern napi_status napi_throw_error(napi_env, const char *, const char *);
extern napi_status napi_typeof(napi_env, napi_value, napi_valuetype *);

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t block[64];
  size_t block_length;
} sha256_context;

typedef enum {
  PHASE_OPEN_CANDIDATE = 1,
  PHASE_VERIFY_METADATA = 2,
  PHASE_HASH_BYTES = 3,
  PHASE_EXECUTE_FD = 4,
  PHASE_WAIT = 5,
  PHASE_REOPEN_AND_COMPARE = 6,
  PHASE_ACCEPT_OUTPUT = 7,
  PHASE_VERSION = 8,
  PHASE_ARGUMENTS = 9,
} provider_phase;

typedef struct {
  provider_phase phase;
  int system_errno;
} provider_failure;

typedef struct {
  int descriptor;
  const char *candidate;
  struct stat metadata;
  uint8_t hash[32];
} provider_state;

typedef struct {
  uint8_t *bytes;
  size_t length;
  size_t capacity;
  int overflow;
} bounded_bytes;

typedef struct {
  int exit_code;
  bounded_bytes stdout_bytes;
  bounded_bytes stderr_bytes;
} execution_result;

typedef struct {
  int exited;
  int exit_code;
  int termination_signal;
} child_terminal_status;

static provider_state active_provider = { .descriptor = -1, .candidate = NULL };
static pthread_mutex_t provider_mutex = PTHREAD_MUTEX_INITIALIZER;

#if defined(VERIFIED_PROVIDER_TESTING)
static unsigned int test_error_write_interruptions_remaining = 0U;
static unsigned int test_error_write_partials_remaining = 0U;
static unsigned int test_waitid_interruptions_remaining = 0U;
static unsigned int test_waitpid_interruptions_remaining = 0U;
static int test_force_child_setup_failure = 0;
static int test_record_child_identity = 0;
#endif

static const char *const fixed_candidates[] = {
  VERIFIED_PROVIDER_CANDIDATE_LOCAL,
  VERIFIED_PROVIDER_CANDIDATE_SYSTEM,
};

static char *const sanitized_environment[] = {
  "GIT_ATTR_NOSYSTEM=1",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_SYSTEM=/dev/null",
  "GIT_NO_LAZY_FETCH=1",
  "GIT_NO_REPLACE_OBJECTS=1",
  "GIT_OPTIONAL_LOCKS=0",
  "GIT_TERMINAL_PROMPT=0",
  "HOME=/nonexistent",
  "LANG=C",
  "LC_ALL=C",
  "TZ=UTC",
  "XDG_CONFIG_HOME=/nonexistent",
  NULL,
};

static uint32_t rotate_right(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(sha256_context *context, const uint8_t block[64]) {
  static const uint32_t constants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  uint32_t words[64];
  for (size_t index = 0U; index < 16U; index += 1U) {
    size_t offset = index * 4U;
    words[index] = ((uint32_t)block[offset] << 24U)
      | ((uint32_t)block[offset + 1U] << 16U)
      | ((uint32_t)block[offset + 2U] << 8U)
      | (uint32_t)block[offset + 3U];
  }
  for (size_t index = 16U; index < 64U; index += 1U) {
    uint32_t first = rotate_right(words[index - 15U], 7U) ^ rotate_right(words[index - 15U], 18U) ^ (words[index - 15U] >> 3U);
    uint32_t second = rotate_right(words[index - 2U], 17U) ^ rotate_right(words[index - 2U], 19U) ^ (words[index - 2U] >> 10U);
    words[index] = words[index - 16U] + first + words[index - 7U] + second;
  }
  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];
  for (size_t index = 0U; index < 64U; index += 1U) {
    uint32_t choice = (e & f) ^ ((~e) & g);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t first = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^ rotate_right(e, 25U);
    uint32_t second = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^ rotate_right(a, 22U);
    uint32_t temporary_one = h + first + choice + constants[index] + words[index];
    uint32_t temporary_two = second + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary_one;
    d = c;
    c = b;
    b = a;
    a = temporary_one + temporary_two;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static void sha256_initialize(sha256_context *context) {
  static const uint32_t initial[8] = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
  };
  memcpy(context->state, initial, sizeof(initial));
  context->bit_count = 0U;
  context->block_length = 0U;
}

static void sha256_update(sha256_context *context, const uint8_t *bytes, size_t length) {
  context->bit_count += (uint64_t)length * 8U;
  while (length > 0U) {
    size_t remaining = sizeof(context->block) - context->block_length;
    size_t copied = length < remaining ? length : remaining;
    memcpy(context->block + context->block_length, bytes, copied);
    context->block_length += copied;
    bytes += copied;
    length -= copied;
    if (context->block_length == sizeof(context->block)) {
      sha256_transform(context, context->block);
      context->block_length = 0U;
    }
  }
}

static void sha256_finish(sha256_context *context, uint8_t digest[32]) {
  context->block[context->block_length++] = 0x80U;
  if (context->block_length > 56U) {
    while (context->block_length < 64U) context->block[context->block_length++] = 0U;
    sha256_transform(context, context->block);
    context->block_length = 0U;
  }
  while (context->block_length < 56U) context->block[context->block_length++] = 0U;
  for (size_t index = 0U; index < 8U; index += 1U) {
    context->block[63U - index] = (uint8_t)(context->bit_count >> (index * 8U));
  }
  sha256_transform(context, context->block);
  for (size_t index = 0U; index < 8U; index += 1U) {
    digest[index * 4U] = (uint8_t)(context->state[index] >> 24U);
    digest[index * 4U + 1U] = (uint8_t)(context->state[index] >> 16U);
    digest[index * 4U + 2U] = (uint8_t)(context->state[index] >> 8U);
    digest[index * 4U + 3U] = (uint8_t)context->state[index];
  }
}

static int metadata_stable(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev
    && left->st_ino == right->st_ino
    && left->st_mode == right->st_mode
    && left->st_uid == right->st_uid
    && left->st_size == right->st_size
    && left->st_mtim.tv_sec == right->st_mtim.tv_sec
    && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec
    && left->st_ctim.tv_sec == right->st_ctim.tv_sec
    && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static int metadata_trusted(const struct stat *metadata) {
  return S_ISREG(metadata->st_mode)
    && metadata->st_uid == 0U
    && (metadata->st_mode & 0111U) != 0U
    && (metadata->st_mode & 0022U) == 0U
    && metadata->st_size >= 0
    && (uint64_t)metadata->st_size <= PROVIDER_MAX_EXECUTABLE_BYTES;
}

static int marker_exists(const char *name) {
#if defined(VERIFIED_PROVIDER_TESTING)
  char path[4096];
  int written = snprintf(path, sizeof(path), "%s/%s", VERIFIED_PROVIDER_CONTROL_ROOT, name);
  return written > 0 && (size_t)written < sizeof(path) && access(path, F_OK) == 0;
#else
  (void)name;
  return 0;
#endif
}

#if defined(VERIFIED_PROVIDER_TESTING)
static int write_test_record(int descriptor, const void *bytes, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
    ssize_t count = write(descriptor, (const uint8_t *)bytes + offset, length - offset);
    if (count > 0) {
      offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    return -1;
  }
  return 0;
}

static void write_test_control(const char *name, const void *bytes, size_t length) {
  char path[4096];
  int path_length = snprintf(path, sizeof(path), "%s/%s", VERIFIED_PROVIDER_CONTROL_ROOT, name);
  if (path_length <= 0 || (size_t)path_length >= sizeof(path)) return;
  int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (descriptor < 0) return;
  (void)write_test_record(descriptor, bytes, length);
  (void)close(descriptor);
}

static void record_test_child_identity(pid_t child) {
  char value[64];
  int value_length = snprintf(value, sizeof(value), "%ld", (long)child);
  if (value_length <= 0 || (size_t)value_length >= sizeof(value)) return;
  write_test_control("last-child-pid", value, (size_t)value_length);

  char process_path[64];
  int path_length = child == getpid()
    ? snprintf(process_path, sizeof(process_path), "%s", "/proc/self/stat")
    : snprintf(process_path, sizeof(process_path), "/proc/%ld/stat", (long)child);
  if (path_length <= 0 || (size_t)path_length >= sizeof(process_path)) return;
  int descriptor = open(process_path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) return;
  char process_stat[4096];
  ssize_t count;
  do {
    count = read(descriptor, process_stat, sizeof(process_stat));
  } while (count < 0 && errno == EINTR);
  (void)close(descriptor);
  if (count > 0) write_test_control("last-child-stat", process_stat, (size_t)count);
}

static void record_test_child_reaped(pid_t child) {
  char value[64];
  int value_length = snprintf(value, sizeof(value), "%ld", (long)child);
  if (value_length > 0 && (size_t)value_length < sizeof(value)) {
    write_test_control("last-reaped-child-pid", value, (size_t)value_length);
  }
}
#endif

static int open_candidate(const char *path) {
  if (marker_exists("missing-openat2")) {
    errno = ENOSYS;
    return -1;
  }
  struct open_how how = {
    .flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK,
    .mode = 0U,
    .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
  };
  return (int)syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how));
}

static int hash_stable_descriptor(int descriptor, struct stat *metadata, uint8_t hash[32], provider_failure *failure) {
  struct stat before;
  struct stat after;
  if (fstat(descriptor, &before) != 0) {
    failure->phase = PHASE_VERIFY_METADATA;
    failure->system_errno = errno;
    return -1;
  }
#if defined(VERIFIED_PROVIDER_TESTING)
  if (marker_exists("force-non-root-owner")) before.st_uid = 1U;
#endif
  if (!metadata_trusted(&before)) {
    failure->phase = PHASE_VERIFY_METADATA;
    failure->system_errno = errno;
    return -1;
  }
  sha256_context hash_context;
  sha256_initialize(&hash_context);
  uint8_t buffer[64U * 1024U];
  off_t offset = 0;
  while (offset < before.st_size) {
    size_t wanted = (uint64_t)(before.st_size - offset) < sizeof(buffer)
      ? (size_t)(before.st_size - offset)
      : sizeof(buffer);
    ssize_t count = pread(descriptor, buffer, wanted, offset);
    if (count <= 0) {
      failure->phase = PHASE_HASH_BYTES;
      failure->system_errno = count < 0 ? errno : EIO;
      return -1;
    }
    sha256_update(&hash_context, buffer, (size_t)count);
    offset += count;
  }
  if (fstat(descriptor, &after) != 0 || !metadata_stable(&before, &after)) {
    failure->phase = PHASE_HASH_BYTES;
    failure->system_errno = errno;
    return -1;
  }
  sha256_finish(&hash_context, hash);
  *metadata = after;
  return 0;
}

static int open_and_hash(const char *path, provider_state *state, provider_failure *failure) {
  int descriptor = open_candidate(path);
  if (descriptor < 0) {
    failure->phase = PHASE_OPEN_CANDIDATE;
    failure->system_errno = errno;
    return -1;
  }
  provider_state candidate = { .descriptor = descriptor, .candidate = path };
  if (hash_stable_descriptor(descriptor, &candidate.metadata, candidate.hash, failure) != 0) {
    close(descriptor);
    return -1;
  }
  *state = candidate;
  return 0;
}

static int compare_reopened(const provider_state *expected, provider_failure *failure) {
  provider_state reopened = { .descriptor = -1, .candidate = expected->candidate };
  if (open_and_hash(expected->candidate, &reopened, failure) != 0) {
    failure->phase = PHASE_REOPEN_AND_COMPARE;
    return -1;
  }
  int matches = expected->metadata.st_dev == reopened.metadata.st_dev
    && expected->metadata.st_ino == reopened.metadata.st_ino
    && expected->metadata.st_mode == reopened.metadata.st_mode
    && expected->metadata.st_uid == reopened.metadata.st_uid
    && memcmp(expected->hash, reopened.hash, sizeof(expected->hash)) == 0;
  close(reopened.descriptor);
  if (!matches) {
    failure->phase = PHASE_REOPEN_AND_COMPARE;
    failure->system_errno = ESTALE;
    return -1;
  }
  return 0;
}

static int initialize_bounded_bytes(bounded_bytes *bytes) {
  bytes->bytes = malloc(PROVIDER_MAX_OUTPUT_BYTES);
  bytes->length = 0U;
  bytes->capacity = PROVIDER_MAX_OUTPUT_BYTES;
  bytes->overflow = bytes->bytes == NULL;
  return bytes->bytes == NULL ? -1 : 0;
}

static void free_bounded_bytes(bounded_bytes *bytes) {
  free(bytes->bytes);
  bytes->bytes = NULL;
  bytes->length = 0U;
  bytes->capacity = 0U;
}

static void free_execution_result(execution_result *result) {
  free_bounded_bytes(&result->stdout_bytes);
  free_bounded_bytes(&result->stderr_bytes);
}

static int make_nonblocking(int descriptor) {
  int flags = fcntl(descriptor, F_GETFL);
  return flags < 0 ? -1 : fcntl(descriptor, F_SETFL, flags | O_NONBLOCK);
}

static int drain_pipe(int descriptor, bounded_bytes *target, int *closed) {
  uint8_t buffer[64U * 1024U];
  for (;;) {
#if defined(VERIFIED_PROVIDER_TESTING)
    if (target->overflow && marker_exists("hold-drain-after-overflow")) {
      while (!marker_exists("release-drain-after-overflow")) {
        struct timespec delay = { .tv_sec = 0, .tv_nsec = 10000000L };
        (void)nanosleep(&delay, NULL);
      }
    }
#endif
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count > 0) {
      size_t available = target->capacity - target->length;
      if ((size_t)count > available) {
        target->overflow = 1;
        return 0;
      } else {
        memcpy(target->bytes + target->length, buffer, (size_t)count);
        target->length += (size_t)count;
      }
      continue;
    }
    if (count == 0) {
      *closed = 1;
      close(descriptor);
      return 0;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
  }
}

static long elapsed_milliseconds(const struct timespec *start, const struct timespec *now) {
  long seconds = (long)(now->tv_sec - start->tv_sec);
  long nanoseconds = now->tv_nsec - start->tv_nsec;
  return seconds * 1000L + nanoseconds / 1000000L;
}

static void close_parent_pipe(int descriptor, int *closed) {
  if (!*closed) {
    (void)close(descriptor);
    *closed = 1;
  }
}

static int duplicate_child_descriptor(int source, int target) {
  int temporary = fcntl(source, F_DUPFD_CLOEXEC, 5);
  if (temporary < 0) return -1;
  if (dup2(temporary, target) < 0) {
    close(temporary);
    return -1;
  }
  close(temporary);
  return fcntl(target, F_SETFD, FD_CLOEXEC);
}

static ssize_t provider_error_write(int descriptor, const void *bytes, size_t length) {
#if defined(VERIFIED_PROVIDER_TESTING)
  if (test_error_write_interruptions_remaining > 0U) {
    test_error_write_interruptions_remaining -= 1U;
    errno = EINTR;
    return -1;
  }
  if (test_error_write_partials_remaining > 0U) {
    test_error_write_partials_remaining -= 1U;
    return write(descriptor, bytes, length == 0U ? 0U : 1U);
  }
#endif
  return write(descriptor, bytes, length);
}

static int write_exact_child_error(int descriptor, const void *bytes, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
    ssize_t count = provider_error_write(descriptor, (const uint8_t *)bytes + offset, length - offset);
    if (count > 0) {
      offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    if (count == 0) errno = EIO;
    return -1;
  }
  return 0;
}

static void report_child_error(int descriptor, int system_errno) {
  int preserved_errno = errno;
  (void)write_exact_child_error(descriptor, &system_errno, sizeof(system_errno));
  errno = preserved_errno;
}

static pid_t provider_waitpid(pid_t child, int *status, int options) {
#if defined(VERIFIED_PROVIDER_TESTING)
  if (test_waitpid_interruptions_remaining > 0U) {
    test_waitpid_interruptions_remaining -= 1U;
    errno = EINTR;
    return -1;
  }
#endif
  return waitpid(child, status, options);
}

static pid_t waitpid_retry(pid_t child, int *status, int options) {
  pid_t waited;
  do {
    waited = provider_waitpid(child, status, options);
  } while (waited < 0 && errno == EINTR);
#if defined(VERIFIED_PROVIDER_TESTING)
  if (waited == child && test_record_child_identity) record_test_child_reaped(child);
#endif
  return waited;
}

static int provider_waitid(idtype_t idtype, id_t id, siginfo_t *information, int options) {
#if defined(VERIFIED_PROVIDER_TESTING)
  if (test_waitid_interruptions_remaining > 0U) {
    test_waitid_interruptions_remaining -= 1U;
    errno = EINTR;
    return -1;
  }
#endif
  return waitid(idtype, id, information, options);
}

static int observe_child_terminal(pid_t child, child_terminal_status *terminal) {
  siginfo_t information;
  int observed;
  do {
    memset(&information, 0, sizeof(information));
    observed = provider_waitid(P_PID, (id_t)child, &information, WEXITED | WNOHANG | WNOWAIT);
  } while (observed != 0 && errno == EINTR);
  if (observed != 0) return -1;
  if (information.si_pid == 0) return 0;
  if (information.si_pid != child) {
    errno = ECHILD;
    return -1;
  }
  if (information.si_code == CLD_EXITED) {
    terminal->exited = 1;
    terminal->exit_code = information.si_status;
    terminal->termination_signal = 0;
    return 1;
  }
  if (information.si_code == CLD_KILLED || information.si_code == CLD_DUMPED) {
    terminal->exited = 0;
    terminal->exit_code = 0;
    terminal->termination_signal = information.si_status;
    return 1;
  }
  errno = EPROTO;
  return -1;
}

static int terminate_process_group(pid_t process_group) {
  if (kill(-process_group, SIGKILL) == 0 || errno == ESRCH) return 0;
  return -1;
}

static int reap_child(pid_t child, const child_terminal_status *observed) {
  int status = 0;
  pid_t waited = waitpid_retry(child, &status, 0);
  if (waited != child) {
    if (waited == 0) errno = ECHILD;
    return -1;
  }
  if (observed == NULL) return 0;
  if (observed->exited) {
    if (WIFEXITED(status) && WEXITSTATUS(status) == observed->exit_code) return 0;
  } else if (WIFSIGNALED(status) && WTERMSIG(status) == observed->termination_signal) {
    return 0;
  }
  errno = EPROTO;
  return -1;
}

static int terminate_group_and_reap(
  pid_t child,
  pid_t process_group,
  const child_terminal_status *observed
) {
  int first_failure_errno = 0;
  if (terminate_process_group(process_group) != 0) first_failure_errno = errno;
  if (reap_child(child, observed) != 0 && first_failure_errno == 0) first_failure_errno = errno;
  if (first_failure_errno != 0) {
    errno = first_failure_errno;
    return -1;
  }
  return 0;
}

static int await_process_group_release(int descriptor) {
  uint8_t token = 0U;
  ssize_t count;
  do {
    count = read(descriptor, &token, sizeof(token));
  } while (count < 0 && errno == EINTR);
  int saved_errno = count < 0 ? errno : EIO;
  (void)close(descriptor);
  if (count != (ssize_t)sizeof(token) || token != 0xa5U) {
    errno = saved_errno;
    return -1;
  }
  return 0;
}

static int release_process_group_child(int descriptor) {
  const uint8_t token = 0xa5U;
  ssize_t count;
  do {
    count = write(descriptor, &token, sizeof(token));
  } while (count < 0 && errno == EINTR);
  int saved_errno = count < 0 ? errno : EIO;
  (void)close(descriptor);
  if (count != (ssize_t)sizeof(token)) {
    errno = saved_errno;
    return -1;
  }
  return 0;
}

static void child_execute(
  const provider_state *state,
  char *const argv[],
  int stdout_descriptor,
  int stderr_descriptor,
  int error_descriptor
) {
#if defined(VERIFIED_PROVIDER_TESTING)
  if (test_force_child_setup_failure) {
    report_child_error(error_descriptor, ENOTSUP);
    _exit(126);
  }
#endif
  int null_descriptor = open("/dev/null", O_RDONLY | O_CLOEXEC);
  if (null_descriptor < 0
    || dup2(null_descriptor, STDIN_FILENO) < 0
    || dup2(stdout_descriptor, STDOUT_FILENO) < 0
    || dup2(stderr_descriptor, STDERR_FILENO) < 0
    || duplicate_child_descriptor(state->descriptor, 3) < 0
    || duplicate_child_descriptor(error_descriptor, 4) < 0) {
    report_child_error(error_descriptor, errno);
    _exit(126);
  }
  (void)close(null_descriptor);
  int close_result = (int)syscall(SYS_close_range, 5U, UINT_MAX, 0U);
  if (close_result != 0 && errno != ENOSYS) {
    report_child_error(4, errno);
    _exit(126);
  }
  if (close_result != 0) {
    long maximum = sysconf(_SC_OPEN_MAX);
    if (maximum < 0 || maximum > 65536L) maximum = 65536L;
    for (int descriptor = 5; descriptor < maximum; descriptor += 1) (void)close(descriptor);
  }
  if (chdir("/") != 0) {
    report_child_error(4, errno);
    _exit(126);
  }
  execveat(3, "", argv, sanitized_environment, AT_EMPTY_PATH);
  int execution_errno = errno;
  report_child_error(4, execution_errno);
  _exit(127);
}

static void close_pipe_pair(int descriptors[2]) {
  for (size_t index = 0U; index < 2U; index += 1U) {
    if (descriptors[index] >= 0) {
      (void)close(descriptors[index]);
      descriptors[index] = -1;
    }
  }
}

static int wait_for_child(
  pid_t child,
  pid_t process_group,
  int stdout_descriptor,
  int stderr_descriptor,
  int error_descriptor,
  long timeout_milliseconds,
  execution_result *result,
  provider_failure *failure,
  child_terminal_status *terminal
) {
  int stdout_closed = 0;
  int stderr_closed = 0;
  int error_closed = 0;
  int child_terminal = 0;
  int execution_errno = 0;
  size_t execution_errno_bytes = 0U;
  struct timespec start;
  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0
    || make_nonblocking(stdout_descriptor) != 0
    || make_nonblocking(stderr_descriptor) != 0
    || make_nonblocking(error_descriptor) != 0) goto wait_failure;

  while (!child_terminal || !stdout_closed || !stderr_closed || !error_closed) {
    if (!stdout_closed && drain_pipe(stdout_descriptor, &result->stdout_bytes, &stdout_closed) != 0) goto wait_failure;
    if (!stderr_closed && drain_pipe(stderr_descriptor, &result->stderr_bytes, &stderr_closed) != 0) goto wait_failure;
    if (!error_closed) {
      uint8_t *target = (uint8_t *)&execution_errno;
      ssize_t count = read(error_descriptor, target + execution_errno_bytes, sizeof(execution_errno) - execution_errno_bytes);
      if (count > 0) {
        execution_errno_bytes += (size_t)count;
        if (execution_errno_bytes == sizeof(execution_errno)) {
          error_closed = 1;
          (void)close(error_descriptor);
        }
      }
      else if (count == 0) {
        error_closed = 1;
        (void)close(error_descriptor);
      } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) goto wait_failure;
    }
    if (result->stdout_bytes.overflow || result->stderr_bytes.overflow) {
      (void)terminate_group_and_reap(
        child,
        process_group,
        child_terminal ? terminal : NULL
      );
      close_parent_pipe(stdout_descriptor, &stdout_closed);
      close_parent_pipe(stderr_descriptor, &stderr_closed);
      close_parent_pipe(error_descriptor, &error_closed);
      failure->phase = PHASE_ACCEPT_OUTPUT;
      failure->system_errno = EOVERFLOW;
      return -1;
    }
    /*
     * 背景：直接 child 的 PID 同时是独立 process group 的 PGID。
     * 目的：后代仍持 pipe 或 postcheck 尚未完成时保留 zombie group leader，避免 PGID 被复用。
     * 上下文：三个 pipe 全闭合后用 waitid(WNOWAIT) 非回收观察；child 仍活时继续受总 deadline 约束。
     */
    if (!child_terminal && stdout_closed && stderr_closed && error_closed) {
      int observed = observe_child_terminal(child, terminal);
      if (observed < 0) goto wait_failure;
      if (observed > 0) child_terminal = 1;
    }
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) goto wait_failure;
    /*
     * 背景：Git 的直接子进程退出后，后代仍可能继承 stdout/stderr 并保持管道开启。
     * 目的：总等待窗口同时约束进程和管道生命周期，避免已退出子进程绕过超时。
     * 上下文：group leader 在后代 pipe 关闭前不回收，故这里的负 PGID 仍由本次执行占有。
     */
    if (elapsed_milliseconds(&start, &now) > timeout_milliseconds) {
      (void)terminate_group_and_reap(
        child,
        process_group,
        child_terminal ? terminal : NULL
      );
      close_parent_pipe(stdout_descriptor, &stdout_closed);
      close_parent_pipe(stderr_descriptor, &stderr_closed);
      close_parent_pipe(error_descriptor, &error_closed);
      failure->phase = PHASE_WAIT;
      failure->system_errno = ETIMEDOUT;
      return -1;
    }
    if (!child_terminal || !stdout_closed || !stderr_closed || !error_closed) {
      struct pollfd poll_descriptors[3];
      nfds_t count = 0U;
      if (!stdout_closed) poll_descriptors[count++] = (struct pollfd){ .fd = stdout_descriptor, .events = POLLIN | POLLHUP };
      if (!stderr_closed) poll_descriptors[count++] = (struct pollfd){ .fd = stderr_descriptor, .events = POLLIN | POLLHUP };
      if (!error_closed) poll_descriptors[count++] = (struct pollfd){ .fd = error_descriptor, .events = POLLIN | POLLHUP };
      int polled = poll(poll_descriptors, count, 10);
      if (polled < 0 && errno != EINTR) goto wait_failure;
    }
  }
  if (execution_errno_bytes != 0U) {
    int first_failure_errno = execution_errno_bytes == sizeof(execution_errno) ? execution_errno : EIO;
    (void)terminate_group_and_reap(child, process_group, terminal);
    failure->phase = PHASE_EXECUTE_FD;
    failure->system_errno = first_failure_errno;
    return -1;
  }
  if (!terminal->exited) {
    (void)terminate_group_and_reap(child, process_group, terminal);
    failure->phase = PHASE_WAIT;
    failure->system_errno = EINTR;
    return -1;
  }
  result->exit_code = terminal->exit_code;
  return 0;

wait_failure:
  {
  int first_failure_errno = errno;
  (void)terminate_group_and_reap(
    child,
    process_group,
    child_terminal ? terminal : NULL
  );
  close_parent_pipe(stdout_descriptor, &stdout_closed);
  close_parent_pipe(stderr_descriptor, &stderr_closed);
  close_parent_pipe(error_descriptor, &error_closed);
  failure->phase = PHASE_WAIT;
  failure->system_errno = first_failure_errno;
  return -1;
  }
}

static int run_descriptor(
  const provider_state *state,
  const char *repository_root,
  char *const arguments[],
  size_t argument_count,
  execution_result *result,
  provider_failure *failure
) {
  struct stat current_metadata;
  uint8_t current_hash[32];
  if (hash_stable_descriptor(state->descriptor, &current_metadata, current_hash, failure) != 0
    || !metadata_stable(&state->metadata, &current_metadata)
    || memcmp(state->hash, current_hash, sizeof(current_hash)) != 0) {
    failure->phase = PHASE_HASH_BYTES;
    failure->system_errno = ESTALE;
    return -1;
  }
  if (initialize_bounded_bytes(&result->stdout_bytes) != 0
    || initialize_bounded_bytes(&result->stderr_bytes) != 0) {
    free_execution_result(result);
    failure->phase = PHASE_ACCEPT_OUTPUT;
    failure->system_errno = ENOMEM;
    return -1;
  }
  char **argv = calloc(argument_count + 4U, sizeof(char *));
  if (argv == NULL) {
    free_execution_result(result);
    failure->phase = PHASE_ARGUMENTS;
    failure->system_errno = ENOMEM;
    return -1;
  }
  argv[0] = (char *)"git";
  argv[1] = (char *)"-C";
  argv[2] = (char *)repository_root;
  for (size_t index = 0U; index < argument_count; index += 1U) argv[index + 3U] = arguments[index];

  int stdout_pipe[2] = { -1, -1 };
  int stderr_pipe[2] = { -1, -1 };
  int error_pipe[2] = { -1, -1 };
  int start_pipe[2] = { -1, -1 };
  if (pipe2(stdout_pipe, O_CLOEXEC) != 0
    || pipe2(stderr_pipe, O_CLOEXEC) != 0
    || pipe2(error_pipe, O_CLOEXEC) != 0
    || pipe2(start_pipe, O_CLOEXEC) != 0) {
    int pipe_errno = errno;
    close_pipe_pair(stdout_pipe);
    close_pipe_pair(stderr_pipe);
    close_pipe_pair(error_pipe);
    close_pipe_pair(start_pipe);
    free(argv);
    free_execution_result(result);
    failure->phase = PHASE_EXECUTE_FD;
    failure->system_errno = pipe_errno;
    return -1;
  }
#if defined(VERIFIED_PROVIDER_TESTING)
  test_error_write_interruptions_remaining = marker_exists("interrupt-child-error-write") ? 1U : 0U;
  test_error_write_partials_remaining = marker_exists("partial-child-error-write") ? 1U : 0U;
  test_waitid_interruptions_remaining = marker_exists("interrupt-waitid-twice") ? 2U : 0U;
  test_waitpid_interruptions_remaining = marker_exists("interrupt-waitpid-twice") ? 2U : 0U;
  test_force_child_setup_failure = marker_exists("force-child-setup-failure");
  test_record_child_identity = marker_exists("record-child-pid");
#endif
  pid_t child = fork();
  if (child == 0) {
    close(stdout_pipe[0]);
    close(stderr_pipe[0]);
    close(error_pipe[0]);
    close(start_pipe[1]);
#if defined(VERIFIED_PROVIDER_TESTING)
    if (test_record_child_identity) record_test_child_identity(getpid());
#endif
    if (await_process_group_release(start_pipe[0]) != 0) {
      report_child_error(error_pipe[1], errno);
      _exit(126);
    }
    child_execute(state, argv, stdout_pipe[1], stderr_pipe[1], error_pipe[1]);
  }
  int fork_errno = child < 0 ? errno : 0;
  close(start_pipe[0]);
  close(stdout_pipe[1]);
  close(stderr_pipe[1]);
  close(error_pipe[1]);
  if (child < 0) {
    close(start_pipe[1]);
    close(stdout_pipe[0]);
    close(stderr_pipe[0]);
    close(error_pipe[0]);
    free(argv);
    free_execution_result(result);
    failure->phase = PHASE_EXECUTE_FD;
    failure->system_errno = fork_errno;
    return -1;
  }
  int group_setup_errno = 0;
  int group_established = 0;
  if (setpgid(child, child) != 0) {
    group_setup_errno = errno;
    close(start_pipe[1]);
  } else {
    group_established = 1;
    if (release_process_group_child(start_pipe[1]) != 0) group_setup_errno = errno;
  }
  start_pipe[1] = -1;
  if (group_setup_errno != 0) {
    if (group_established) (void)kill(-child, SIGKILL);
    else (void)kill(child, SIGKILL);
    (void)waitpid_retry(child, NULL, 0);
    close(stdout_pipe[0]);
    close(stderr_pipe[0]);
    close(error_pipe[0]);
    free(argv);
    free_execution_result(result);
    failure->phase = PHASE_EXECUTE_FD;
    failure->system_errno = group_setup_errno;
    return -1;
  }
  long timeout = marker_exists("short-timeout") ? 200L : PROVIDER_TIMEOUT_MILLISECONDS;
  child_terminal_status terminal = { .exited = 0, .exit_code = 0, .termination_signal = 0 };
  int waited = wait_for_child(
    child,
    child,
    stdout_pipe[0],
    stderr_pipe[0],
    error_pipe[0],
    timeout,
    result,
    failure,
    &terminal
  );
  free(argv);
  if (waited != 0) {
    free_execution_result(result);
    return -1;
  }
  int post_wait_failed = 0;
  if (terminate_process_group(child) != 0) {
    failure->phase = PHASE_WAIT;
    failure->system_errno = errno;
    post_wait_failed = 1;
  } else if (compare_reopened(state, failure) != 0) {
    post_wait_failed = 1;
  }
  if (reap_child(child, &terminal) != 0 && !post_wait_failed) {
    failure->phase = PHASE_WAIT;
    failure->system_errno = errno;
    post_wait_failed = 1;
  }
  if (post_wait_failed) {
    free_execution_result(result);
    return -1;
  }
  return 0;
}

static int canonical_version(const bounded_bytes *stdout_bytes) {
  static const char prefix[] = "git version ";
  if (stdout_bytes->length <= sizeof(prefix) || stdout_bytes->bytes[stdout_bytes->length - 1U] != '\n') return 0;
  if (memcmp(stdout_bytes->bytes, prefix, sizeof(prefix) - 1U) != 0) return 0;
  size_t end = stdout_bytes->length - 1U;
  size_t index = sizeof(prefix) - 1U;
  unsigned int components = 0U;
  while (index < end) {
    size_t start = index;
    while (index < end && stdout_bytes->bytes[index] >= '0' && stdout_bytes->bytes[index] <= '9') index += 1U;
    if (index == start || (index - start > 1U && stdout_bytes->bytes[start] == '0')) return 0;
    components += 1U;
    if (index == end) break;
    if (stdout_bytes->bytes[index] != '.') return 0;
    index += 1U;
  }
  return components == 3U || components == 4U;
}

static void prefer_failure(provider_failure *current, const provider_failure *candidate) {
  if (current->phase == 0 || candidate->phase > current->phase) *current = *candidate;
}

static int acquire_verified_provider(provider_state *state, execution_result *version, provider_failure *failure) {
  provider_failure best = { .phase = 0, .system_errno = 0 };
  for (size_t index = 0U; index < sizeof(fixed_candidates) / sizeof(fixed_candidates[0]); index += 1U) {
    provider_state candidate = { .descriptor = -1, .candidate = fixed_candidates[index] };
    provider_failure attempt = { .phase = 0, .system_errno = 0 };
    if (open_and_hash(fixed_candidates[index], &candidate, &attempt) != 0) {
      prefer_failure(&best, &attempt);
      continue;
    }
    char *version_arguments[] = { (char *)"--version" };
    execution_result output = { 0 };
    if (run_descriptor(&candidate, "/", version_arguments, 1U, &output, &attempt) != 0) {
      close(candidate.descriptor);
      prefer_failure(&best, &attempt);
      continue;
    }
    if (output.exit_code != 0 || output.stderr_bytes.length != 0U || !canonical_version(&output.stdout_bytes)) {
      free_execution_result(&output);
      close(candidate.descriptor);
      attempt.phase = PHASE_VERSION;
      attempt.system_errno = EPROTO;
      prefer_failure(&best, &attempt);
      continue;
    }
    *state = candidate;
    *version = output;
    return 0;
  }
  *failure = best;
  return -1;
}

static const char *phase_code(provider_phase phase) {
  switch (phase) {
    case PHASE_OPEN_CANDIDATE: return "VERIFIED_PROVIDER_OPEN_CANDIDATE";
    case PHASE_VERIFY_METADATA: return "VERIFIED_PROVIDER_VERIFY_METADATA";
    case PHASE_HASH_BYTES: return "VERIFIED_PROVIDER_HASH_BYTES";
    case PHASE_EXECUTE_FD: return "VERIFIED_PROVIDER_EXECUTE_FD";
    case PHASE_WAIT: return "VERIFIED_PROVIDER_WAIT";
    case PHASE_REOPEN_AND_COMPARE: return "VERIFIED_PROVIDER_REOPEN_AND_COMPARE";
    case PHASE_ACCEPT_OUTPUT: return "VERIFIED_PROVIDER_OUTPUT_LIMIT";
    case PHASE_VERSION: return "VERIFIED_PROVIDER_VERSION";
    case PHASE_ARGUMENTS: return "VERIFIED_PROVIDER_ARGUMENTS";
    default: return "VERIFIED_PROVIDER_UNAVAILABLE";
  }
}

static napi_value throw_failure(napi_env env, provider_failure failure) {
  const char *code = phase_code(failure.phase);
  char message[256];
  (void)snprintf(message, sizeof(message), "%s: native provider rejected operation (errno=%d)", code, failure.system_errno);
  (void)napi_throw_error(env, code, message);
  return NULL;
}

static int set_named_string(napi_env env, napi_value object, const char *name, const char *value) {
  napi_value result;
  return napi_create_string_utf8(env, value, strlen(value), &result) == NAPI_OK
    && napi_set_named_property(env, object, name, result) == NAPI_OK ? 0 : -1;
}

static int set_named_int(napi_env env, napi_value object, const char *name, int value) {
  napi_value result;
  return napi_create_int32(env, value, &result) == NAPI_OK
    && napi_set_named_property(env, object, name, result) == NAPI_OK ? 0 : -1;
}

static int set_named_buffer(napi_env env, napi_value object, const char *name, const bounded_bytes *bytes) {
  napi_value result;
  void *copied = NULL;
  return napi_create_buffer_copy(env, bytes->length, bytes->bytes, &copied, &result) == NAPI_OK
    && napi_set_named_property(env, object, name, result) == NAPI_OK ? 0 : -1;
}

static void format_hash(const uint8_t hash[32], char output[72]) {
  static const char hex[] = "0123456789abcdef";
  memcpy(output, "sha256:", 7U);
  for (size_t index = 0U; index < 32U; index += 1U) {
    output[7U + index * 2U] = hex[hash[index] >> 4U];
    output[8U + index * 2U] = hex[hash[index] & 0x0fU];
  }
  output[71] = '\0';
}

static napi_value acquire_callback(napi_env env, napi_callback_info info) {
  size_t argument_count = 1U;
  napi_value arguments[1];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != NAPI_OK || argument_count != 0U) {
    return throw_failure(env, (provider_failure){ .phase = PHASE_ARGUMENTS, .system_errno = EINVAL });
  }
  (void)pthread_mutex_lock(&provider_mutex);
  if (active_provider.descriptor >= 0) close(active_provider.descriptor);
  active_provider = (provider_state){ .descriptor = -1, .candidate = NULL };
  execution_result version = { 0 };
  provider_failure failure = { .phase = PHASE_OPEN_CANDIDATE, .system_errno = ENOENT };
  if (acquire_verified_provider(&active_provider, &version, &failure) != 0) {
    (void)pthread_mutex_unlock(&provider_mutex);
    return throw_failure(env, failure);
  }
  napi_value object;
  char hash[72];
  format_hash(active_provider.hash, hash);
  int failed = napi_create_object(env, &object) != NAPI_OK
    || set_named_string(env, object, "candidatePath", active_provider.candidate) != 0
    || set_named_string(env, object, "realPath", active_provider.candidate) != 0
    || set_named_string(env, object, "bytesHash", hash) != 0
    || set_named_buffer(env, object, "stdout", &version.stdout_bytes) != 0;
  free_execution_result(&version);
  if (failed) {
    close(active_provider.descriptor);
    active_provider = (provider_state){ .descriptor = -1, .candidate = NULL };
    (void)pthread_mutex_unlock(&provider_mutex);
    return throw_failure(env, (provider_failure){ .phase = PHASE_ACCEPT_OUTPUT, .system_errno = EIO });
  }
  (void)pthread_mutex_unlock(&provider_mutex);
  return object;
}

static int read_string(napi_env env, napi_value value, size_t maximum, char **output, size_t *length) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != NAPI_OK || type != NAPI_STRING) return -1;
  size_t required = 0U;
  if (napi_get_value_string_utf8(env, value, NULL, 0U, &required) != NAPI_OK || required > maximum) return -1;
  char *bytes = malloc(required + 1U);
  if (bytes == NULL) return -1;
  size_t copied = 0U;
  /*
   * 背景：N-API 字符串可含 NUL，而 execveat 的 argv 以 NUL 终止。
   * 目的：在 native 边界拒绝截断歧义；上下文：root、argument 与 key 共用此读取器。
   */
  if (napi_get_value_string_utf8(env, value, bytes, required + 1U, &copied) != NAPI_OK
    || copied != required
    || memchr(bytes, '\0', copied) != NULL) {
    free(bytes);
    return -1;
  }
  *output = bytes;
  *length = required;
  return 0;
}

static void free_arguments(char **arguments, size_t count) {
  if (arguments == NULL) return;
  for (size_t index = 0U; index < count; index += 1U) free(arguments[index]);
  free(arguments);
}

static int has_exact_execute_keys(napi_env env, napi_value input) {
  napi_value names;
  uint32_t count = 0U;
  if (napi_get_all_property_names(
      env,
      input,
      NAPI_KEY_OWN_ONLY,
      NAPI_KEY_ALL_PROPERTIES,
      NAPI_KEY_NUMBERS_TO_STRINGS,
      &names
    ) != NAPI_OK
    || napi_get_array_length(env, names, &count) != NAPI_OK
    || count != 2U) return 0;
  int saw_root = 0;
  int saw_arguments = 0;
  for (uint32_t index = 0U; index < count; index += 1U) {
    napi_value name;
    char *text = NULL;
    size_t length = 0U;
    if (napi_get_element(env, names, index, &name) != NAPI_OK
      || read_string(env, name, 32U, &text, &length) != 0) {
      free(text);
      return 0;
    }
    if (length == strlen("repositoryRoot") && strcmp(text, "repositoryRoot") == 0) saw_root = 1;
    else if (length == strlen("args") && strcmp(text, "args") == 0) saw_arguments = 1;
    else {
      free(text);
      return 0;
    }
    free(text);
  }
  return saw_root && saw_arguments;
}

static int parse_canonical_array_index(const char *text, size_t length, uint32_t *output) {
  if (length == 0U || (length > 1U && text[0] == '0')) return -1;
  uint64_t value = 0U;
  for (size_t index = 0U; index < length; index += 1U) {
    if (text[index] < '0' || text[index] > '9') return -1;
    value = value * 10U + (uint64_t)(text[index] - '0');
    if (value > UINT32_MAX) return -1;
  }
  *output = (uint32_t)value;
  return 0;
}

static int has_exact_argument_array_keys(napi_env env, napi_value input, uint32_t argument_count) {
  napi_value names;
  uint32_t count = 0U;
  if (napi_get_all_property_names(
      env,
      input,
      NAPI_KEY_OWN_ONLY,
      NAPI_KEY_ALL_PROPERTIES,
      NAPI_KEY_NUMBERS_TO_STRINGS,
      &names
    ) != NAPI_OK
    || napi_get_array_length(env, names, &count) != NAPI_OK
    || count != argument_count + 1U) return 0;
  uint8_t seen[PROVIDER_MAX_ARGUMENTS] = { 0U };
  int saw_length = 0;
  for (uint32_t index = 0U; index < count; index += 1U) {
    napi_value name;
    char *text = NULL;
    size_t length = 0U;
    if (napi_get_element(env, names, index, &name) != NAPI_OK
      || read_string(env, name, 32U, &text, &length) != 0) {
      free(text);
      return 0;
    }
    if (length == strlen("length") && strcmp(text, "length") == 0) {
      if (saw_length) {
        free(text);
        return 0;
      }
      saw_length = 1;
    } else {
      uint32_t element_index = 0U;
      if (parse_canonical_array_index(text, length, &element_index) != 0
        || element_index >= argument_count
        || seen[element_index]) {
        free(text);
        return 0;
      }
      seen[element_index] = 1U;
    }
    free(text);
  }
  if (!saw_length) return 0;
  for (uint32_t index = 0U; index < argument_count; index += 1U) {
    if (!seen[index]) return 0;
  }
  return 1;
}

static int parse_execute_input(
  napi_env env,
  napi_callback_info info,
  char **repository_root,
  char ***arguments,
  size_t *argument_count
) {
  size_t callback_argument_count = 2U;
  napi_value callback_arguments[2];
  if (napi_get_cb_info(env, info, &callback_argument_count, callback_arguments, NULL, NULL) != NAPI_OK
    || callback_argument_count != 1U) return -1;
  napi_valuetype input_type;
  if (napi_typeof(env, callback_arguments[0], &input_type) != NAPI_OK
    || input_type != NAPI_OBJECT
    || !has_exact_execute_keys(env, callback_arguments[0])) return -1;
  napi_value root_value;
  napi_value args_value;
  if (napi_get_named_property(env, callback_arguments[0], "repositoryRoot", &root_value) != NAPI_OK
    || napi_get_named_property(env, callback_arguments[0], "args", &args_value) != NAPI_OK) return -1;
  size_t root_length = 0U;
  if (read_string(env, root_value, PROVIDER_MAX_REPOSITORY_ROOT_BYTES, repository_root, &root_length) != 0
    || root_length == 0U || (*repository_root)[0] != '/') return -1;
  bool is_array = false;
  uint32_t count = 0U;
  if (napi_is_array(env, args_value, &is_array) != NAPI_OK || !is_array
    || napi_get_array_length(env, args_value, &count) != NAPI_OK
    || count == 0U || count > PROVIDER_MAX_ARGUMENTS
    || !has_exact_argument_array_keys(env, args_value, count)) return -1;
  char **parsed = calloc(count, sizeof(char *));
  if (parsed == NULL) return -1;
  size_t total = root_length;
  for (uint32_t index = 0U; index < count; index += 1U) {
    napi_value element;
    size_t length = 0U;
    if (napi_get_element(env, args_value, index, &element) != NAPI_OK
      || read_string(env, element, PROVIDER_MAX_ARGUMENT_BYTES, &parsed[index], &length) != 0
      || total + length > PROVIDER_MAX_ARGUMENT_BYTES) {
      free_arguments(parsed, count);
      return -1;
    }
    total += length;
  }
  *arguments = parsed;
  *argument_count = count;
  return 0;
}

static napi_value execute_callback(napi_env env, napi_callback_info info) {
  char *repository_root = NULL;
  char **arguments = NULL;
  size_t argument_count = 0U;
  if (parse_execute_input(env, info, &repository_root, &arguments, &argument_count) != 0) {
    free(repository_root);
    free_arguments(arguments, argument_count);
    return throw_failure(env, (provider_failure){ .phase = PHASE_ARGUMENTS, .system_errno = EINVAL });
  }
  (void)pthread_mutex_lock(&provider_mutex);
  if (active_provider.descriptor < 0) {
    (void)pthread_mutex_unlock(&provider_mutex);
    free(repository_root);
    free_arguments(arguments, argument_count);
    return throw_failure(env, (provider_failure){ .phase = PHASE_EXECUTE_FD, .system_errno = EBADF });
  }
  execution_result result = { 0 };
  provider_failure failure = { .phase = PHASE_EXECUTE_FD, .system_errno = 0 };
  int failed = run_descriptor(
    &active_provider,
    repository_root,
    arguments,
    argument_count,
    &result,
    &failure
  );
  free(repository_root);
  free_arguments(arguments, argument_count);
  if (failed != 0) {
    (void)pthread_mutex_unlock(&provider_mutex);
    return throw_failure(env, failure);
  }
  napi_value object;
  failed = napi_create_object(env, &object) != NAPI_OK
    || set_named_int(env, object, "exitCode", result.exit_code) != 0
    || set_named_buffer(env, object, "stdout", &result.stdout_bytes) != 0
    || set_named_buffer(env, object, "stderr", &result.stderr_bytes) != 0;
  free_execution_result(&result);
  (void)pthread_mutex_unlock(&provider_mutex);
  if (failed) return throw_failure(env, (provider_failure){ .phase = PHASE_ACCEPT_OUTPUT, .system_errno = EIO });
  return object;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value acquire_function;
  napi_value execute_function;
  if (napi_create_function(env, "acquire", 7U, acquire_callback, NULL, &acquire_function) != NAPI_OK
    || napi_create_function(env, "execute", 7U, execute_callback, NULL, &execute_function) != NAPI_OK
    || napi_set_named_property(env, exports, "acquire", acquire_function) != NAPI_OK
    || napi_set_named_property(env, exports, "execute", execute_function) != NAPI_OK) {
    (void)napi_throw_error(env, "VERIFIED_PROVIDER_MODULE_INIT", "VERIFIED_PROVIDER_MODULE_INIT: N-API export failed");
  }
  return exports;
}

#endif
