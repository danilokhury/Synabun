/*
 * SynaBun — native entry point of a packaged build
 *
 * The one executable a packaged application exposes:
 *
 *   macOS    SynaBun.app/Contents/MacOS/SynaBun
 *   Windows  SynaBun.exe
 *   Linux    AppRun (the AppImage's entry, and `synabun` in the portable bundle)
 *
 * It has no behaviour of its own. It finds the Node runtime and the
 * application that were built next to it, tells them where it lives, and runs
 * the right script with the caller's arguments and stdio untouched:
 *
 *   SynaBun mcp [...]   the MCP server on stdio (mcp-server/run.mjs), for an IDE
 *   SynaBun [...]       everything else goes to the packaged bootstrap
 *
 * Nothing is read from the PATH and no shell is involved: every path is built
 * from this file's own location, and arguments are passed through as they are.
 *
 * C99, libc / kernel32 only. Built by packaging/lib/launcher-build.mjs.
 */

#define SYNABUN_MANIFEST "synabun-package.json"
#define SYNABUN_ENTRY_ENV "SYNABUN_PACKAGED_ENTRY"
#define SYNABUN_NODE_FLAG "--disable-warning=ExperimentalWarning"

#if defined(_WIN32)

/* ───────────────────────────── Windows ───────────────────────────── */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define LONG_PATH 32768

typedef struct {
  wchar_t *text;
  size_t length;
  size_t capacity;
} wbuf;

static void die(const wchar_t *what, const wchar_t *detail) {
  fwprintf(stderr, L"SynaBun: %ls%ls%ls\n", what, detail ? L": " : L"", detail ? detail : L"");
  ExitProcess(127);
}

static void wbuf_reserve(wbuf *buffer, size_t extra) {
  size_t needed = buffer->length + extra + 1;
  if (needed <= buffer->capacity) return;
  size_t capacity = buffer->capacity ? buffer->capacity : 256;
  while (capacity < needed) capacity *= 2;
  wchar_t *grown = (wchar_t *)realloc(buffer->text, capacity * sizeof(wchar_t));
  if (!grown) die(L"out of memory", NULL);
  buffer->text = grown;
  buffer->capacity = capacity;
}

static void wbuf_char(wbuf *buffer, wchar_t value) {
  wbuf_reserve(buffer, 1);
  buffer->text[buffer->length++] = value;
  buffer->text[buffer->length] = L'\0';
}

static void wbuf_text(wbuf *buffer, const wchar_t *value) {
  size_t count = wcslen(value);
  wbuf_reserve(buffer, count);
  memcpy(buffer->text + buffer->length, value, count * sizeof(wchar_t));
  buffer->length += count;
  buffer->text[buffer->length] = L'\0';
}

/* One argument, quoted the way CommandLineToArgvW reads it back. */
static void append_argument(wbuf *line, const wchar_t *argument) {
  if (line->length) wbuf_char(line, L' ');
  if (*argument && !wcspbrk(argument, L" \t\n\v\"")) {
    wbuf_text(line, argument);
    return;
  }
  wbuf_char(line, L'"');
  for (const wchar_t *at = argument;; at++) {
    size_t slashes = 0;
    while (*at == L'\\') {
      at++;
      slashes++;
    }
    if (*at == L'\0') {
      for (size_t i = 0; i < slashes * 2; i++) wbuf_char(line, L'\\');
      break;
    }
    if (*at == L'"') {
      for (size_t i = 0; i < slashes * 2 + 1; i++) wbuf_char(line, L'\\');
    } else {
      for (size_t i = 0; i < slashes; i++) wbuf_char(line, L'\\');
    }
    wbuf_char(line, *at);
  }
  wbuf_char(line, L'"');
}

