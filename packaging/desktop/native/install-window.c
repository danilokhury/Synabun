/* Native SAC fallback. Win32/GDI only: no CLR, PowerShell, browser or runtime DLLs.
 * Protocol is UTF-16LE native-view.txt, produced atomically by win-swap.mjs.
 * Mascot geometry is the 280x140 two-pill face from pages/splash.html.
 * Colours are compiled from the project's generated Style Guide tokens. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdlib.h>
#include "install-window-tokens.h"

static wchar_t viewPath[32768], shownPath[32768], fields[10][2048];
static HANDLE watchdog;
static BOOL failed, ready, marked;
static ULONGLONG readyAt, started;
static HBRUSH background;
static HFONT font, smallFont, headingFont;
static int percent = -1, tick;

static BOOL readView(void) {
  wchar_t data[16000]; DWORD size;
  HANDLE file = CreateFileW(viewPath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  BOOL ok = ReadFile(file, data, sizeof(data) - sizeof(wchar_t), &size, NULL); CloseHandle(file);
  if (!ok || size % 2) return FALSE;
  data[size / 2] = 0;
  wchar_t *cursor = data;
  for (int i = 0; i < 10; i++) {
    wchar_t *end = wcschr(cursor, L'\n');
    if (!end) return FALSE;
    *end = 0;
    wcsncpy(fields[i], cursor, 2047); fields[i][2047] = 0;
    cursor = end + 1;
  }
  failed = wcscmp(fields[0], L"failed") == 0;
  ready = wcscmp(fields[0], L"ready") == 0;
  percent = fields[1][0] ? _wtoi(fields[1]) : -1;
  if (ready && !readyAt) readyAt = GetTickCount64();
  return TRUE;
}
static void text(HDC dc, int top, int bottom, const wchar_t *value, COLORREF color, HFONT face) {
  RECT area = {24, top, 356, bottom};
  SelectObject(dc, face); SetTextColor(dc, color); SetBkMode(dc, TRANSPARENT);
  DrawTextW(dc, value, -1, &area, DT_CENTER | DT_WORDBREAK | DT_NOPREFIX);
}
static void rect(HDC dc, int x, int y, int width, int height, COLORREF color) {
  RECT r = {x, y, x + width, y + height}; HBRUSH b = CreateSolidBrush(color); FillRect(dc, &r, b); DeleteObject(b);
}
static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  switch (message) {
  case WM_TIMER:
    tick++; readView();
    if (!ready && !failed && ((watchdog && WaitForSingleObject(watchdog, 0) == WAIT_OBJECT_0) || GetTickCount64() - started > 40 * 60 * 1000)) {
      failed = TRUE; wcscpy(fields[0], L"failed");
      wcsncpy(fields[3], fields[7], 2047); fields[3][2047] = 0;
    }
    if (readyAt && GetTickCount64() - readyAt >= 900) DestroyWindow(window);
    else { InvalidateRect(window, NULL, FALSE); }
    return 0;
  case WM_CLOSE:
    // The progress surface stays throughout replacement/restart. On failure it stays until explicitly closed.
    if (failed || ready) DestroyWindow(window);
    return 0;
  case WM_LBUTTONUP:
    if (failed && HIWORD(lp) > 350 && HIWORD(lp) < 398 && fields[5][0])
      ShellExecuteW(window, L"open", fields[5], NULL, NULL, SW_SHOWNORMAL);
    if (failed && HIWORD(lp) >= 400) DestroyWindow(window);
    return 0;
  case WM_PAINT: {
    PAINTSTRUCT ps; HDC screen = BeginPaint(window, &ps);
    HDC dc = CreateCompatibleDC(screen); HBITMAP bitmap = CreateCompatibleBitmap(screen, 380, 448);
    HGDIOBJ previousBitmap = SelectObject(dc, bitmap);
    RECT client = {0, 0, 380, 448}; FillRect(dc, &client, background);
    COLORREF accent = failed ? TOKEN_DANGER : ready ? TOKEN_SUCCESS : TOKEN_ACCENT;
    text(dc, 22, 46, L"SynaBun", TOKEN_TEXT, headingFont);
    HBRUSH eye = CreateSolidBrush(accent); HGDIOBJ oldBrush = SelectObject(dc, eye);
    HGDIOBJ oldPen = SelectObject(dc, GetStockObject(NULL_PEN));
    RoundRect(dc, 158, 77, 179, 116, 21, 21); RoundRect(dc, 202, 77, 222, 116, 21, 21);
    SelectObject(dc, oldBrush); SelectObject(dc, oldPen); DeleteObject(eye);
    HPEN mouth = CreatePen(PS_SOLID, 2, accent); oldPen = SelectObject(dc, mouth);
    POINT points[4] = {{178, 126}, {186, failed ? 121 : 132}, {194, failed ? 121 : 132}, {202, 126}};
    PolyBezier(dc, points, 4); SelectObject(dc, oldPen); DeleteObject(mouth);
    text(dc, 176, 226, fields[2], TOKEN_TEXT, font);
    rect(dc, 36, 240, 308, 4, TOKEN_MUTED);
    int fill = percent >= 0 ? 308 * min(percent, 100) / 100 : 64;
    int left = percent >= 0 ? 36 : 36 + (tick * 8 % 244);
    rect(dc, left, 240, fill, 4, accent);
    if (percent >= 0) { wchar_t number[16]; swprintf(number, 16, L"%d%%", percent); text(dc, 254, 280, number, TOKEN_MUTED, smallFont); }
    if (failed) {
      text(dc, 282, 332, fields[3], TOKEN_DANGER, smallFont);
      text(dc, 330, 352, fields[4], TOKEN_MUTED, smallFont);
      text(dc, 356, 397, fields[5], TOKEN_MUTED, smallFont);
      text(dc, 398, 422, fields[6], TOKEN_TEXT, smallFont);
    }
    BitBlt(screen, 0, 0, 380, 448, dc, 0, 0, SRCCOPY);
    SelectObject(dc, previousBitmap); DeleteObject(bitmap); DeleteDC(dc); EndPaint(window, &ps);
    if (!marked && IsWindowVisible(window)) {
      HANDLE marker = CreateFileW(shownPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, 0, NULL);
      if (marker != INVALID_HANDLE_VALUE) { CloseHandle(marker); marked = TRUE; }
    }
    return 0;
  }
  case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(window, message, wp, lp);
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show) {
  (void)previous; (void)command; (void)show;
  int argc; LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv || argc != 4 || wcslen(argv[1]) > 32000 || wcslen(argv[2]) > 32000) return 2;
  swprintf(viewPath, 32768, L"%ls\\native-view.txt", argv[1]);
  swprintf(shownPath, 32768, L"%ls\\window-shown", argv[2]);
  watchdog = OpenProcess(SYNCHRONIZE, FALSE, wcstoul(argv[3], NULL, 10)); LocalFree(argv);
  if (!readView()) return 3;
  started = GetTickCount64();
  background = CreateSolidBrush(TOKEN_BACKGROUND);
  font = CreateFontW(-TOKEN_BODY_SIZE, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Inter");
  smallFont = CreateFontW(-TOKEN_CAPTION_SIZE, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  headingFont = CreateFontW(-TOKEN_HEADING_SIZE, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Space Grotesk");
  WNDCLASSW cls = {0}; cls.lpfnWndProc = windowProc; cls.hInstance = instance;
  cls.hCursor = LoadCursor(NULL, IDC_ARROW); cls.hbrBackground = background; cls.lpszClassName = L"SynaBunInstallWindow";
  if (!RegisterClassW(&cls)) return 4;
  RECT r = {0, 0, 380, 448}; AdjustWindowRect(&r, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE);
  HWND window = CreateWindowExW(WS_EX_APPWINDOW, cls.lpszClassName, L"SynaBun", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
    (GetSystemMetrics(SM_CXSCREEN) - (r.right - r.left)) / 2, (GetSystemMetrics(SM_CYSCREEN) - (r.bottom - r.top)) / 2,
    r.right - r.left, r.bottom - r.top, NULL, NULL, instance, NULL);
  if (!window) return 5;
  ShowWindow(window, SW_SHOW); ShowWindow(window, SW_SHOWNORMAL); UpdateWindow(window); SetTimer(window, 1, 250, NULL);
  MSG msg; while (GetMessageW(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  if (watchdog) CloseHandle(watchdog); DeleteObject(font); DeleteObject(smallFont); DeleteObject(headingFont); DeleteObject(background);
  return 0;
}