static int is_file(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static wchar_t *joined(const wchar_t *left, const wchar_t *right) {
  wbuf out = {0};
  wbuf_text(&out, left);
  wbuf_text(&out, right);
  return out.text;
}

/* Ctrl+C belongs to the server in this console; this process only waits for it. */
static BOOL WINAPI on_console_event(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int wmain(int argc, wchar_t **argv) {
  int background_server = argc > 1 && wcscmp(argv[1], L"background-server") == 0;
  int desktop = argc == 1 || (argc > 1 &&
    (wcscmp(argv[1], L"launcher") == 0 || wcscmp(argv[1], L"background-server") == 0));
  /* A GUI entry has no new console. CLI callers keep their inherited pipes,
     or attach to the caller's console when no pipe handles were supplied. */
  if (!desktop && !GetConsoleWindow()) {
    HANDLE saved[] = { GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE) };
    DWORD names[] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
    if (AttachConsole(ATTACH_PARENT_PROCESS)) {
      /* AttachConsole may replace the handles; IDE and shell pipes remain the caller's. */
      for (int i = 0; i < 3; i++) if (saved[i] && saved[i] != INVALID_HANDLE_VALUE)
        SetStdHandle(names[i], saved[i]);
    }
  }
  wchar_t *self = (wchar_t *)malloc(LONG_PATH * sizeof(wchar_t));
  if (!self) die(L"out of memory", NULL);
  DWORD length = GetModuleFileNameW(NULL, self, LONG_PATH);
  if (length == 0 || length >= LONG_PATH) die(L"could not find its own location", NULL);

  wchar_t *directory = _wcsdup(self);
  wchar_t *slash = directory ? wcsrchr(directory, L'\\') : NULL;
  if (!slash) die(L"could not find its own folder", self);
  *slash = L'\0';

  wchar_t *resources = joined(directory, L"\\resources");
  wchar_t *manifest = joined(resources, L"\\" TEXT(SYNABUN_MANIFEST));
  if (!is_file(manifest)) die(L"this copy is incomplete, its application files are missing", manifest);

  wchar_t *runtime = joined(resources, L"\\runtime");
  wchar_t *node = joined(runtime, L"\\node.exe");
  if (!is_file(node)) die(L"this copy is incomplete, its Node runtime is missing", node);

  int mcp = argc > 1 && wcscmp(argv[1], L"mcp") == 0;
  wchar_t *script = joined(resources, mcp ? L"\\app\\mcp-server\\run.mjs" : L"\\bootstrap.mjs");
  if (!is_file(script)) die(L"this copy is incomplete, a file is missing", script);

  SetEnvironmentVariableW(TEXT(SYNABUN_ENTRY_ENV), self);

  /* The bundled node, npm and npx come first for everything started by name. */
  wbuf path = {0};
  wbuf_text(&path, runtime);
  DWORD existing = GetEnvironmentVariableW(L"PATH", NULL, 0);
  if (existing > 1) {
    wchar_t *current = (wchar_t *)malloc(existing * sizeof(wchar_t));
    if (current && GetEnvironmentVariableW(L"PATH", current, existing) > 0) {
      wbuf_char(&path, L';');
      wbuf_text(&path, current);
    }
    free(current);
  }
  SetEnvironmentVariableW(L"PATH", path.text);

  wbuf line = {0};
  append_argument(&line, node);
  append_argument(&line, TEXT(SYNABUN_NODE_FLAG));
  append_argument(&line, script);
  for (int i = mcp ? 2 : 1; i < argc; i++) append_argument(&line, argv[i]);

  /*
   * Whoever ends this process ends the Node behind it: an IDE stops an MCP
   * server by terminating the command it started. A server start lets its own
   * children out of the job, so the browser it opens outlives the console.
   */
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof limits);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      | ((mcp || background_server) ? 0 : JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK);
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
      CloseHandle(job);
      job = NULL;
    }
  }

  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof startup);
  ZeroMemory(&process, sizeof process);
  startup.cb = sizeof startup;
  HANDLE inheritedOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!desktop || (inheritedOutput && inheritedOutput != INVALID_HANDLE_VALUE)) {
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    HANDLE handles[] = { startup.hStdInput, startup.hStdOutput, startup.hStdError };
    for (int i = 0; i < 3; i++) if (handles[i] && handles[i] != INVALID_HANDLE_VALUE)
      SetHandleInformation(handles[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  }

  SetConsoleCtrlHandler(on_console_event, TRUE);
  if (!CreateProcessW(node, line.text, NULL, NULL, TRUE,
      CREATE_SUSPENDED | ((desktop || !GetConsoleWindow()) ? CREATE_NO_WINDOW : 0), NULL, NULL, &startup, &process)) {
    wchar_t code[32];
    swprintf(code, 32, L"error %lu", (unsigned long)GetLastError());
    die(L"could not start the bundled Node runtime", code);
  }
  if (job) AssignProcessToJobObject(job, process.hProcess);
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);

  DWORD status = 1;
  WaitForSingleObject(process.hProcess, INFINITE);
  GetExitCodeProcess(process.hProcess, &status);
  CloseHandle(process.hProcess);
  return (int)status;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
  (void)instance; (void)previous; (void)command; (void)show;
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return 127;
  int result = wmain(argc, argv);
  LocalFree(argv);
  return result;
}

#else

/* ─────────────────────────── macOS and Linux ─────────────────────────── */

#define _XOPEN_SOURCE 700
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#include <mach-o/dyld.h>
#endif
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

static void die(const char *what, const char *detail) {
  fprintf(stderr, "SynaBun: %s%s%s\n", what, detail ? ": " : "", detail ? detail : "");
  exit(127);
}

static char *joined(const char *left, const char *right) {
  size_t size = strlen(left) + strlen(right) + 1;
  char *out = malloc(size);
  if (!out) die("out of memory", NULL);
  snprintf(out, size, "%s%s", left, right);
  return out;
}

static int is_file(const char *path) {
  struct stat info;
  return stat(path, &info) == 0 && S_ISREG(info.st_mode);
}

/* This executable, with every link on the way resolved. */
static char *own_path(void) {
#if defined(__APPLE__)
  char raw[PATH_MAX * 2];
  uint32_t size = sizeof raw;
  if (_NSGetExecutablePath(raw, &size) != 0) return NULL;
  return realpath(raw, NULL);
#else
  return realpath("/proc/self/exe", NULL);
#endif
}

/* Where the application files sit, relative to this executable's folder. */
static const char *const LAYOUTS[] = {
  "/../Resources",    /* SynaBun.app/Contents/MacOS */
  "/usr/lib/synabun", /* AppDir */
  "/resources",       /* next to the executable */
  NULL,
};

static char *find_resources(const char *directory) {
  for (int i = 0; LAYOUTS[i]; i++) {
    char *candidate = joined(directory, LAYOUTS[i]);
    char *manifest = joined(candidate, "/" SYNABUN_MANIFEST);
    char *resolved = is_file(manifest) ? realpath(candidate, NULL) : NULL;
    free(manifest);
    free(candidate);
    if (resolved) return resolved;
  }
  return NULL;
}

/*
 * The path the outside world should run. An AppImage runs from a mount that is
 * gone when it exits, so there the image file itself is the entry; APPIMAGE is
 * trusted only when APPDIR is the folder this executable really is in.
 */
static const char *stable_entry(const char *self, const char *directory) {
#if defined(__linux__)
  const char *image = getenv("APPIMAGE");
  const char *mount = getenv("APPDIR");
  if (image && image[0] == '/' && mount && mount[0]) {
    char *mounted = realpath(mount, NULL);
    int ours = mounted && strcmp(mounted, directory) == 0;
    free(mounted);
    if (ours && is_file(image)) return image;
  }
#else
  (void)directory;
#endif
  return self;
}

int main(int argc, char **argv) {
  char *self = own_path();
  if (!self) die("could not find its own location", strerror(errno));

  char *directory = strdup(self);
  char *slash = directory ? strrchr(directory, '/') : NULL;
  if (!slash) die("could not find its own folder", self);
  *slash = '\0';

  char *resources = find_resources(directory);
  if (!resources) die("this copy is incomplete, its application files are missing", directory);

  char *runtime = joined(resources, "/runtime/bin");
  char *node = joined(runtime, "/node");
  if (access(node, X_OK) != 0) die("this copy is incomplete, its Node runtime is missing", node);

  int mcp = argc > 1 && strcmp(argv[1], "mcp") == 0;
  char *script = joined(resources, mcp ? "/app/mcp-server/run.mjs" : "/bootstrap.mjs");
  if (!is_file(script)) die("this copy is incomplete, a file is missing", script);

  if (setenv(SYNABUN_ENTRY_ENV, stable_entry(self, directory), 1) != 0) die("could not set its environment", strerror(errno));

  /* The bundled node, npm and npx come first for everything started by name. */
  const char *current = getenv("PATH");
  if (!current || !*current) current = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  char *with_colon = joined(runtime, ":");
  char *path = joined(with_colon, current);
  if (setenv("PATH", path, 1) != 0) die("could not set its environment", strerror(errno));

  char **command = calloc((size_t)argc + 4, sizeof *command);
  if (!command) die("out of memory", NULL);
  int count = 0;
  command[count++] = node;
  command[count++] = (char *)SYNABUN_NODE_FLAG;
  command[count++] = script;
  for (int i = mcp ? 2 : 1; i < argc; i++) command[count++] = argv[i];
  command[count] = NULL;

  /* Node takes this process over: same pid, same stdio, same signals. */
  execv(node, command);
  die("could not start the bundled Node runtime", strerror(errno));
  return 127;
}

#endif
