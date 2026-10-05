// SynaBun desktop helper — the native macOS backend of the Assistant's computer use.
//
// One long-lived process, spawned by lib/desktop/manager.js and compiled on the
// user's machine by lib/desktop/build.js:
//   xcrun swiftc -O -swift-version 5 -target <arch>-apple-macos14.0 -o <bin> SynabunDesktop.swift
//
// Protocol: JSON lines over stdio (UTF-8, one object per line). stdout carries
// nothing else — diagnostics go to stderr or to `log` events.
//   request  {"id":17,"cmd":"click","args":{...}}
//   reply    {"id":17,"ok":true,"result":{...}}
//            {"id":17,"ok":false,"error":{"code":"SECURE_FIELD","message":"...","details":{...}}}
//   event    {"event":"ready"|"user_input"|"emergency_stop"|"screen_lock"|
//                     "displays_changed"|"permissions_changed"|"log", ...}   (no id)
//
// Actions run strictly serially in arrival order on one queue. abort, panic,
// permissions, session_state, cursor and shutdown bypass that queue and are
// answered from the stdin thread immediately.
//
// Coordinates: every point received or returned is a Quartz GLOBAL DISPLAY POINT
// (origin at the top-left of the main display, y grows down; secondary displays
// may have negative origins). Screenshot pixel space never enters this process
// except for the fitted image it produces.
//
// Safety model (the helper is the last line of defence, so it re-checks
// everything right before posting events):
//   - no Accessibility → NOT_TRUSTED for input/AX; no Screen Recording →
//     NO_SCREEN_RECORDING for capture. Nothing here ever prompts except
//     `request_permission`, and nothing is posted without the post-event grant.
//   - refuseWhenLocked: a locked (or off-console) session refuses every action.
//   - blocked apps / protected windows are evaluated on the probed target
//     (pointer actions) or the focused element + frontmost window (keyboard).
//     Rules match bundle ids, bundle-id prefixes (web apps), app names and
//     window titles; names and titles are NFC-normalized first, so a title in
//     decomposed form still matches a localized pattern.
//   - ax_action press may carry `verify` (protocol 2): the element is re-read
//     right before AXPerformAction and nothing is pressed (TARGET_CHANGED) unless
//     it is still the same, enabled, pressable control in the app's frontmost,
//     focused, sheet-free window.
//   - typing / printable keys / paste / AX set_value never target an
//     AXSecureTextField, and fail closed when focus is unreadable while secure
//     event input is on. The value of a secure field is never read.
//   - every synthetic event carries kCGEventSourceUserData = "SYNB" so the
//     global monitor can tell the user's input from ours. While the monitor is
//     armed, an unstamped Escape or a flick into the top-left corner of the main
//     display emits `emergency_stop`, aborts the in-flight action, releases held
//     input and LATCHES: input/AX/app actions then fail with INTERRUPTED
//     (details.latched) until the next `configure`.
//
// Lifetime: exits (after releasing anything it holds) on `shutdown`, stdin EOF,
// SIGTERM/SIGHUP, or when its parent dies (getppid() == 1, polled every 2 s).
//
// Flags: --version prints {"version","protocol"}; --self-test runs the pure
// checks (key combos, fit math, scroll signs, text chunking, guard matching,
// JSON round-trip) with no screen access and exits 0/1.

import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import IOKit.pwr_mgt
import ScreenCaptureKit

// MARK: - Constants

let HELPER_VERSION = "1.1.0"
let PROTOCOL_VERSION = 2
/// "SYNB" — stamped into kCGEventSourceUserData of every event this process posts.
let SYNB_STAMP: Int64 = 0x53594E42

#if arch(arm64)
let HELPER_ARCH = "arm64"
#elseif arch(x86_64)
let HELPER_ARCH = "x64"
#else
let HELPER_ARCH = "unknown"
#endif

// MARK: - Errors

struct HelperError: Error {
    let code: String
    let message: String
    let details: [String: Any]?
    init(_ code: String, _ message: String, _ details: [String: Any]? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
    func adding(_ extra: [String: Any]) -> HelperError {
        var d = details ?? [:]
        for (k, v) in extra { d[k] = v }
        return HelperError(code, message, d)
    }
}

// MARK: - JSON output

/// Anything → a JSONSerialization-safe value (optionals unwrapped, NaN/Inf → null,
/// CG geometry flattened). JSONSerialization raises an uncatchable ObjC exception
/// on invalid input, so every outgoing object goes through here.
func jsonSafe(_ value: Any?) -> Any {
    guard let value = value else { return NSNull() }
    let mirror = Mirror(reflecting: value)
    if mirror.displayStyle == .optional {
        guard let inner = mirror.children.first?.value else { return NSNull() }
        return jsonSafe(inner)
    }
    switch value {
    case is NSNull: return value
    case let s as String: return s
    case let n as NSNumber: return n.doubleValue.isFinite ? n : NSNull()
    case let d as [String: Any]: return d.mapValues { jsonSafe($0) }
    case let a as [Any]: return a.map { jsonSafe($0) }
    case let p as CGPoint: return pointJSON(p)
    case let r as CGRect: return rectJSON(r)
    default: return String(describing: value)
    }
}

func encodeJSON(_ obj: [String: Any]) -> Data? {
    let safe = jsonSafe(obj)
    guard JSONSerialization.isValidJSONObject(safe) else { return nil }
    return try? JSONSerialization.data(withJSONObject: safe, options: [.withoutEscapingSlashes])
}

func stderrLine(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}

enum Out {
    private static let lock = NSLock()
    private static var broken = false

    /// One JSON object per line, written with write(2) under a lock so replies
    /// from the stdin thread, the action queue and the main thread never interleave.
    static func send(_ obj: [String: Any]) {
        guard var data = encodeJSON(obj) else {
            stderrLine("synabun-desktop: dropped an unserializable message")
            return
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        if broken { return }
        let ok = data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard var p = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let n = Darwin.write(STDOUT_FILENO, p, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                p = p.advanced(by: n)
                left -= n
            }
            return true
        }
        if !ok {
            broken = true
            DispatchQueue.global().async { Lifecycle.exit(reason: "stdout closed") }
        }
    }
}

func emitEvent(_ name: String, _ fields: [String: Any] = [:]) {
    var obj = fields
    obj["event"] = name
    Out.send(obj)
}

func hlog(_ level: String, _ message: String) {
    emitEvent("log", ["level": level, "message": message])
}

func reply(_ id: Any?, result: Any) {
    Out.send(["id": id ?? NSNull(), "ok": true, "result": result])
}

func replyError(_ id: Any?, _ e: HelperError) {
    var err: [String: Any] = ["code": e.code, "message": e.message]
    if let d = e.details { err["details"] = d }
    Out.send(["id": id ?? NSNull(), "ok": false, "error": err])
}

// MARK: - Small utilities

func rectJSON(_ r: CGRect) -> [String: Any] {
    ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.size.width), "h": Double(r.size.height)]
}

func pointJSON(_ p: CGPoint) -> [String: Any] { ["x": Double(p.x), "y": Double(p.y)] }

func nowNs() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

func epochMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

func sleepMs(_ ms: Double) {
    guard ms > 0 else { return }
    usleep(useconds_t(min(ms, 60_000) * 1000))
}

func clampInt(_ v: Int, _ lo: Int, _ hi: Int) -> Int { max(lo, min(hi, v)) }

func clampDouble(_ v: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, v)) }

/// JSON number → Int without trapping on absurd values (Int(Double) traps out of range).
func toInt(_ d: Double) -> Int { d.isFinite ? Int(clampDouble(d.rounded(), -1e15, 1e15)) : 0 }

/// AppKit and the Text Input Sources API want the main thread (TSM asserts on it
/// since macOS 14). The main thread only runs the run loop, so a sync hop is safe
/// from the stdin thread and the action queue.
func onMain<T>(_ body: () throws -> T) rethrows -> T {
    if Thread.isMainThread { return try body() }
    return try DispatchQueue.main.sync(execute: body)
}

final class Box<T> {
    var value: T?
    var error: Error?
}

/// Bridges a completion-handler API to the calling (non-main) thread.
func waitFor<T>(_ what: String, timeout: Double, _ start: (@escaping (T?, Error?) -> Void) -> Void) throws -> T {
    let box = Box<T>()
    let sem = DispatchSemaphore(value: 0)
    start { value, error in
        box.value = value
        box.error = error
        sem.signal()
    }
    if sem.wait(timeout: .now() + timeout) == .timedOut {
        throw HelperError("TIMEOUT", "\(what) did not answer within \(Int(timeout)) s")
    }
    if let e = box.error { throw e }
    guard let v = box.value else { throw HelperError("INTERNAL", "\(what) returned nothing") }
    return v
}

func trimmed(_ s: String?, _ limit: Int) -> String? {
    guard let s = s else { return nil }
    return s.count > limit ? String(s.prefix(limit)) : s
}

// MARK: - Arguments

struct Args {
    let raw: [String: Any]
    init(_ raw: [String: Any]) { self.raw = raw }

    static func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n as CFTypeRef) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
    static func bool(_ v: Any?) -> Bool? { (v as? NSNumber)?.boolValue }

    func has(_ k: String) -> Bool { raw[k] != nil && !(raw[k] is NSNull) }
    func num(_ k: String) -> Double? { Args.num(raw[k]) }
    func int(_ k: String) -> Int? { num(k).map(toInt) }
    func string(_ k: String) -> String? { raw[k] as? String }
    func bool(_ k: String) -> Bool? { Args.bool(raw[k]) }
    func dict(_ k: String) -> [String: Any]? { raw[k] as? [String: Any] }
    func array(_ k: String) -> [Any]? { raw[k] as? [Any] }

    static func point(_ d: [String: Any]?, _ name: String) throws -> CGPoint {
        guard let d = d, let x = num(d["x"]), let y = num(d["y"]) else {
            throw HelperError("BAD_ARGS", "\(name) needs numeric x and y (global display points)")
        }
        return CGPoint(x: x, y: y)
    }
    func point() throws -> CGPoint { try Args.point(raw, "this command") }

    static func rect(_ d: [String: Any]?, _ name: String) throws -> CGRect {
        guard let d = d, let x = num(d["x"]), let y = num(d["y"]), let w = num(d["w"]), let h = num(d["h"]), w > 0, h > 0 else {
            throw HelperError("BAD_ARGS", "\(name) needs numeric x, y and positive w, h")
        }
        return CGRect(x: x, y: y, width: w, height: h)
    }
}

// MARK: - Pure logic (covered by --self-test)

struct FitResult {
    let w: Int
    let h: Int
    let factor: Double
}

/// Output size for a W×H point area on a display with backing scale s, fitted
/// into fit.w × fit.h: f = min(fit.w/W, fit.h/H, s); image = round(W·f) × round(H·f).
/// Never upscales past native pixels.
func fitSize(width W: Double, height H: Double, fitW: Double, fitH: Double, scale s: Double) -> FitResult {
    guard W > 0, H > 0 else { return FitResult(w: 0, h: 0, factor: 0) }
    let fw = fitW > 0 ? fitW : W * s
    let fh = fitH > 0 ? fitH : H * s
    let f = max(1e-6, min(fw / W, fh / H, s > 0 ? s : 1))
    return FitResult(w: max(1, Int((W * f).rounded())), h: max(1, Int((H * f).rounded())), factor: f)
}

/// Protocol: dy > 0 scrolls DOWN (toward the end of the document), dx > 0 scrolls
/// RIGHT. Quartz scroll-wheel events are the other way round: wheel1 (vertical)
/// is positive for UP and wheel2 (horizontal) is positive for LEFT. So both signs
/// flip. Synthetic deltas are not affected by the "natural scrolling" setting.
func scrollWheelDeltas(dx: Int, dy: Int) -> (wheel1: Int32, wheel2: Int32) {
    (Int32(clamping: -clampInt(dy, -1_000_000, 1_000_000)), Int32(clamping: -clampInt(dx, -1_000_000, 1_000_000)))
}

enum Mod: String, CaseIterable {
    case ctrl, alt, shift, cmd, fn

    var flag: CGEventFlags {
        switch self {
        case .cmd: return .maskCommand
        case .shift: return .maskShift
        case .alt: return .maskAlternate
        case .ctrl: return .maskControl
        case .fn: return .maskSecondaryFn
        }
    }
    /// kVK_Command, kVK_Shift, kVK_Option, kVK_Control, kVK_Function
    var keyCode: CGKeyCode {
        switch self {
        case .cmd: return 0x37
        case .shift: return 0x38
        case .alt: return 0x3A
        case .ctrl: return 0x3B
        case .fn: return 0x3F
        }
    }
    /// Right-hand twins released by `panic` (kVK_RightCommand/Shift/Option/Control).
    var rightKeyCode: CGKeyCode? {
        switch self {
        case .cmd: return 0x36
        case .shift: return 0x3C
        case .alt: return 0x3D
        case .ctrl: return 0x3E
        case .fn: return nil
        }
    }
    static func parse(_ s: String) -> Mod? {
        switch s.lowercased() {
        case "cmd", "command", "super": return .cmd
        case "shift": return .shift
        case "alt", "option", "opt": return .alt
        case "ctrl", "control": return .ctrl
        case "fn", "function": return .fn
        default: return nil
        }
    }
}

/// xdotool-style key names → kVK_* virtual key codes (layout independent keys).
let NAMED_KEYS: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24, "kp_enter": 0x4C, "tab": 0x30, "escape": 0x35, "esc": 0x35,
    "backspace": 0x33, "delete": 0x75, "forwarddelete": 0x75,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77, "page_up": 0x74, "pageup": 0x74, "prior": 0x74,
    "page_down": 0x79, "pagedown": 0x79, "next": 0x79, "help": 0x72, "insert": 0x72,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62,
    "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F, "f13": 0x69, "f14": 0x6B,
    "f15": 0x71, "f16": 0x6A, "f17": 0x40, "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
]

/// xdotool keysym names that stand for a character.
let KEYSYM_CHARS: [String: Character] = [
    "space": " ", "minus": "-", "equal": "=", "plus": "+", "underscore": "_", "comma": ",",
    "period": ".", "slash": "/", "backslash": "\\", "semicolon": ";", "colon": ":",
    "apostrophe": "'", "quoteright": "'", "quotedbl": "\"", "grave": "`", "quoteleft": "`",
    "asciitilde": "~", "bracketleft": "[", "bracketright": "]", "braceleft": "{", "braceright": "}",
    "parenleft": "(", "parenright": ")", "less": "<", "greater": ">", "question": "?",
    "exclam": "!", "at": "@", "numbersign": "#", "dollar": "$", "percent": "%",
    "asciicircum": "^", "ampersand": "&", "asterisk": "*", "bar": "|",
]

/// US ANSI positions — the fallback when the current layout can't produce a character
/// (shortcuts on non-Latin layouts resolve through the ANSI position, like macOS does).
let ANSI_KEYS: [Character: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
    "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
    "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
    "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32, " ": 0x31,
]
let ANSI_SHIFTED: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9",
    ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",",
    ">": ".", "?": "/", "~": "`",
]

/// Character → (virtual key, UCKeyTranslate modifier state: 0 none, 2 shift, 8 option, 10 both).
typealias LayoutMap = [String: (code: CGKeyCode, state: UInt32)]

struct ResolvedChar {
    let code: CGKeyCode
    let shift: Bool
    let alt: Bool
}

func resolveChar(_ ch: Character, layout: LayoutMap?, ansiFallback: Bool) -> ResolvedChar? {
    let s = String(ch)
    if let layout = layout {
        if let m = layout[s] { return ResolvedChar(code: m.code, shift: m.state & 2 != 0, alt: m.state & 8 != 0) }
        let lower = s.lowercased()
        if lower != s, let m = layout[lower], m.state == 0 { return ResolvedChar(code: m.code, shift: true, alt: false) }
    }
    guard ansiFallback || layout == nil || layout!.isEmpty else { return nil }
    let lower = s.lowercased()
    if lower.count == 1, let c = ANSI_KEYS[Character(lower)] { return ResolvedChar(code: c, shift: lower != s, alt: false) }
    if let base = ANSI_SHIFTED[ch], let c = ANSI_KEYS[base] { return ResolvedChar(code: c, shift: true, alt: false) }
    return nil
}

struct KeyCombo {
    var mods: [Mod] = []
    var keyCode: CGKeyCode? = nil
    var keyName = ""
    /// The key produces a character (letters, digits, punctuation, space).
    var isCharKey = false

    var flags: CGEventFlags { mods.reduce(CGEventFlags()) { $0.union($1.flag) } }
    /// Printable input (no modifiers other than shift/option) or a paste (cmd+v):
    /// these must never land in a secure field.
    var needsSecureCheck: Bool {
        guard keyCode != nil else { return false }
        if isCharKey && mods.allSatisfy({ $0 == .shift || $0 == .alt }) { return true }
        if keyName == "v" && mods.contains(.cmd) { return true }
        return false
    }
}

/// "cmd+shift+t", "Return", "ctrl+alt+Delete", "cmd++", "shift" (modifier only).
/// An uppercase single letter implies shift ("cmd+T" == "cmd+shift+t").
func parseCombo(_ raw: String, layout: LayoutMap?) throws -> KeyCombo {
    let s = raw.trimmingCharacters(in: .whitespaces)
    guard !s.isEmpty else { throw HelperError("BAD_ARGS", "empty key combo") }
    var tokens: [String]
    if s == "+" {
        tokens = ["+"]
    } else if s.hasSuffix("++") {
        tokens = s.dropLast(2).split(separator: "+", omittingEmptySubsequences: false).map(String.init) + ["+"]
    } else {
        tokens = s.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    }
    tokens = tokens.map { $0.trimmingCharacters(in: .whitespaces) }
    if tokens.contains(where: { $0.isEmpty }) { throw HelperError("BAD_ARGS", "malformed key combo '\(raw)'") }
    var combo = KeyCombo()
    for (i, token) in tokens.enumerated() {
        let last = i == tokens.count - 1
        if let m = Mod.parse(token) {
            if !combo.mods.contains(m) { combo.mods.append(m) }
            continue
        }
        guard last else { throw HelperError("BAD_ARGS", "unknown modifier '\(token)' in '\(raw)'") }
        let lower = token.lowercased()
        if let code = NAMED_KEYS[lower] {
            combo.keyCode = code
            combo.keyName = lower
            continue
        }
        var ch: Character? = nil
        if let c = KEYSYM_CHARS[lower] { ch = c } else if token.count == 1 { ch = token.first }
        guard let c = ch else { throw HelperError("BAD_ARGS", "unknown key '\(token)' in '\(raw)'") }
        guard let r = resolveChar(c, layout: layout, ansiFallback: true) else {
            throw HelperError("BAD_ARGS", "no key produces '\(c)' on the current keyboard layout")
        }
        combo.keyCode = r.code
        combo.isCharKey = true
        combo.keyName = String(c).lowercased()
        if r.shift && !combo.mods.contains(.shift) { combo.mods.append(.shift) }
        if r.alt && !combo.mods.contains(.alt) { combo.mods.append(.alt) }
    }
    return combo
}

enum TypeSegment {
    case text(String)
    case key(CGKeyCode, String)

    var utf16Count: Int {
        switch self {
        case .text(let s): return s.utf16.count
        case .key(_, let s): return s.utf16.count
        }
    }
}

/// Newlines become Return and tabs become Tab key presses; everything else is
/// grouped into chunks of at most `chunk` (≤ 20) UTF-16 units without splitting a
/// grapheme cluster.
func segmentText(_ text: String, chunk: Int) -> [TypeSegment] {
    let limit = clampInt(chunk, 1, 20)
    var out: [TypeSegment] = []
    var buf = ""
    var units = 0
    func flush() {
        if !buf.isEmpty { out.append(.text(buf)) }
        buf = ""
        units = 0
    }
    for ch in text {
        if ch == "\n" || ch == "\r\n" || ch == "\r" {
            flush()
            out.append(.key(0x24, String(ch)))
            continue
        }
        if ch == "\t" {
            flush()
            out.append(.key(0x30, "\t"))
            continue
        }
        let n = String(ch).utf16.count
        if units + n > limit { flush() }
        buf.append(ch)
        units += n
    }
    flush()
    return out
}

// MARK: - Configuration

struct BlockRule {
    let id: String
    let bundleIds: [String]
    /// Dotted bundle-id prefixes ending in "." (e.g. "com.apple.Safari.WebApp.").
    var bundlePrefixes: [String] = []
    let nameRe: NSRegularExpression?
    let windowTitleRe: NSRegularExpression?
    let reason: String
}

struct ProtectRule {
    let index: Int
    var id: String? = nil
    let bundleIds: [String]
    var bundlePrefixes: [String] = []
    /// At least one of titleRe / appNameRe is set (parseGuard refuses neither).
    let titleRe: NSRegularExpression?
    var appNameRe: NSRegularExpression? = nil
    let reason: String
}

struct GuardConfig {
    var blocked: [BlockRule] = []
    var protectedWindows: [ProtectRule] = []
    var secureField = true
    var refuseWhenLocked = true
}

struct MonitorConfig {
    var armed = false
    var esc = true
    var failsafeCorner = true
    var cornerSizePt = 4.0
}

struct InputConfig {
    var typeChunk = 20
    var typeDelayMs = 10.0
    var moveSteps = 8
}

enum Config {
    private static let lock = NSLock()
    private static var _guard = GuardConfig()
    private static var _monitor = MonitorConfig()
    private static var _input = InputConfig()

    static var guardCfg: GuardConfig { lock.lock(); defer { lock.unlock() }; return _guard }
    static var monitor: MonitorConfig { lock.lock(); defer { lock.unlock() }; return _monitor }
    static var input: InputConfig { lock.lock(); defer { lock.unlock() }; return _input }

    static func commit(_ g: GuardConfig, _ m: MonitorConfig, _ i: InputConfig) {
        lock.lock()
        _guard = g
        _monitor = m
        _input = i
        lock.unlock()
    }
}

/// Titles, app names and patterns are compared in NFC: System Settings and web
/// pages may hand over "Segurança" decomposed (c + U+0327), which ICU would not
/// match against the precomposed pattern.
func nfc(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }

/// Guard patterns are compiled case-insensitively (ICU syntax — plain JS-style
/// alternations and classes behave the same). An empty pattern means "absent".
func compileRegex(_ pattern: Any?, field: String) throws -> NSRegularExpression? {
    guard let p = pattern as? String, !p.isEmpty else { return nil }
    do {
        return try NSRegularExpression(pattern: nfc(p), options: [.caseInsensitive])
    } catch {
        throw HelperError("BAD_ARGS", "\(field) is not a valid regular expression", ["field": field, "pattern": p])
    }
}

func reMatch(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, options: [], range: NSRange(s.startIndex..<s.endIndex, in: s)) != nil
}

/// Same rule as protocol.js BUNDLE_PREFIX_RE: dotted reverse-DNS, at least two
/// segments, trailing dot — so a prefix can never equal a bare bundle id.
let BUNDLE_PREFIX_PATTERN = "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+\\.$"

func parsePrefixes(_ v: Any?, field: String) throws -> [String] {
    guard let v = v, !(v is NSNull) else { return [] }
    guard let arr = v as? [Any] else { throw HelperError("BAD_ARGS", "\(field) must be an array", ["field": field]) }
    return try arr.enumerated().map { (i, item) -> String in
        guard let s = item as? String, s.range(of: BUNDLE_PREFIX_PATTERN, options: .regularExpression) != nil else {
            throw HelperError("BAD_ARGS", "\(field)[\(i)] must be a dotted bundle id prefix ending in \".\"", ["field": "\(field)[\(i)]"])
        }
        return s
    }
}

func hasBundlePrefix(_ bundleId: String, _ prefixes: [String]) -> Bool {
    let b = bundleId.lowercased()
    return prefixes.contains { !$0.isEmpty && b.hasPrefix($0.lowercased()) }
}

func parseGuard(_ d: [String: Any], into g: inout GuardConfig) throws {
    if let arr = d["blockedApps"] as? [Any] {
        g.blocked = try arr.enumerated().map { (i, item) -> BlockRule in
            let field = "guard.blockedApps[\(i)]"
            guard let r = item as? [String: Any] else { throw HelperError("BAD_ARGS", "\(field) must be an object") }
            return BlockRule(
                id: (r["id"] as? String) ?? "rule\(i)",
                bundleIds: (r["bundleIds"] as? [Any])?.compactMap { $0 as? String } ?? [],
                bundlePrefixes: try parsePrefixes(r["bundlePrefixes"], field: "\(field).bundlePrefixes"),
                nameRe: try compileRegex(r["nameRe"], field: "\(field).nameRe"),
                windowTitleRe: try compileRegex(r["windowTitleRe"], field: "\(field).windowTitleRe"),
                reason: (r["reason"] as? String) ?? "")
        }
    } else if d["blockedApps"] != nil && !(d["blockedApps"] is NSNull) {
        throw HelperError("BAD_ARGS", "guard.blockedApps must be an array")
    }
    if let arr = d["protectedWindows"] as? [Any] {
        g.protectedWindows = try arr.enumerated().map { (i, item) -> ProtectRule in
            let field = "guard.protectedWindows[\(i)]"
            guard let r = item as? [String: Any] else { throw HelperError("BAD_ARGS", "\(field) must be an object") }
            let titleRe = try compileRegex(r["titleRe"], field: "\(field).titleRe")
            let appNameRe = try compileRegex(r["appNameRe"], field: "\(field).appNameRe")
            guard titleRe != nil || appNameRe != nil else {
                throw HelperError("BAD_ARGS", "\(field).titleRe (or appNameRe) is required")
            }
            return ProtectRule(
                index: i,
                id: r["id"] as? String,
                bundleIds: (r["bundleIds"] as? [Any])?.compactMap { $0 as? String } ?? [],
                bundlePrefixes: try parsePrefixes(r["bundlePrefixes"], field: "\(field).bundlePrefixes"),
                titleRe: titleRe,
                appNameRe: appNameRe,
                reason: (r["reason"] as? String) ?? "")
        }
    } else if d["protectedWindows"] != nil && !(d["protectedWindows"] is NSNull) {
        throw HelperError("BAD_ARGS", "guard.protectedWindows must be an array")
    }
    if let b = Args.bool(d["secureField"]) { g.secureField = b }
    if let b = Args.bool(d["refuseWhenLocked"]) { g.refuseWhenLocked = b }
}

// MARK: - Probe (what an action would hit)

struct Probe {
    var pid: Int? = nil
    var bundleId: String? = nil
    var app: String? = nil
    var windowId: Int? = nil
    var windowTitle: String? = nil
    var role: String? = nil
    var subrole: String? = nil
    var title: String? = nil
    var desc: String? = nil
    var valuePreview: String? = nil
    var secure = false
    var enabled: Bool? = nil
    var frame: CGRect? = nil
    /// false when the element's attributes could not be read (hung app, no element).
    var readable = true
    var axError: AXError = .success

    var json: [String: Any] {
        [
            "pid": pid as Any, "bundleId": bundleId as Any, "app": app as Any,
            "windowId": windowId as Any, "windowTitle": windowTitle as Any,
            "role": role as Any, "subrole": subrole as Any, "title": title as Any,
            "description": desc as Any, "valuePreview": (secure ? nil : valuePreview) as Any,
            "secure": secure, "enabled": enabled as Any, "frame": frame.map { rectJSON($0) } as Any,
        ]
    }
}

func sameId(_ a: String, _ b: String) -> Bool { a.caseInsensitiveCompare(b) == .orderedSame }

/// Blocked app: bundle id listed, OR bundle id starts with a listed prefix, OR
/// app name matches nameRe, OR window title matches windowTitleRe. Protected
/// window: the app is in scope — bundle id listed or prefixed; no ids and no
/// prefixes means any app — AND (window title matches titleRe OR app name
/// matches appNameRe). Names and titles are NFC-normalized first; unknown titles
/// and names never match. Same semantics as protocol.js matchGuard.
func matchGuard(_ p: Probe, _ g: GuardConfig, context: String) -> HelperError? {
    let appName = p.app.map(nfc)
    let title = p.windowTitle.map(nfc)
    for r in g.blocked {
        var why: String? = nil
        if let b = p.bundleId, r.bundleIds.contains(where: { sameId($0, b) }) {
            why = "bundleId"
        } else if let b = p.bundleId, hasBundlePrefix(b, r.bundlePrefixes) {
            why = "bundlePrefix"
        } else if let re = r.nameRe, let n = appName, reMatch(re, n) {
            why = "name"
        } else if let re = r.windowTitleRe, let t = title, reMatch(re, t) {
            why = "windowTitle"
        }
        if let why = why {
            let who = p.app ?? p.bundleId ?? "this app"
            return HelperError("BLOCKED_APP", "\(who) is blocked for computer use\(r.reason.isEmpty ? "" : " (\(r.reason))")",
                               ["probe": p.json, "rule": ["id": r.id, "reason": r.reason, "matched": why], "context": context])
        }
    }
    for r in g.protectedWindows {
        let scoped = !r.bundleIds.isEmpty || !r.bundlePrefixes.isEmpty
        let appOk = !scoped || (p.bundleId.map { b in r.bundleIds.contains(where: { sameId($0, b) }) || hasBundlePrefix(b, r.bundlePrefixes) } ?? false)
        guard appOk else { continue }
        var why: String? = nil
        if let re = r.titleRe, let t = title, reMatch(re, t) {
            why = "title"
        } else if let re = r.appNameRe, let n = appName, reMatch(re, n) {
            why = "appName"
        }
        if let why = why {
            let what = why == "title" ? "the window \"\(p.windowTitle ?? "")\"" : "\(p.app ?? "this app") (every window)"
            return HelperError("PROTECTED_WINDOW", "\(what) is protected\(r.reason.isEmpty ? "" : " (\(r.reason))")",
                               ["probe": p.json, "rule": ["index": r.index, "id": r.id as Any, "reason": r.reason, "matched": why], "context": context])
        }
    }
    return nil
}

// MARK: - Displays

enum Displays {
    static func ids() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var list = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &list, &count) == .success else { return [] }
        return Array(list.prefix(Int(count)))
    }

    static func scale(_ id: CGDirectDisplayID) -> Double {
        guard let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 else { return 1 }
        return Double(mode.pixelWidth) / Double(mode.width)
    }

    static func pixelSize(_ id: CGDirectDisplayID) -> (w: Int, h: Int) {
        let b = CGDisplayBounds(id)
        guard let mode = CGDisplayCopyDisplayMode(id) else { return (Int(b.width), Int(b.height)) }
        return (mode.pixelWidth, mode.pixelHeight)
    }

    static func names() -> [CGDirectDisplayID: String] {
        onMain {
            var out: [CGDirectDisplayID: String] = [:]
            for screen in NSScreen.screens {
                if let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                    out[n.uint32Value] = screen.localizedName
                }
            }
            return out
        }
    }

    /// Main display first, then left-to-right / top-to-bottom. Mirrors are skipped.
    static func list() -> [[String: Any]] {
        let names = names()
        let all = ids().filter { CGDisplayMirrorsDisplay($0) == 0 }
        let sorted = all.sorted { a, b in
            let am = CGDisplayIsMain(a) != 0, bm = CGDisplayIsMain(b) != 0
            if am != bm { return am }
            let ra = CGDisplayBounds(a), rb = CGDisplayBounds(b)
            return ra.minX != rb.minX ? ra.minX < rb.minX : ra.minY < rb.minY
        }
        return sorted.enumerated().map { (i, id) -> [String: Any] in
            let px = pixelSize(id)
            return [
                "id": Int(id), "index": i, "main": CGDisplayIsMain(id) != 0,
                "bounds": rectJSON(CGDisplayBounds(id)), "pixel": ["w": px.w, "h": px.h],
                "scale": scale(id), "asleep": CGDisplayIsAsleep(id) != 0, "name": names[id] as Any,
            ]
        }
    }

    static func containing(_ p: CGPoint) -> CGDirectDisplayID? {
        var id: CGDirectDisplayID = 0
        var count: UInt32 = 0
        guard CGGetDisplaysWithPoint(p, 1, &id, &count) == .success, count > 0 else { return nil }
        return id
    }
}

// MARK: - Windows (CGWindowList — titles need Screen Recording; never prompts)

struct WinInfo {
    let windowId: Int
    let pid: Int
    let owner: String?
    let title: String?
    let bounds: CGRect
    let layer: Int
    let onScreen: Bool
    let alpha: Double
}

enum Windows {
    static func parse(_ raw: [[String: Any]]) -> [WinInfo] {
        raw.compactMap { d in
            guard let num = (d[kCGWindowNumber as String] as? NSNumber)?.intValue,
                  let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.intValue else { return nil }
            var rect = CGRect.zero
            if let bd = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: bd as CFDictionary) {
                rect = r
            }
            let title = d[kCGWindowName as String] as? String
            return WinInfo(
                windowId: num, pid: pid, owner: d[kCGWindowOwnerName as String] as? String,
                title: (title?.isEmpty ?? true) ? nil : title, bounds: rect,
                layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
        }
    }

    static func list(onScreenOnly: Bool) -> [WinInfo] {
        let opts: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(opts, 0) as? [[String: Any]] else { return [] }
        return parse(raw)
    }

    static func info(_ windowId: Int) -> WinInfo? {
        guard windowId > 0, windowId <= Int(UInt32.max),
              let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId)) as? [[String: Any]] else { return nil }
        return parse(raw).first { $0.windowId == windowId }
    }

    /// Front-most visible window under a point (optionally owned by pid).
    static func at(_ p: CGPoint, pid: Int? = nil) -> WinInfo? {
        list(onScreenOnly: true).first { w in
            w.alpha > 0 && w.owner != "Window Server" && w.bounds.contains(p) && (pid == nil || w.pid == pid!)
        }
    }
}

func appInfo(_ pid: pid_t) -> (bundleId: String?, name: String?) {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return (nil, nil) }
    return (app.bundleIdentifier, app.localizedName)
}

func frontmostJSON() -> Any {
    guard let app = NSWorkspace.shared.frontmostApplication else { return NSNull() }
    return ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier as Any, "name": app.localizedName as Any]
}

// MARK: - Session, permissions, responsible app

func sessionInfo() -> (locked: Bool, onConsole: Bool) {
    // No dictionary → not inside a GUI login session: treat as off-console (fail closed).
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return (false, false) }
    let locked = (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    let onConsole = (d[kCGSessionOnConsoleKey] as? NSNumber)?.boolValue ?? true
    return (locked, onConsole)
}

func permissionFlags() -> [String: Bool] {
    [
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "accessibility": AXIsProcessTrusted(),
        "postEvents": CGPreflightPostEventAccess(),
        "inputMonitoring": CGPreflightListenEventAccess(),
    ]
}

func permissionsJSON() -> [String: Any] {
    var out: [String: Any] = permissionFlags()
    out["responsibleApp"] = ResponsibleApp.info ?? NSNull()
    return out
}

enum ResponsibleApp {
    /// The app macOS attributes our TCC permissions to: the nearest ancestor process
    /// whose executable lives inside a .app bundle (outermost bundle of its path).
    static let info: [String: Any]? = compute()

    static func parentPid(_ pid: pid_t) -> pid_t? {
        var kinfo = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, UInt32(mib.count), &kinfo, &size, nil, 0) == 0, size > 0 else { return nil }
        return kinfo.kp_eproc.e_ppid
    }

    static func path(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        return String(cString: buf)
    }

    static func compute() -> [String: Any]? {
        var pid = getppid()
        var hops = 0
        while pid > 1 && hops < 64 {
            if let p = path(pid), let r = p.range(of: ".app/") {
                let bundlePath = String(p[..<r.lowerBound]) + ".app"
                let bundle = Bundle(path: bundlePath)
                let bid = bundle?.bundleIdentifier
                let name = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? URL(fileURLWithPath: bundlePath).deletingPathExtension().lastPathComponent
                var rpid = Int(pid)
                if let bid = bid {
                    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bid)
                    if let app = running.first(where: { $0.bundleURL?.path == bundlePath }) ?? running.first {
                        rpid = Int(app.processIdentifier)
                    }
                }
                return ["name": name, "bundleId": bid as Any, "path": bundlePath, "pid": rpid]
            }
            guard let pp = parentPid(pid), pp != pid else { break }
            pid = pp
            hops += 1
        }
        return nil
    }
}

func sessionStateJSON() -> [String: Any] {
    let s = sessionInfo()
    return ["locked": s.locked, "onConsole": s.onConsole, "secureInput": IsSecureEventInputEnabled(), "frontmost": frontmostJSON()]
}

// MARK: - Accessibility

enum AX {
    static let systemWide = AXUIElementCreateSystemWide()
    private static var prepared = false

    /// Bound every AX round-trip so one hung app can't wedge the action queue.
    static func prepare() {
        if prepared { return }
        prepared = true
        AXUIElementSetMessagingTimeout(systemWide, 1.5)
    }

    static func copy(_ el: AXUIElement, _ attr: String) -> (AXError, CFTypeRef?) {
        var v: CFTypeRef?
        let e = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
        return (e, v)
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        let (e, v) = copy(el, attr)
        return e == .success ? v as? String : nil
    }

    static func element(_ v: CFTypeRef?) -> AXUIElement? {
        guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    /// Missing attributes come back as nil (AX packs them as kAXValueAXErrorType).
    static func multi(_ el: AXUIElement, _ attrs: [String]) -> (AXError, [CFTypeRef?]) {
        var out: CFArray?
        let e = AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
        guard e == .success, let arr = out as [AnyObject]?, arr.count == attrs.count else {
            return (e == .success ? .failure : e, Array(repeating: nil, count: attrs.count))
        }
        return (.success, arr.map { v -> CFTypeRef? in
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            if v is NSNull { return nil }
            return v
        })
    }

    static func point(_ v: CFTypeRef?) -> CGPoint? {
        guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ v: CFTypeRef?) -> CGSize? {
        guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        let (_, vals) = multi(el, ["AXPosition", "AXSize"])
        guard let p = point(vals[0]), let s = size(vals[1]) else { return nil }
        return CGRect(origin: p, size: s)
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    static func children(_ el: AXUIElement, limit: Int) -> [AXUIElement] {
        var out: CFArray?
        guard AXUIElementCopyAttributeValues(el, "AXChildren" as CFString, 0, limit, &out) == .success,
              let arr = out as [AnyObject]? else { return [] }
        return arr.compactMap { element($0) }
    }

    static func pid(_ el: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(el, &pid) == .success && pid > 0 ? pid : nil
    }

    static func setBool(_ el: AXUIElement, _ attr: String, _ value: Bool) -> AXError {
        AXUIElementSetAttributeValue(el, attr as CFString, (value ? kCFBooleanTrue : kCFBooleanFalse)!)
    }

    static func perform(_ el: AXUIElement, _ action: String) -> AXError {
        AXUIElementPerformAction(el, action as CFString)
    }
}

func axFail(_ e: AXError, _ what: String) -> HelperError {
    switch e {
    case .apiDisabled: return HelperError("NOT_TRUSTED", "Accessibility permission is not granted")
    case .invalidUIElement: return HelperError("REF_EXPIRED", "\(what): the element no longer exists")
    case .cannotComplete: return HelperError("AX_TIMEOUT", "\(what): the application did not answer in time")
    case .notImplemented: return HelperError("UNSUPPORTED", "\(what): the application does not implement it")
    default: return HelperError("AX_ERROR", "\(what) failed (AXError \(e.rawValue))", ["axError": Int(e.rawValue)])
    }
}

typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
/// _AXUIElementGetWindow is private but stable for over a decade (window managers
/// rely on it). Resolved dynamically so its absence only costs the frame fallback.
let axGetWindow: AXGetWindowFn? = {
    guard let h = dlopen(nil, RTLD_NOW), let sym = dlsym(h, "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(sym, to: AXGetWindowFn.self)
}()

func windowID(of win: AXUIElement, pid: pid_t) -> Int? {
    if let f = axGetWindow {
        var wid: CGWindowID = 0
        if f(win, &wid) == .success, wid != 0 { return Int(wid) }
    }
    guard let fr = AX.frame(win) else { return nil }
    let near = { (a: CGFloat, b: CGFloat) in abs(a - b) <= 2 }
    return Windows.list(onScreenOnly: false).first { w in
        w.pid == Int(pid) && w.layer == 0 && near(w.bounds.minX, fr.minX) && near(w.bounds.minY, fr.minY)
            && near(w.bounds.width, fr.width) && near(w.bounds.height, fr.height)
    }?.windowId
}

let TEXT_ROLES: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

/// Never called for secure fields. Long text is read through AXStringForRange so a
/// big document isn't copied just to show a preview.
func readValue(_ el: AXUIElement, role: String?, limit: Int) -> Any? {
    if let role = role, TEXT_ROLES.contains(role) {
        var range = CFRange(location: 0, length: limit)
        if let param = AXValueCreate(.cfRange, &range) {
            var v: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(el, "AXStringForRange" as CFString, param, &v) == .success, let s = v as? String {
                return s
            }
        }
    }
    let (e, v) = AX.copy(el, "AXValue")
    guard e == .success, let v = v else { return nil }
    if let s = v as? String { return s.count > limit ? String(s.prefix(limit)) : s }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return (v as! NSNumber).boolValue }
    if let n = v as? NSNumber { return n }
    return nil
}

let PROBE_ATTRS = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXEnabled", "AXPosition", "AXSize", "AXWindow"]

func probeElement(_ el: AXUIElement) -> Probe {
    var p = Probe()
    if let pid = AX.pid(el) {
        p.pid = Int(pid)
        let info = appInfo(pid)
        p.bundleId = info.bundleId
        p.app = info.name
    }
    let (err, vals) = AX.multi(el, PROBE_ATTRS)
    p.axError = err
    guard err == .success else {
        p.readable = false
        return p
    }
    p.role = vals[0] as? String
    p.subrole = vals[1] as? String
    p.title = trimmed(vals[2] as? String, 200)
    p.desc = trimmed(vals[3] as? String, 200)
    p.enabled = (vals[4] as? NSNumber)?.boolValue
    if let pt = AX.point(vals[5]), let sz = AX.size(vals[6]) { p.frame = CGRect(origin: pt, size: sz) }
    p.secure = p.subrole == "AXSecureTextField" || p.role == "AXSecureTextField"
    if p.role == nil && p.subrole == nil { p.readable = false }
    if !p.secure, let v = readValue(el, role: p.role, limit: 80) {
        p.valuePreview = (v as? String) ?? (v as? NSNumber)?.stringValue ?? (v as? Bool).map { $0 ? "true" : "false" }
    }
    let win: AXUIElement? = p.role == "AXWindow" ? el : AX.element(vals[7])
    if let win = win {
        p.windowTitle = AX.string(win, "AXTitle").flatMap { $0.isEmpty ? nil : $0 }
        if let pid = p.pid { p.windowId = windowID(of: win, pid: pid_t(pid)) }
    }
    return p
}

func probeAt(_ pt: CGPoint) throws -> Probe {
    AX.prepare()
    var found: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(AX.systemWide, Float(pt.x), Float(pt.y), &found)
    if err == .apiDisabled { throw axFail(err, "probe") }
    var p = Probe()
    if err == .success, let el = found {
        p = probeElement(el)
    } else {
        p.readable = false
        p.axError = err
    }
    // Fill in from the window list when AX couldn't (hung or AX-less apps) so the
    // guard still sees which app and window sit under the point.
    if p.pid == nil || p.windowId == nil || p.windowTitle == nil {
        if let w = Windows.at(pt, pid: p.pid) {
            if p.pid == nil {
                p.pid = w.pid
                let info = appInfo(pid_t(w.pid))
                p.bundleId = info.bundleId
                p.app = info.name ?? w.owner
            }
            if p.windowId == nil { p.windowId = w.windowId }
            if p.windowTitle == nil { p.windowTitle = w.title }
            if p.frame == nil { p.frame = w.bounds }
        }
    }
    return p
}

/// The frontmost app's focused window (role AXWindow), used for keyboard guards.
func frontmostWindowProbe() -> Probe? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    var p = Probe()
    p.pid = Int(app.processIdentifier)
    p.bundleId = app.bundleIdentifier
    p.app = app.localizedName
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    let (e, v) = AX.copy(axApp, "AXFocusedWindow")
    if e == .success, let win = AX.element(v) {
        p.role = "AXWindow"
        p.windowTitle = AX.string(win, "AXTitle").flatMap { $0.isEmpty ? nil : $0 }
        p.windowId = windowID(of: win, pid: app.processIdentifier)
        p.frame = AX.frame(win)
    } else {
        p.readable = false
        p.axError = e
    }
    return p
}

func probeFocus() throws -> Probe {
    AX.prepare()
    let (e, v) = AX.copy(AX.systemWide, "AXFocusedUIElement")
    if e == .apiDisabled { throw axFail(e, "probe_focus") }
    if e == .success, let el = AX.element(v) { return probeElement(el) }
    var p = frontmostWindowProbe() ?? Probe()
    p.readable = false
    return p
}

// MARK: - Input

enum Btn: String, CaseIterable {
    case left, right, middle

    var cg: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }
    var down: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }
    var up: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }
    var dragged: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }
}

func cursorLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

final class Input {
    static let shared = Input()

    /// One private source: our modifier state never mixes with the user's, and
    /// local-event suppression is off so the user can always take over.
    let source: CGEventSource?
    private let lock = NSLock()
    private var gen: UInt64 = 0
    private var heldButtons: [Btn] = []
    private var heldKeys: Set<CGKeyCode> = []
    private var latched = false
    private var lastUserInterruptNs: UInt64 = 0

    init() {
        source = CGEventSource(stateID: .privateState)
        source?.localEventsSuppressionInterval = 0
        source?.userData = SYNB_STAMP
    }

    var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return gen }
    var isLatched: Bool { lock.lock(); defer { lock.unlock() }; return latched }

    func setLatched(_ v: Bool) { lock.lock(); latched = v; lock.unlock() }

    func noteUserInterrupt(_ ns: UInt64) { lock.lock(); lastUserInterruptNs = ns; lock.unlock() }

    func userInterrupted(since ns: UInt64) -> Bool { lock.lock(); defer { lock.unlock() }; return lastUserInterruptNs > ns }

    func checkAbort(_ g: UInt64) throws {
        if generation != g { throw HelperError("ABORTED", "the action was aborted") }
    }

    func sleepAbortable(_ ms: Double, _ g: UInt64) throws {
        let end = nowNs() + UInt64(max(0, ms) * 1_000_000)
        while nowNs() < end {
            try checkAbort(g)
            sleepMs(min(20, Double(end - nowNs()) / 1_000_000))
        }
    }

    func post(_ e: CGEvent?) {
        guard let e = e else { return }
        e.setIntegerValueField(.eventSourceUserData, value: SYNB_STAMP)
        e.post(tap: .cghidEventTap)
    }

    // ── held-state tracking (so abort / panic / exit can release it) ──
    private func mark(button b: Btn, _ down: Bool) {
        lock.lock()
        if down { if !heldButtons.contains(b) { heldButtons.append(b) } } else { heldButtons.removeAll { $0 == b } }
        lock.unlock()
    }

    private func mark(key k: CGKeyCode, _ down: Bool) {
        lock.lock()
        if down { heldKeys.insert(k) } else { heldKeys.remove(k) }
        lock.unlock()
    }

    var heldButton: Btn? { lock.lock(); defer { lock.unlock() }; return heldButtons.last }

    func isHeld(_ b: Btn) -> Bool { lock.lock(); defer { lock.unlock() }; return heldButtons.contains(b) }

    /// Releases exactly what this process holds. Posts nothing when nothing is held.
    func releaseTracked() {
        lock.lock()
        let buttons = heldButtons
        let keys = heldKeys
        heldButtons = []
        heldKeys = []
        lock.unlock()
        guard !buttons.isEmpty || !keys.isEmpty, CGPreflightPostEventAccess() else { return }
        let pos = cursorLocation()
        for b in buttons { post(CGEvent(mouseEventSource: source, mouseType: b.up, mouseCursorPosition: pos, mouseButton: b.cg)) }
        for k in keys { keyEvent(k, down: false, flags: []) }
    }

    /// Cancels the in-flight action (it notices at its next check) and releases held input.
    func abort() {
        lock.lock()
        gen &+= 1
        lock.unlock()
        releaseTracked()
    }

    /// After a respawn the previous process's held state is unknown: besides what we
    /// track, release every modifier and mouse button the session reports as down.
    /// Nothing is posted when nothing is down.
    func panic() {
        abort()
        guard CGPreflightPostEventAccess() else { return }
        let flags = CGEventSource.flagsState(.combinedSessionState)
        for m in Mod.allCases where flags.contains(m.flag) {
            keyEvent(m.keyCode, down: false, flags: [])
            if let r = m.rightKeyCode { keyEvent(r, down: false, flags: []) }
        }
        let pos = cursorLocation()
        for b in Btn.allCases where CGEventSource.buttonState(.combinedSessionState, button: b.cg) {
            post(CGEvent(mouseEventSource: source, mouseType: b.up, mouseCursorPosition: pos, mouseButton: b.cg))
        }
    }

    // ── pointer ──
    func postPointer(_ pt: CGPoint) {
        let held = heldButton
        post(CGEvent(mouseEventSource: source, mouseType: held?.dragged ?? .mouseMoved, mouseCursorPosition: pt, mouseButton: held?.cg ?? .left))
    }

    func move(to target: CGPoint, steps: Int, gen g: UInt64) throws {
        let start = cursorLocation()
        let n = clampInt(steps, 1, 200)
        for i in 1...n {
            try checkAbort(g)
            let t = CGFloat(i) / CGFloat(n)
            postPointer(CGPoint(x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t))
            if i < n { sleepMs(4) }
        }
    }

    func button(_ b: Btn, down: Bool, at p: CGPoint, clickState: Int = 1, flags: CGEventFlags = []) {
        let e = CGEvent(mouseEventSource: source, mouseType: down ? b.down : b.up, mouseCursorPosition: p, mouseButton: b.cg)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        e?.flags = flags
        if down { mark(button: b, true) }
        post(e)
        if !down { mark(button: b, false) }
    }

    func click(at p: CGPoint, button b: Btn, count: Int, flags: CGEventFlags, gen g: UInt64) throws {
        for c in 1...count {
            try checkAbort(g)
            button(b, down: true, at: p, clickState: c, flags: flags)
            sleepMs(15)
            button(b, down: false, at: p, clickState: c, flags: flags)
            if c < count { sleepMs(35) }
        }
    }

    func scroll(at p: CGPoint, dx: Int, dy: Int, flags: CGEventFlags, gen g: UInt64) throws {
        let (w1, w2) = scrollWheelDeltas(dx: dx, dy: dy)
        var r1 = Int(w1), r2 = Int(w2)
        // Several small events instead of one huge delta: apps clamp or accelerate big ones.
        while r1 != 0 || r2 != 0 {
            try checkAbort(g)
            let s1 = clampInt(r1, -5, 5), s2 = clampInt(r2, -5, 5)
            let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(s1), wheel2: Int32(s2), wheel3: 0)
            e?.location = p
            e?.flags = flags
            post(e)
            r1 -= s1
            r2 -= s2
            if r1 != 0 || r2 != 0 { sleepMs(15) }
        }
    }

    // ── keyboard ──
    func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        e?.flags = flags
        post(e)
    }

    func tap(_ code: CGKeyCode, flags: CGEventFlags = []) {
        mark(key: code, true)
        keyEvent(code, down: true, flags: flags)
        sleepMs(4)
        keyEvent(code, down: false, flags: flags)
        mark(key: code, false)
    }

    /// Modifiers go down in order (as real key events carrying the accumulated flags),
    /// the key is pressed `repeatCount` times (held for holdMs when given), then the
    /// modifiers are released in reverse — also when aborted.
    func pressCombo(_ combo: KeyCombo, repeatCount: Int, holdMs: Double, gen g: UInt64) throws {
        var flags = CGEventFlags()
        var pressed: [Mod] = []
        defer {
            for m in pressed.reversed() {
                flags.remove(m.flag)
                keyEvent(m.keyCode, down: false, flags: flags)
                mark(key: m.keyCode, false)
            }
        }
        for m in combo.mods {
            try checkAbort(g)
            flags.insert(m.flag)
            mark(key: m.keyCode, true)
            keyEvent(m.keyCode, down: true, flags: flags)
            pressed.append(m)
            sleepMs(6)
        }
        if let code = combo.keyCode {
            let n = clampInt(repeatCount, 1, 100)
            for i in 0..<n {
                try checkAbort(g)
                mark(key: code, true)
                keyEvent(code, down: true, flags: flags)
                do {
                    if holdMs > 0 { try sleepAbortable(holdMs, g) } else { sleepMs(8) }
                } catch {
                    keyEvent(code, down: false, flags: flags)
                    mark(key: code, false)
                    throw error
                }
                keyEvent(code, down: false, flags: flags)
                mark(key: code, false)
                if i < n - 1 { sleepMs(25) }
            }
        } else if holdMs > 0 {
            try sleepAbortable(holdMs, g)
        }
    }

    /// CGEventKeyboardSetUnicodeString carries at most 20 UTF-16 units per event;
    /// longer strings are split without breaking a surrogate pair.
    func typeUnicode(_ s: String) {
        let units = Array(s.utf16)
        var idx = 0
        while idx < units.count {
            var end = min(idx + 20, units.count)
            if end < units.count, end - idx > 1, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
            var slice = Array(units[idx..<end])
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
            down?.flags = []
            down?.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
            post(down)
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            up?.flags = []
            up?.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
            post(up)
            idx = end
        }
    }

    /// keys mode: real key codes for the current layout; characters the layout can't
    /// produce fall back to the unicode path.
    func typeKeys(_ s: String, layout: LayoutMap) {
        for ch in s {
            if let r = resolveChar(ch, layout: layout, ansiFallback: false) {
                var f = CGEventFlags()
                if r.shift { f.insert(.maskShift) }
                if r.alt { f.insert(.maskAlternate) }
                tap(r.code, flags: f)
                sleepMs(4)
            } else {
                typeUnicode(String(ch))
            }
        }
    }
}

/// Reverse map of the current keyboard layout (UCKeyTranslate over every key code
/// and the none/shift/option/shift+option states). TIS must run on the main thread.
func currentLayoutMap() -> LayoutMap {
    onMain {
        var map: LayoutMap = [:]
        guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return map }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(data) else { return map }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        let kbType = UInt32(LMGetKbdType())
        for state: UInt32 in [0, 2, 8, 10] {
            for code in 0..<128 {
                var dead: UInt32 = 0
                var len = 0
                var chars = [UniChar](repeating: 0, count: 8)
                let st = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), state, kbType,
                                        OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &len, &chars)
                guard st == noErr, len > 0 else { continue }
                let s = String(utf16CodeUnits: chars, count: len)
                guard let first = s.unicodeScalars.first, !CharacterSet.controlCharacters.contains(first) else { continue }
                if map[s] == nil { map[s] = (CGKeyCode(code), state) }
            }
        }
        return map
    }
}

func parseButton(_ s: String?) throws -> Btn {
    guard let s = s else { return .left }
    guard let b = Btn(rawValue: s.lowercased()) else { throw HelperError("BAD_ARGS", "button must be left, right or middle") }
    return b
}

func parseModifiers(_ arr: [Any]?) throws -> CGEventFlags {
    var f = CGEventFlags()
    for item in arr ?? [] {
        guard let s = item as? String, let m = Mod.parse(s) else { throw HelperError("BAD_ARGS", "unknown modifier \(item)") }
        f.insert(m.flag)
    }
    return f
}

// MARK: - Guards

func requireTrusted() throws {
    guard AXIsProcessTrusted() else {
        throw HelperError("NOT_TRUSTED", "Accessibility permission is required", ["responsibleApp": ResponsibleApp.info as Any])
    }
}

func requireNotLatched() throws {
    if Input.shared.isLatched {
        throw HelperError("INTERRUPTED", "an emergency stop is latched; send configure to resume", ["latched": true])
    }
}

func requireUnlocked() throws {
    guard Config.guardCfg.refuseWhenLocked else { return }
    let s = sessionInfo()
    if s.locked || !s.onConsole {
        throw HelperError("SCREEN_LOCKED", s.locked ? "the screen is locked" : "the login session is not on the console",
                          ["locked": s.locked, "onConsole": s.onConsole])
    }
}

func requireOnScreen(_ p: CGPoint) throws {
    if Displays.containing(p) == nil {
        throw HelperError("OUT_OF_BOUNDS", "(\(p.x), \(p.y)) is not on any display", ["point": pointJSON(p)])
    }
}

/// Every input/AX action: permission, emergency latch, lock state.
func preInput() throws {
    try requireTrusted()
    try requireNotLatched()
    try requireUnlocked()
}

func guardPoint(_ p: CGPoint, context: String) throws -> Probe {
    let probe = try probeAt(p)
    if let e = matchGuard(probe, Config.guardCfg, context: context) { throw e }
    return probe
}

/// Keyboard target: the focused element and the frontmost window must pass the
/// app/window rules; printable input (or paste) must not reach a secure field, and
/// fails closed when focus is unreadable while secure event input is on.
func keyboardGuard(printable: Bool, context: String) throws -> Probe {
    try requireUnlocked()
    let g = Config.guardCfg
    let focus = try probeFocus()
    if let e = matchGuard(focus, g, context: context) { throw e }
    if let front = frontmostWindowProbe(), let e = matchGuard(front, g, context: context) { throw e }
    if printable && g.secureField {
        if focus.secure {
            throw HelperError("SECURE_FIELD", "the focused field is a password field", ["probe": focus.json, "context": context])
        }
        if !focus.readable && IsSecureEventInputEnabled() {
            throw HelperError("SECURE_FIELD", "secure input is active and the focused element can't be read",
                              ["probe": focus.json, "context": context, "secureInput": true])
        }
    }
    return focus
}

// MARK: - Screen capture (ScreenCaptureKit only; never called without the grant)

func requireCapture() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw HelperError("NO_SCREEN_RECORDING", "Screen Recording permission is required", ["responsibleApp": ResponsibleApp.info as Any])
    }
}

func mapCaptureError(_ e: Error) -> HelperError {
    if let h = e as? HelperError { return h }
    let ns = e as NSError
    if ns.domain == SCStreamErrorDomain && ns.code == -3801 {
        return HelperError("NO_SCREEN_RECORDING", "Screen Recording permission was declined")
    }
    return HelperError("INTERNAL", "screen capture failed: \(ns.localizedDescription)", ["domain": ns.domain, "code": ns.code])
}

func shareableDisplay(_ id: CGDirectDisplayID) throws -> SCDisplay {
    let content: SCShareableContent
    do {
        content = try waitFor("ScreenCaptureKit", timeout: 10) { done in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, e in done(c, e) }
        }
    } catch { throw mapCaptureError(error) }
    guard let d = content.displays.first(where: { $0.displayID == id }) else {
        throw HelperError("BAD_ARGS", "display \(id) is not available for capture")
    }
    return d
}

func sckCapture(_ filter: SCContentFilter, _ config: SCStreamConfiguration) throws -> CGImage {
    do {
        return try waitFor("ScreenCaptureKit", timeout: 10) { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { img, e in done(img, e) }
        }
    } catch { throw mapCaptureError(error) }
}

func scaleImage(_ img: CGImage, _ w: Int, _ h: Int) -> CGImage? {
    guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

func encodeJPEG(_ img: CGImage, quality: Double) throws -> Data {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
        throw HelperError("INTERNAL", "JPEG encoder unavailable")
    }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: clampDouble(quality, 0.05, 1)] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("INTERNAL", "JPEG encoding failed") }
    return data as Data
}

func parseFit(_ a: Args, defaultW: Double, defaultH: Double) -> (w: Double, h: Double) {
    let f = a.dict("fit")
    return (Args.num(f?["w"]) ?? defaultW, Args.num(f?["h"]) ?? defaultH)
}

func imageJSON(_ img: CGImage, quality: Double) throws -> [String: Any] {
    let jpeg = try encodeJPEG(img, quality: quality)
    return ["w": img.width, "h": img.height, "mime": "image/jpeg", "data": jpeg.base64EncodedString()]
}

func cmdScreenshot(_ a: Args) throws -> Any {
    try requireCapture()
    let did = a.num("displayId").map { CGDirectDisplayID(UInt32(clamping: toInt($0))) } ?? CGMainDisplayID()
    let bounds = CGDisplayBounds(did)
    guard bounds.width > 0, bounds.height > 0, Displays.ids().contains(did) else {
        throw HelperError("BAD_ARGS", "unknown display \(did)")
    }
    let scale = Displays.scale(did)
    let fit = parseFit(a, defaultW: Double(bounds.width), defaultH: Double(bounds.height))
    let size = fitSize(width: Double(bounds.width), height: Double(bounds.height), fitW: fit.w, fitH: fit.h, scale: scale)
    let display = try shareableDisplay(did)
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.width = size.w // SCK scales on the GPU to exactly this size
    cfg.height = size.h
    cfg.showsCursor = a.bool("showCursor") ?? false
    cfg.capturesAudio = false
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.colorSpaceName = CGColorSpace.sRGB
    cfg.captureResolution = .best
    var img = try sckCapture(filter, cfg)
    if img.width != size.w || img.height != size.h, let scaled = scaleImage(img, size.w, size.h) { img = scaled }
    let px = Displays.pixelSize(did)
    return [
        "displayId": Int(did), "bounds": rectJSON(bounds), "capturedPixels": ["w": px.w, "h": px.h],
        "image": try imageJSON(img, quality: a.num("quality") ?? 0.8),
        "cursor": pointJSON(cursorLocation()), "frontmost": frontmostJSON(), "capturedAt": epochMs(),
    ]
}

/// A region at native resolution, downscaled only to stay within fit. The rect is
/// clipped to the display under its centre.
func cmdCaptureRect(_ a: Args) throws -> Any {
    try requireCapture()
    let rect = try Args.rect(a.dict("rect"), "rect")
    guard let did = Displays.containing(CGPoint(x: rect.midX, y: rect.midY)) else {
        throw HelperError("OUT_OF_BOUNDS", "the rect's centre is not on any display", ["rect": rectJSON(rect)])
    }
    let dbounds = CGDisplayBounds(did)
    let clipped = rect.intersection(dbounds)
    guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else {
        throw HelperError("OUT_OF_BOUNDS", "the rect does not overlap a display", ["rect": rectJSON(rect)])
    }
    let scale = Displays.scale(did)
    let fit = parseFit(a, defaultW: Double(clipped.width) * scale, defaultH: Double(clipped.height) * scale)
    let size = fitSize(width: Double(clipped.width), height: Double(clipped.height), fitW: fit.w, fitH: fit.h, scale: scale)
    var img: CGImage
    if #available(macOS 15.2, *) {
        do {
            img = try waitFor("ScreenCaptureKit", timeout: 10) { done in
                SCScreenshotManager.captureImage(in: clipped) { i, e in done(i, e) }
            }
        } catch { throw mapCaptureError(error) }
    } else {
        let display = try shareableDisplay(did)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.sourceRect = clipped.offsetBy(dx: -dbounds.minX, dy: -dbounds.minY) // display-local points
        cfg.width = size.w
        cfg.height = size.h
        cfg.showsCursor = false
        cfg.capturesAudio = false
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.captureResolution = .best
        img = try sckCapture(filter, cfg)
    }
    if img.width != size.w || img.height != size.h, let scaled = scaleImage(img, size.w, size.h) { img = scaled }
    return ["image": try imageJSON(img, quality: a.num("quality") ?? 0.85), "rect": rectJSON(clipped), "capturedAt": epochMs()]
}

// MARK: - Pointer / keyboard commands

func cmdMove(_ a: Args) throws -> Any {
    try preInput()
    let p = try a.point()
    try requireOnScreen(p)
    // With a button held (mouse_down) a move is a drag: the drop target is guarded.
    if Input.shared.heldButton != nil { _ = try guardPoint(p, context: "move.drag") }
    try Input.shared.move(to: p, steps: a.int("steps") ?? Config.input.moveSteps, gen: Input.shared.generation)
    return [String: Any]()
}

func cmdClick(_ a: Args) throws -> Any {
    try preInput()
    let p = try a.point()
    try requireOnScreen(p)
    let b = try parseButton(a.string("button"))
    let count = clampInt(a.int("count") ?? 1, 1, 3)
    let flags = try parseModifiers(a.array("modifiers"))
    let g = Input.shared.generation
    _ = try guardPoint(p, context: "click") // refuse before the pointer moves…
    try Input.shared.move(to: p, steps: Config.input.moveSteps, gen: g)
    try requireUnlocked()
    let target = try guardPoint(p, context: "click") // …and again right before the button goes down
    try Input.shared.checkAbort(g)
    try Input.shared.click(at: p, button: b, count: count, flags: flags, gen: g)
    return ["target": target.json]
}

func cmdMouseDown(_ a: Args) throws -> Any {
    try preInput()
    let p = try a.point()
    try requireOnScreen(p)
    let b = try parseButton(a.string("button"))
    let g = Input.shared.generation
    _ = try guardPoint(p, context: "mouse_down")
    try Input.shared.move(to: p, steps: Config.input.moveSteps, gen: g)
    let target = try guardPoint(p, context: "mouse_down")
    try Input.shared.checkAbort(g)
    Input.shared.button(b, down: true, at: p)
    return ["target": target.json]
}

/// No guard: refusing a release would leave the button stuck.
func cmdMouseUp(_ a: Args) throws -> Any {
    try requireTrusted()
    let p = try a.point()
    try requireOnScreen(p)
    let b = try parseButton(a.string("button"))
    Input.shared.postPointer(p)
    sleepMs(8)
    let target = (try? probeAt(p)) ?? Probe()
    Input.shared.button(b, down: false, at: p)
    return ["target": target.json]
}

func cmdDrag(_ a: Args) throws -> Any {
    try preInput()
    let from = try Args.point(a.dict("from"), "from")
    let to = try Args.point(a.dict("to"), "to")
    try requireOnScreen(from)
    try requireOnScreen(to)
    let b = try parseButton(a.string("button"))
    let steps = clampInt(a.int("steps") ?? 20, 1, 400)
    let g = Input.shared.generation
    _ = try guardPoint(from, context: "drag.from")
    _ = try guardPoint(to, context: "drag.to")
    try Input.shared.move(to: from, steps: Config.input.moveSteps, gen: g)
    let target = try guardPoint(from, context: "drag.from")
    try Input.shared.checkAbort(g)
    Input.shared.button(b, down: true, at: from)
    do {
        sleepMs(50)
        for i in 1...steps {
            try Input.shared.checkAbort(g)
            let t = CGFloat(i) / CGFloat(steps)
            Input.shared.postPointer(CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
            sleepMs(8)
        }
        sleepMs(30)
        // The drop target could have changed while dragging: cancel back at the origin.
        if let e = matchGuard(try probeAt(to), Config.guardCfg, context: "drag.to") {
            Input.shared.postPointer(from)
            sleepMs(20)
            Input.shared.button(b, down: false, at: from)
            throw e
        }
        Input.shared.button(b, down: false, at: to)
    } catch {
        if Input.shared.isHeld(b) { Input.shared.button(b, down: false, at: cursorLocation()) }
        throw error
    }
    return ["target": target.json]
}

func cmdScroll(_ a: Args) throws -> Any {
    try preInput()
    let p = try a.point()
    try requireOnScreen(p)
    if let u = a.string("units"), u != "line" { throw HelperError("BAD_ARGS", "units must be 'line'") }
    let dx = clampInt(a.int("dx") ?? 0, -1000, 1000), dy = clampInt(a.int("dy") ?? 0, -1000, 1000)
    let flags = try parseModifiers(a.array("modifiers"))
    let g = Input.shared.generation
    _ = try guardPoint(p, context: "scroll")
    try Input.shared.move(to: p, steps: Config.input.moveSteps, gen: g)
    let target = try guardPoint(p, context: "scroll")
    try Input.shared.scroll(at: p, dx: dx, dy: dy, flags: flags, gen: g)
    return ["target": target.json]
}

func cmdType(_ a: Args) throws -> Any {
    try preInput()
    guard let text = a.string("text") else { throw HelperError("BAD_ARGS", "text is required") }
    let mode = a.string("mode") ?? "unicode"
    guard mode == "unicode" || mode == "keys" else { throw HelperError("BAD_ARGS", "mode must be 'unicode' or 'keys'") }
    let cfg = Config.input
    let g = Input.shared.generation
    let started = nowNs()
    _ = try keyboardGuard(printable: true, context: "type")
    let layout: LayoutMap = mode == "keys" ? currentLayoutMap() : [:]
    var typed = 0 // UTF-16 units, so the caller can `text.slice(typed)` what's left
    for (i, seg) in segmentText(text, chunk: cfg.typeChunk).enumerated() {
        if Input.shared.generation != g { return ["typed": typed, "interrupted": "abort"] }
        if Input.shared.userInterrupted(since: started) { return ["typed": typed, "interrupted": "user_input"] }
        if i > 0 {
            // Focus can move mid-text (a Tab into a password field): re-check every chunk.
            do { _ = try keyboardGuard(printable: true, context: "type") } catch let e as HelperError { throw e.adding(["typed": typed]) }
        }
        switch seg {
        case .text(let s):
            if mode == "keys" { Input.shared.typeKeys(s, layout: layout) } else { Input.shared.typeUnicode(s) }
        case .key(let code, _):
            Input.shared.tap(code)
        }
        typed += seg.utf16Count
        sleepMs(cfg.typeDelayMs)
    }
    return ["typed": typed]
}

func cmdKey(_ a: Args, hold: Bool) throws -> Any {
    try preInput()
    guard let raw = a.string("combo") else { throw HelperError("BAD_ARGS", "combo is required") }
    let combo = try parseCombo(raw, layout: currentLayoutMap())
    let holdMs = hold ? clampDouble(a.num("durationMs") ?? 500, 0, 30_000) : 0
    let target = try keyboardGuard(printable: combo.needsSecureCheck, context: hold ? "hold_key" : "key")
    try Input.shared.pressCombo(combo, repeatCount: hold ? 1 : (a.int("repeat") ?? 1), holdMs: holdMs, gen: Input.shared.generation)
    return ["target": target.json]
}

// MARK: - Apps and windows

func cmdApps() -> Any {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { app -> [String: Any] in
        [
            "pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier as Any, "name": app.localizedName as Any,
            "active": app.isActive, "hidden": app.isHidden, "path": app.bundleURL?.path as Any,
        ]
    }
}

func cmdWindows(_ a: Args) -> Any {
    let pidFilter = a.int("pid")
    var cache: [Int: (String?, String?)] = [:]
    return Windows.list(onScreenOnly: a.bool("onScreenOnly") ?? true)
        .filter { pidFilter == nil || $0.pid == pidFilter! }
        .map { w -> [String: Any] in
            if cache[w.pid] == nil { let i = appInfo(pid_t(w.pid)); cache[w.pid] = (i.bundleId, i.name) }
            let info = cache[w.pid]!
            let appName: String? = info.1 ?? w.owner
            return [
                "windowId": w.windowId, "pid": w.pid, "app": appName as Any, "bundleId": info.0 as Any,
                "title": w.title as Any, "bounds": rectJSON(w.bounds), "layer": w.layer, "onScreen": w.onScreen,
            ]
        }
}

/// Names and bundle ids only — never URLs, paths or anything a shell would expand.
func validateAppToken(_ s: String, field: String) throws {
    let lower = s.lowercased()
    if s.isEmpty || s.count > 200 || lower.contains("://") || s.contains("/") || s.contains(":") || s.contains("..")
        || s.hasPrefix("~") || s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
        throw HelperError("BAD_ARGS", "\(field) must be an app name or bundle id, not a URL or path")
    }
    if lower.range(of: "^[a-z][a-z0-9+.-]*:", options: .regularExpression) != nil {
        throw HelperError("BAD_ARGS", "\(field) looks like a URL")
    }
}

func resolveAppURL(bundleId: String?, name: String?) -> URL? {
    if let b = bundleId { return NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) }
    guard let n = name else { return nil }
    if let running = NSWorkspace.shared.runningApplications.first(where: { ($0.localizedName ?? "").caseInsensitiveCompare(n) == .orderedSame }),
       let url = running.bundleURL {
        return url
    }
    let fm = FileManager.default
    let dirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                NSHomeDirectory() + "/Applications", "/System/Library/CoreServices"]
    let wanted = "\(n).app"
    for d in dirs where fm.fileExists(atPath: "\(d)/\(wanted)") { return URL(fileURLWithPath: "\(d)/\(wanted)") }
    for d in dirs {
        if let items = try? fm.contentsOfDirectory(atPath: d), let hit = items.first(where: { $0.caseInsensitiveCompare(wanted) == .orderedSame }) {
            return URL(fileURLWithPath: "\(d)/\(hit)")
        }
    }
    return nil
}

func cmdOpenApp(_ a: Args) throws -> Any {
    try requireNotLatched()
    try requireUnlocked()
    let bundleId = a.string("bundleId"), name = a.string("name")
    guard bundleId != nil || name != nil else { throw HelperError("BAD_ARGS", "bundleId or name is required") }
    if let b = bundleId { try validateAppToken(b, field: "bundleId") }
    if let n = name { try validateAppToken(n, field: "name") }
    guard let url = resolveAppURL(bundleId: bundleId, name: name) else {
        throw HelperError("APP_NOT_FOUND", "no application \(bundleId ?? name ?? "")", ["bundleId": bundleId as Any, "name": name as Any])
    }
    let bundle = Bundle(url: url)
    var probe = Probe()
    probe.bundleId = bundle?.bundleIdentifier ?? bundleId
    probe.app = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? url.deletingPathExtension().lastPathComponent
    if let e = matchGuard(probe, Config.guardCfg, context: "open_app") { throw e }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    let app: NSRunningApplication = try waitFor("open_app", timeout: 20) { done in
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, e in done(app, e) }
    }
    let bundleIdOut: String? = app.bundleIdentifier ?? probe.bundleId
    return ["pid": Int(app.processIdentifier), "bundleId": bundleIdOut as Any]
}

func axWindow(pid: pid_t, windowId: Int) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(pid)
    let (e, v) = AX.copy(axApp, "AXWindows")
    guard e == .success, let arr = v as? [AnyObject] else { return nil }
    for item in arr {
        if let win = AX.element(item), windowID(of: win, pid: pid) == windowId { return win }
    }
    return nil
}

func cmdFocusApp(_ a: Args) throws -> Any {
    try requireNotLatched()
    try requireUnlocked()
    let windowId = a.int("windowId")
    var app: NSRunningApplication? = nil
    if let pid = a.int("pid") {
        app = NSRunningApplication(processIdentifier: pid_t(clamping: pid))
    } else if let b = a.string("bundleId") {
        app = NSRunningApplication.runningApplications(withBundleIdentifier: b).first
    } else if let wid = windowId, let w = Windows.info(wid) {
        app = NSRunningApplication(processIdentifier: pid_t(w.pid))
    }
    guard let target = app else { throw HelperError("APP_NOT_FOUND", "no running application matches", a.raw) }
    var probe = Probe()
    probe.pid = Int(target.processIdentifier)
    probe.bundleId = target.bundleIdentifier
    probe.app = target.localizedName
    if let wid = windowId { probe.windowId = wid; probe.windowTitle = Windows.info(wid)?.title }
    if let e = matchGuard(probe, Config.guardCfg, context: "focus_app") { throw e }
    onMain {
        _ = target.unhide()
        _ = target.activate(options: [.activateAllWindows])
    }
    if AXIsProcessTrusted() {
        AX.prepare()
        let axApp = AXUIElementCreateApplication(target.processIdentifier)
        _ = AX.setBool(axApp, "AXFrontmost", true) // works for background callers under cooperative activation
        if let wid = windowId, let win = axWindow(pid: target.processIdentifier, windowId: wid) {
            _ = AX.perform(win, "AXRaise")
            _ = AX.setBool(win, "AXMain", true)
        }
    }
    let deadline = nowNs() + 1_000_000_000
    while nowNs() < deadline && NSWorkspace.shared.frontmostApplication?.processIdentifier != target.processIdentifier { sleepMs(50) }
    return [
        "pid": Int(target.processIdentifier), "bundleId": target.bundleIdentifier as Any,
        "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier,
    ]
}

// MARK: - AX snapshot / action

enum Snapshots {
    /// Last 4 snapshots, each holding its retained elements. Only the action queue touches this.
    private static var items: [(id: String, elements: [AXUIElement])] = []
    private static var counter = 0

    static func add(_ elements: [AXUIElement]) -> String {
        counter += 1
        let id = "s\(counter)"
        items.append((id, elements))
        if items.count > 4 { items.removeFirst(items.count - 4) }
        return id
    }

    static func element(_ snapshotId: String, _ ref: String) -> AXUIElement? {
        guard let snap = items.first(where: { $0.id == snapshotId }), ref.hasPrefix("e"), let n = Int(ref.dropFirst()),
              n >= 1, n <= snap.elements.count else { return nil }
        return snap.elements[n - 1]
    }
}

let INTERACTIVE_ROLES: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton",
    "AXMenuButton", "AXSlider", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXDisclosureTriangle", "AXIncrementor",
    "AXColorWell", "AXDockItem", "AXRow", "AXTab", "AXSearchField",
]
let INTERACTIVE_ACTIONS: Set<String> = ["AXPress", "AXConfirm", "AXPick", "AXIncrement", "AXDecrement", "AXShowMenu", "AXOpen"]
let ACTION_NAMES: [String: String] = [
    "AXPress": "press", "AXShowMenu": "show_menu", "AXRaise": "raise", "AXScrollToVisible": "scroll_into_view",
    "AXConfirm": "confirm", "AXPick": "select", "AXIncrement": "increment", "AXDecrement": "decrement", "AXCancel": "cancel",
]
/// One multi-attribute call per element. 0-7 since protocol 1, 8-12 since protocol 2.
let SNAPSHOT_ATTRS = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXEnabled", "AXFocused", "AXPosition", "AXSize",
    "AXHelp", "AXPlaceholderValue", "AXIdentifier", "AXTitleUIElement", "AXModal",
]
/// Labelled containers name the `group` of everything below them.
let GROUP_ROLES: Set<String> = [
    "AXGroup", "AXToolbar", "AXSheet", "AXTabGroup", "AXSplitGroup", "AXScrollArea", "AXOutline", "AXTable",
    "AXList", "AXRadioGroup", "AXPopover", "AXBrowser",
]
/// These name the group even without a label ("toolbar", "sheet", "popover").
let BARE_GROUP_ROLES: Set<String> = ["AXToolbar", "AXSheet", "AXPopover"]
let DIALOG_SUBROLES: Set<String> = ["AXDialog", "AXSystemDialog"]
/// Unnamed rows and cells (and AXOutlineRow subroles) get a contentLabel with enrich.
let ROW_ROLES: Set<String> = ["AXRow", "AXCell"]

/// Whitespace runs (newlines included) collapsed to one space; nil when blank.
func cleanLabel(_ s: String?) -> String? {
    guard let s = s else { return nil }
    let out = s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    return out.isEmpty ? nil : out
}

/// The `group` handed to an element's children: "<role> <label>" (role without
/// AX, lowercased; clipped to 60) for a labelled container, the bare role for an
/// unlabelled toolbar / sheet / popover, else the inherited group. A window is
/// never a group, so window titles never leak through this field.
func groupForChildren(role: String?, title: String?, desc: String?, inherited: String?) -> String? {
    guard let r = role, GROUP_ROLES.contains(r) else { return inherited }
    let name = String(r.dropFirst(2)).lowercased()
    if let label = cleanLabel(title) ?? cleanLabel(desc) { return String("\(name) \(label)".prefix(60)) }
    return BARE_GROUP_ROLES.contains(r) ? name : inherited
}

/// enrich: the label of an element's AXTitleUIElement (its AXValue, else AXTitle), ≤ 80.
func titleElementLabel(_ el: AXUIElement?) -> String? {
    guard let el = el else { return nil }
    let (e, v) = AX.multi(el, ["AXValue", "AXTitle"])
    guard e == .success else { return nil }
    return (cleanLabel(v[0] as? String) ?? cleanLabel(v[1] as? String)).map { String($0.prefix(80)) }
}

/// enrich: an unnamed row / cell is named by the first AXStaticText value within
/// two levels below it (breadth first, ≤ 8 children per element), ≤ 80.
func contentLabel(_ el: AXUIElement, deadline: UInt64) -> String? {
    var level = AX.children(el, limit: 8)
    for depth in 0..<2 {
        var next: [AXUIElement] = []
        for c in level {
            if nowNs() > deadline { return nil }
            guard let r = AX.string(c, "AXRole") else { continue }
            if r == "AXStaticText", let s = cleanLabel(AX.string(c, "AXValue")) { return String(s.prefix(80)) }
            if depth == 0 { next.append(contentsOf: AX.children(c, limit: 8)) }
        }
        level = next
    }
    return nil
}

/// enrich: the snapshot's root window as {id, title, subrole, modal}, or null.
func rootWindowJSON(_ root: AXUIElement?, pid: pid_t) -> Any {
    guard let w = root else { return NSNull() }
    let (e, v) = AX.multi(w, ["AXTitle", "AXSubrole", "AXModal"])
    guard e == .success else { return NSNull() }
    return [
        "id": windowID(of: w, pid: pid) as Any, "title": trimmed(v[0] as? String, 1000) as Any,
        "subrole": (v[1] as? String) as Any, "modal": (v[2] as? NSNumber)?.boolValue ?? false,
    ]
}

/// The app's UI language as a primary subtag ("pt"): the first of the bundle's
/// localizations in the user's preference order ("Base" skipped; legacy names
/// such as "English" canonicalized). nil when unknown.
func appLanguage(_ running: NSRunningApplication) -> String? {
    guard let url = running.bundleURL, let bundle = Bundle(url: url) else { return nil }
    for loc in bundle.preferredLocalizations + [bundle.developmentLocalization].compactMap({ $0 }) where loc.lowercased() != "base" {
        let canonical = Locale.canonicalLanguageIdentifier(from: loc)
        if let primary = canonical.split(whereSeparator: { $0 == "-" || $0 == "_" }).first, !primary.isEmpty {
            return primary.lowercased()
        }
    }
    return nil
}

/// One pending element of the snapshot walk, with what it inherits from above.
struct AXVisit {
    let el: AXUIElement
    let depth: Int
    let parent: String?
    let group: String?
    let modal: Bool
    let web: Bool
}

func cmdAxSnapshot(_ a: Args) throws -> Any {
    try requireTrusted()
    try requireUnlocked()
    AX.prepare()
    let depthMax = clampInt(a.int("depth") ?? 12, 1, 40)
    let maxNodes = clampInt(a.int("maxNodes") ?? 400, 1, 5000)
    let interactiveOnly = a.bool("interactiveOnly") ?? true
    let timeoutMs = clampDouble(a.num("timeoutMs") ?? 4000, 100, 30_000)
    // Intent snapshots: titleElement / contentLabel per node; window, app.lang and
    // up to maxTexts static texts (≤ 200 chars each) on the result.
    let enrich = a.bool("enrich") ?? false
    let maxTexts = clampInt(a.int("maxTexts") ?? 80, 0, 500)

    // Target: an explicit window, else the given (or frontmost) app's focused window.
    var pid: pid_t
    var root: AXUIElement? = nil
    if let wid = a.int("windowId") {
        guard let w = Windows.info(wid) else { throw HelperError("APP_NOT_FOUND", "window \(wid) not found", ["windowId": wid]) }
        pid = pid_t(w.pid)
        root = axWindow(pid: pid, windowId: wid)
        if root == nil { throw HelperError("AX_ERROR", "window \(wid) is not exposed to accessibility", ["windowId": wid]) }
    } else if let p = a.int("pid") {
        pid = pid_t(clamping: p)
    } else {
        guard let front = NSWorkspace.shared.frontmostApplication else { throw HelperError("APP_NOT_FOUND", "no frontmost application") }
        pid = front.processIdentifier
    }
    guard let running = NSRunningApplication(processIdentifier: pid) else { throw HelperError("APP_NOT_FOUND", "no process \(pid)") }
    let appEl = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(appEl, Float(min(1.0, timeoutMs / 1000)))
    if root == nil {
        for attr in ["AXFocusedWindow", "AXMainWindow"] {
            let (e, v) = AX.copy(appEl, attr)
            if e == .cannotComplete { throw axFail(e, "ax_snapshot") }
            if let w = AX.element(v) { root = w; break }
        }
    }
    let start = root ?? appEl
    let deadline = nowNs() + UInt64(timeoutMs * 1_000_000)

    var nodes: [[String: Any]] = []
    var elements: [AXUIElement] = []
    var texts: [String] = []
    var truncated = false
    var visited = 0
    var stack: [AXVisit] = [AXVisit(el: start, depth: 0, parent: nil, group: nil, modal: false, web: false)]
    while let item = stack.popLast() {
        if nodes.count >= maxNodes || nowNs() > deadline || visited >= maxNodes * 25 { truncated = true; break }
        visited += 1
        autoreleasepool {
            let (err, vals) = AX.multi(item.el, SNAPSHOT_ATTRS)
            if err != .success {
                if visited == 1 && err == .cannotComplete { truncated = true }
                return
            }
            let role = vals[0] as? String
            let subrole = vals[1] as? String
            let title = trimmed(vals[2] as? String, 200)
            let desc = trimmed(vals[3] as? String, 200)
            let secure = subrole == "AXSecureTextField" || role == "AXSecureTextField"
            // modal: at or below a sheet, a popover, a dialog window or anything AXModal.
            // web: at or below a web area (page content, never pressed by intent).
            let dialogWindow = role == "AXWindow" && (subrole.map { DIALOG_SUBROLES.contains($0) } ?? false)
            let modal = item.modal || role == "AXSheet" || role == "AXPopover" || dialogWindow
                || ((vals[12] as? NSNumber)?.boolValue ?? false)
            let web = item.web || role == "AXWebArea"
            if enrich && role == "AXStaticText" && texts.count < maxTexts, let s = cleanLabel(AX.string(item.el, "AXValue")) {
                texts.append(String(s.prefix(200)))
            }
            let rawActions = AX.actions(item.el)
            let interactive = secure || (role.map { INTERACTIVE_ROLES.contains($0) } ?? false)
                || rawActions.contains(where: { INTERACTIVE_ACTIONS.contains($0) })
            var myRef = item.parent
            if !interactiveOnly || interactive {
                elements.append(item.el)
                let ref = "e\(elements.count)"
                myRef = ref
                var frame: Any = NSNull()
                if let p = AX.point(vals[6]), let s = AX.size(vals[7]) { frame = rectJSON(CGRect(origin: p, size: s)) }
                let textRole = role.map { TEXT_ROLES.contains($0) || $0 == "AXSearchField" } ?? false
                var actions = rawActions.compactMap { ACTION_NAMES[$0] ?? ($0.hasPrefix("AX") ? nil : $0) }
                if textRole { actions += ["focus", "set_value"] }
                if role == "AXCheckBox" || role == "AXRadioButton" { actions.append("toggle") }
                var node: [String: Any] = [
                    "ref": ref, "parent": item.parent as Any, "depth": item.depth, "role": role as Any, "subrole": subrole as Any,
                    "title": title as Any, "description": desc as Any,
                    "value": (secure ? nil : readValue(item.el, role: role, limit: 200)) as Any, "secure": secure,
                    "enabled": (vals[4] as? NSNumber)?.boolValue as Any, "focused": (vals[5] as? NSNumber)?.boolValue as Any,
                    "actions": Array(Set(actions)).sorted(), "frame": frame,
                    "help": trimmed(vals[8] as? String, 200) as Any,
                    "placeholder": (textRole ? trimmed(vals[9] as? String, 200) : nil) as Any,
                    "identifier": trimmed(vals[10] as? String, 120) as Any,
                    "group": item.group as Any, "modal": modal, "web": web,
                ]
                if enrich {
                    node["titleElement"] = titleElementLabel(AX.element(vals[11])) as Any
                    let rowLike = (role.map { ROW_ROLES.contains($0) } ?? false) || subrole == "AXOutlineRow"
                    let unnamed = cleanLabel(title) == nil && cleanLabel(desc) == nil
                    node["contentLabel"] = (rowLike && unnamed ? contentLabel(item.el, deadline: deadline) : nil) as Any
                }
                nodes.append(node)
            }
            if item.depth < depthMax && role != "AXMenuBar" {
                let kids = AX.children(item.el, limit: 500)
                if kids.count >= 500 { truncated = true }
                let group = groupForChildren(role: role, title: title, desc: desc, inherited: item.group)
                for c in kids.reversed() {
                    stack.append(AXVisit(el: c, depth: item.depth + 1, parent: myRef, group: group, modal: modal, web: web))
                }
            }
        }
    }
    if nodes.isEmpty && visited <= 1 && truncated {
        throw HelperError("AX_TIMEOUT", "the application did not answer accessibility queries in time")
    }
    let sid = Snapshots.add(elements)
    var app: [String: Any] = ["pid": Int(pid), "bundleId": running.bundleIdentifier as Any, "name": running.localizedName as Any]
    var result: [String: Any] = ["snapshotId": sid, "nodes": nodes, "truncated": truncated]
    if enrich {
        app["lang"] = appLanguage(running) as Any
        result["window"] = rootWindowJSON(root, pid: pid)
        result["texts"] = texts
    }
    result["app"] = app
    return result
}

// MARK: - ax_action verify (protocol 2)

/// What the caller's snapshot showed. Every text field is compared (absent or
/// null means the element must have none) after verifyText: NFC, clipped to the
/// snapshot's limit, whitespace-trimmed.
struct VerifySpec {
    let pid: Int
    let role: String
    let subrole: String
    let title: String
    let description: String
    let help: String
    let identifier: String
}

/// The target as it is right now, read immediately before the press.
struct VerifyFacts {
    var pid: Int? = nil
    var frontmostPid: Int? = nil
    var role: String? = nil
    var subrole: String? = nil
    var title: String? = nil
    var description: String? = nil
    var help: String? = nil
    var identifier: String? = nil
    var enabled: Bool? = nil
    var secure = false
    var canPress = false
    /// Roles between the element and its window, nearest first (the window excluded).
    var ancestorRoles: [String] = []
    var windowSubrole: String? = nil
    var windowModal = false
    var focusedWindowIsSheet = false
    var inFocusedWindow = false
    var windowHasSheet = false
}

/// What verifyText trims: .whitespacesAndNewlines plus U+FEFF. The same set as
/// protocol.js (JavaScript's \s plus U+0085), and a superset of the
/// String.prototype.trim the Neural Interface applies to the snapshot values it
/// sends, so a label with a BOM at one end still verifies.
let VERIFY_TRIM = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))

/// NFC, the first `limit` Characters (the unit the snapshot clips in), trimmed.
func verifyText(_ s: String?, _ limit: Int) -> String {
    guard let s = s else { return "" }
    return String(nfc(s).prefix(limit)).trimmingCharacters(in: VERIFY_TRIM)
}

/// `verify` is only accepted with press; malformed → BAD_ARGS (protocol.js normalizeVerify).
func parseVerify(_ a: Args, action: String) throws -> VerifySpec? {
    guard a.has("verify") else { return nil }
    guard let d = a.dict("verify") else { throw HelperError("BAD_ARGS", "verify must be an object") }
    guard action == "press" else { throw HelperError("BAD_ARGS", "verify is only allowed with press", ["action": action]) }
    guard let pid = Args.num(d["pid"]).map(toInt), pid > 0 else { throw HelperError("BAD_ARGS", "verify.pid is required") }
    guard let role = d["role"] as? String, !verifyText(role, 200).isEmpty else { throw HelperError("BAD_ARGS", "verify.role is required") }
    func text(_ key: String, _ limit: Int) throws -> String {
        guard let v = d[key], !(v is NSNull) else { return "" }
        guard let s = v as? String else { throw HelperError("BAD_ARGS", "verify.\(key) must be a string or null", ["field": key]) }
        return verifyText(s, limit)
    }
    return VerifySpec(
        pid: pid, role: verifyText(role, 200), subrole: try text("subrole", 200), title: try text("title", 200),
        description: try text("description", 200), help: try text("help", 200), identifier: try text("identifier", 120))
}

/// Pure (covered by --self-test): the first check that no longer holds, or nil.
/// Same order and field names as protocol.js compareVerify.
func verifyCompare(_ want: VerifySpec, _ f: VerifyFacts) -> String? {
    if f.pid != want.pid { return "pid" }
    if f.frontmostPid != want.pid { return "frontmost" }
    if verifyText(f.role, 200) != want.role { return "role" }
    if verifyText(f.subrole, 200) != want.subrole { return "subrole" }
    if verifyText(f.title, 200) != want.title { return "title" }
    if verifyText(f.description, 200) != want.description { return "description" }
    if verifyText(f.help, 200) != want.help { return "help" }
    if verifyText(f.identifier, 120) != want.identifier { return "identifier" }
    if f.enabled != true { return "enabled" }
    if f.secure { return "secure" }
    if !f.canPress { return "press" }
    if f.ancestorRoles.contains("AXSheet") { return "sheet" }
    if f.ancestorRoles.contains("AXPopover") { return "popover" }
    if let s = f.windowSubrole, DIALOG_SUBROLES.contains(s) { return "dialog" }
    if f.windowModal { return "modal" }
    if f.focusedWindowIsSheet { return "sheet" }
    if !f.inFocusedWindow { return "window" }
    if f.windowHasSheet { return "sheet" }
    return nil
}

/// Reads the facts verifyCompare needs: the element, its ancestors up to the
/// window, the window, and the app's focused window.
func verifyFacts(_ el: AXUIElement) -> VerifyFacts {
    var f = VerifyFacts()
    f.frontmostPid = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) }
    guard let pid = AX.pid(el) else { return f }
    f.pid = Int(pid)
    let (err, v) = AX.multi(el, ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXHelp", "AXIdentifier", "AXEnabled", "AXWindow"])
    guard err == .success else { return f }
    f.role = v[0] as? String
    f.subrole = v[1] as? String
    f.title = v[2] as? String
    f.description = v[3] as? String
    f.help = v[4] as? String
    f.identifier = v[5] as? String
    f.enabled = (v[6] as? NSNumber)?.boolValue
    f.secure = f.subrole == "AXSecureTextField" || f.role == "AXSecureTextField"
    f.canPress = AX.actions(el).contains("AXPress")
    var cur = AX.element(AX.copy(el, "AXParent").1)
    var hops = 0
    while let c = cur, hops < 64 {
        guard let r = AX.string(c, "AXRole"), r != "AXWindow", r != "AXApplication" else { break }
        f.ancestorRoles.append(r)
        cur = AX.element(AX.copy(c, "AXParent").1)
        hops += 1
    }
    let win = AX.element(v[7])
    if let w = win {
        let (we, wv) = AX.multi(w, ["AXSubrole", "AXModal"])
        if we == .success {
            f.windowSubrole = wv[0] as? String
            f.windowModal = (wv[1] as? NSNumber)?.boolValue ?? false
        }
    }
    let appEl = AXUIElementCreateApplication(pid)
    if let fw = AX.element(AX.copy(appEl, "AXFocusedWindow").1) {
        f.focusedWindowIsSheet = AX.string(fw, "AXRole") == "AXSheet"
        if let w = win { f.inFocusedWindow = CFEqual(fw, w) }
        f.windowHasSheet = AX.children(fw, limit: 500).contains { AX.string($0, "AXRole") == "AXSheet" }
    }
    return f
}

func verifyTarget(_ el: AXUIElement, _ want: VerifySpec, probe: Probe) throws {
    if let field = verifyCompare(want, verifyFacts(el)) {
        throw HelperError("TARGET_CHANGED", "the target is no longer what the snapshot showed (\(field)); nothing was pressed",
                          ["field": field, "probe": probe.json])
    }
}

/// Order: preInput → lookup (REF_EXPIRED) → probeElement → matchGuard on a fresh
/// probe (window title re-read) → password-field check → verifyTarget → the
/// action. Nothing runs between verifyTarget and AXPerformAction.
func cmdAxAction(_ a: Args) throws -> Any {
    try preInput()
    AX.prepare()
    guard let sid = a.string("snapshotId"), let ref = a.string("ref") else { throw HelperError("BAD_ARGS", "snapshotId and ref are required") }
    let action = a.string("action") ?? "press"
    let verify = try parseVerify(a, action: action)
    guard let el = Snapshots.element(sid, ref) else {
        throw HelperError("REF_EXPIRED", "\(sid)/\(ref) is not in the last 4 snapshots", ["snapshotId": sid, "ref": ref])
    }
    let probe = probeElement(el)
    if probe.axError == .invalidUIElement { throw HelperError("REF_EXPIRED", "\(sid)/\(ref) no longer exists", ["snapshotId": sid, "ref": ref]) }
    if probe.axError == .cannotComplete { throw axFail(probe.axError, "ax_action") }
    if let e = matchGuard(probe, Config.guardCfg, context: "ax_action") { throw e }
    if action == "set_value" && Config.guardCfg.secureField {
        if probe.secure { throw HelperError("SECURE_FIELD", "refusing to set the value of a password field", ["probe": probe.json]) }
        if !probe.readable && IsSecureEventInputEnabled() {
            throw HelperError("SECURE_FIELD", "secure input is active and the target can't be read", ["probe": probe.json])
        }
    }
    if let want = verify { try verifyTarget(el, want, probe: probe) }
    var err: AXError
    switch action {
    case "press", "toggle":
        err = AX.perform(el, "AXPress")
    case "focus":
        err = AX.setBool(el, "AXFocused", true)
    case "set_value":
        guard a.has("value") else { throw HelperError("BAD_ARGS", "value is required for set_value") }
        let v = a.raw["value"]!
        if let s = v as? String {
            err = AXUIElementSetAttributeValue(el, "AXValue" as CFString, s as CFString)
        } else if let n = v as? NSNumber {
            err = AXUIElementSetAttributeValue(el, "AXValue" as CFString, n)
        } else {
            throw HelperError("BAD_ARGS", "value must be a string, number or boolean")
        }
    case "expand", "collapse":
        let on = action == "expand"
        err = AX.setBool(el, "AXExpanded", on)
        if err != .success { err = AX.setBool(el, "AXDisclosing", on) }
    case "select":
        err = AX.setBool(el, "AXSelected", true)
        if err != .success { err = AX.perform(el, "AXPick") }
    case "scroll_into_view":
        err = AX.perform(el, "AXScrollToVisible")
    case "raise":
        if probe.role == "AXWindow" {
            err = AX.perform(el, "AXRaise")
        } else if let win = AX.element(AX.copy(el, "AXWindow").1) {
            err = AX.perform(win, "AXRaise")
        } else {
            err = .actionUnsupported
        }
    case "show_menu":
        err = AX.perform(el, "AXShowMenu")
    default:
        throw HelperError("BAD_ARGS", "unknown action '\(action)'")
    }
    if err != .success { throw axFail(err, "ax_action \(action)") }
    return ["target": probe.json]
}

// MARK: - Configure, permissions, power

func cmdConfigure(_ a: Args) throws -> Any {
    var g = Config.guardCfg
    var m = Config.monitor
    var i = Config.input
    if let d = a.dict("guard") {
        try parseGuard(d, into: &g)
    } else if a.has("guard") {
        throw HelperError("BAD_ARGS", "guard must be an object")
    }
    if let d = a.dict("monitor") {
        if let b = Args.bool(d["armed"]) { m.armed = b }
        if let b = Args.bool(d["esc"]) { m.esc = b }
        if let b = Args.bool(d["failsafeCorner"]) { m.failsafeCorner = b }
        if let n = Args.num(d["cornerSizePt"]) { m.cornerSizePt = clampDouble(n, 1, 200) }
    }
    if let d = a.dict("input") {
        if let n = Args.num(d["typeChunk"]) { i.typeChunk = clampInt(toInt(n), 1, 20) }
        if let n = Args.num(d["typeDelayMs"]) { i.typeDelayMs = clampDouble(n, 0, 1000) }
        if let n = Args.num(d["moveSteps"]) { i.moveSteps = clampInt(toInt(n), 1, 200) }
    }
    Config.commit(g, m, i)
    Input.shared.setLatched(false)
    DispatchQueue.main.async { Monitor.ensureInstalled() }
    return [String: Any]()
}

func cmdRequestPermission(_ a: Args) throws -> Any {
    switch a.string("kind") {
    case "screen":
        _ = onMain { CGRequestScreenCaptureAccess() }
    case "accessibility":
        _ = onMain { AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
    default:
        throw HelperError("BAD_ARGS", "kind must be 'screen' or 'accessibility'")
    }
    return permissionsJSON()
}

enum Power {
    private static let lock = NSLock()
    private static var assertion: IOPMAssertionID = 0

    static func set(_ hold: Bool) throws {
        lock.lock()
        defer { lock.unlock() }
        if hold && assertion == 0 {
            var id: IOPMAssertionID = 0
            let r = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                IOPMAssertionLevel(kIOPMAssertionLevelOn), "SynaBun computer use" as CFString, &id)
            guard r == kIOReturnSuccess else { throw HelperError("INTERNAL", "could not hold the display awake (IOReturn \(r))") }
            assertion = id
        } else if !hold && assertion != 0 {
            IOPMAssertionRelease(assertion)
            assertion = 0
        }
    }

    static func release() { try? set(false) }
}

// MARK: - Global monitor (user input, emergency stop)

enum Monitor {
    private static var mouseMonitor: Any?
    private static var keyMonitor: Any?
    private static var wanted = false
    private static var inCorner = false
    private static var lastEmitNs: UInt64 = 0

    /// Installed on the first `configure`, never at launch. The keyboard monitor needs
    /// Accessibility and is only added once it's granted (no prompt is ever triggered).
    static func ensureInstalled() {
        wanted = true
        if mouseMonitor == nil {
            let mask: NSEvent.EventTypeMask = [
                .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
                .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
            ]
            mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { handle($0) }
        }
        if keyMonitor == nil && AXIsProcessTrusted() {
            keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { handle($0) }
        }
    }

    static func permissionsChanged() { if wanted { ensureInstalled() } }

    private static func handle(_ ev: NSEvent) {
        guard let cg = ev.cgEvent else { return }
        if cg.getIntegerValueField(.eventSourceUserData) == SYNB_STAMP { return } // ours
        let loc = cg.location
        let now = nowNs()
        let isKey = ev.type == .keyDown
        if isKey || ev.type == .leftMouseDown || ev.type == .rightMouseDown || ev.type == .otherMouseDown {
            Input.shared.noteUserInterrupt(now) // stops an in-progress `type`
        }
        let m = Config.monitor
        if m.armed {
            if m.esc && isKey && ev.keyCode == 53 && !ev.isARepeat { emergencyStop("esc") }
            if m.failsafeCorner && !isKey {
                let s = CGFloat(m.cornerSizePt)
                let inside = loc.x >= 0 && loc.y >= 0 && loc.x < s && loc.y < s
                if inside && !inCorner { emergencyStop("failsafe_corner") }
                inCorner = inside
            }
        } else {
            inCorner = false
        }
        if now &- lastEmitNs >= 250_000_000 { // ≤ 4 events per second
            lastEmitNs = now
            let kind = isKey ? "key" : (ev.type == .scrollWheel ? "scroll" : "mouse")
            emitEvent("user_input", ["kind": kind, "x": Double(loc.x), "y": Double(loc.y)])
        }
    }

    private static func emergencyStop(_ reason: String) {
        Input.shared.setLatched(true)
        Input.shared.abort()
        emitEvent("emergency_stop", ["reason": reason])
    }
}

// MARK: - Commands

enum Commands {
    static func execute(_ cmd: String, _ a: Args) throws -> Any {
        switch cmd {
        case "permissions": return permissionsJSON()
        case "request_permission": return try cmdRequestPermission(a)
        case "displays": return Displays.list()
        case "session_state": return sessionStateJSON()
        case "configure": return try cmdConfigure(a)
        case "screenshot": return try cmdScreenshot(a)
        case "capture_rect": return try cmdCaptureRect(a)
        case "cursor": return pointJSON(cursorLocation())
        case "move": return try cmdMove(a)
        case "click": return try cmdClick(a)
        case "mouse_down": return try cmdMouseDown(a)
        case "mouse_up": return try cmdMouseUp(a)
        case "drag": return try cmdDrag(a)
        case "scroll": return try cmdScroll(a)
        case "type": return try cmdType(a)
        case "key": return try cmdKey(a, hold: false)
        case "hold_key": return try cmdKey(a, hold: true)
        case "probe_point":
            try requireTrusted()
            let p = try a.point()
            try requireOnScreen(p)
            return try probeAt(p).json
        case "probe_focus":
            try requireTrusted()
            return try probeFocus().json
        case "apps": return cmdApps()
        case "windows": return cmdWindows(a)
        case "open_app": return try cmdOpenApp(a)
        case "focus_app": return try cmdFocusApp(a)
        case "ax_snapshot": return try cmdAxSnapshot(a)
        case "ax_action": return try cmdAxAction(a)
        case "abort":
            Input.shared.abort()
            return [String: Any]()
        case "panic":
            Input.shared.panic()
            return [String: Any]()
        case "power":
            guard let hold = a.bool("holdDisplayAwake") else { throw HelperError("BAD_ARGS", "holdDisplayAwake is required") }
            try Power.set(hold)
            return [String: Any]()
        case "shutdown": return [String: Any]()
        default: throw HelperError("UNSUPPORTED", "unknown command '\(cmd)'")
        }
    }
}

enum Dispatcher {
    static let actions = DispatchQueue(label: "ai.synabun.desktop.actions", qos: .userInitiated)
    static let bypass: Set<String> = ["abort", "panic", "permissions", "session_state", "cursor", "shutdown"]

    static func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            hlog("warn", "ignored a stdin line that is not a JSON object")
            return
        }
        let id = obj["id"]
        guard let cmd = obj["cmd"] as? String else {
            replyError(id, HelperError("BAD_ARGS", "cmd is required"))
            return
        }
        let args = Args(obj["args"] as? [String: Any] ?? [:])
        if bypass.contains(cmd) { run(id, cmd, args) } else { actions.async { run(id, cmd, args) } }
    }

    static func run(_ id: Any?, _ cmd: String, _ args: Args) {
        autoreleasepool {
            do {
                reply(id, result: try Commands.execute(cmd, args))
            } catch let e as HelperError {
                replyError(id, e)
            } catch {
                replyError(id, HelperError("INTERNAL", String(describing: error)))
            }
        }
        if cmd == "shutdown" { Lifecycle.exit(reason: "shutdown") }
    }
}

// MARK: - Lifecycle

enum Lifecycle {
    private static let lock = NSLock()
    private static var exiting = false
    private static var lastPerms: [String: Bool] = [:]
    private static var lastLocked: Bool? = nil
    private static var displaysWork: DispatchWorkItem?
    private static var timer: DispatchSourceTimer?
    private static var signalSources: [DispatchSourceSignal] = []

    /// Releases what we hold (tracked state only) and the power assertion, then exits.
    static func exit(reason: String, code: Int32 = 0) {
        lock.lock()
        if exiting { lock.unlock(); return }
        exiting = true
        lock.unlock()
        Input.shared.abort()
        Power.release()
        Darwin.exit(code)
    }

    static func emitReady() {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let hash = ProcessInfo.processInfo.environment["SYNABUN_DESKTOP_SOURCE_HASH"]
        var captureInRect = false
        if #available(macOS 15.2, *) { captureInRect = true }
        emitEvent("ready", [
            "protocol": PROTOCOL_VERSION, "version": HELPER_VERSION,
            "sourceHash": ((hash?.isEmpty ?? true) ? nil : hash) as Any,
            "pid": Int(getpid()), "arch": HELPER_ARCH, "os": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
            "features": [
                "sck": true, "captureInRect": captureInRect, "monitor": "nsevent",
                "axVerify": true, "guardPrefixes": true, "axEnrich": true,
            ],
        ])
    }

    static func setLocked(_ locked: Bool) { // main thread
        if lastLocked == locked { return }
        lastLocked = locked
        emitEvent("screen_lock", ["locked": locked])
    }

    static func installObservers() {
        for sig in [SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            src.setEventHandler { Lifecycle.exit(reason: "signal \(sig)") }
            src.resume()
            signalSources.append(src)
        }

        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in setLocked(true) }
        dnc.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in setLocked(false) }

        CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
            if flags.contains(.beginConfigurationFlag) { return }
            DispatchQueue.main.async { Lifecycle.displaysChanged() }
        }, nil)

        lastPerms = permissionFlags()
        lastLocked = sessionInfo().locked
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler {
            if getppid() == 1 { Lifecycle.exit(reason: "parent exited") }
            let perms = permissionFlags()
            if perms != lastPerms {
                lastPerms = perms
                emitEvent("permissions_changed", ["permissions": permissionsJSON()])
                Monitor.permissionsChanged()
            }
            setLocked(sessionInfo().locked)
        }
        t.resume()
        timer = t
    }

    static func displaysChanged() { // main thread, debounced
        displaysWork?.cancel()
        let work = DispatchWorkItem { emitEvent("displays_changed", ["displays": Displays.list()]) }
        displaysWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    static func startReader() {
        let t = Thread {
            while let line = readLine(strippingNewline: true) {
                if line.isEmpty { continue }
                autoreleasepool { Dispatcher.handle(line) }
            }
            Lifecycle.exit(reason: "stdin closed")
        }
        t.name = "synabun-desktop.stdin"
        t.stackSize = 1 << 20
        t.start()
    }
}

// MARK: - Self-test (no screen access)

enum SelfTest {
    static func run() -> (Bool, [String: Any]) {
        var results: [[String: Any]] = []
        var allOk = true
        func check(_ name: String, _ ok: Bool, _ detail: String = "") {
            if !ok { allOk = false }
            results.append(["name": name, "ok": ok, "detail": detail])
        }
        func combo(_ s: String) -> KeyCombo? { try? parseCombo(s, layout: nil) }
        func comboCheck(_ s: String, _ mods: [Mod], _ code: CGKeyCode?, printable: Bool? = nil) {
            guard let c = combo(s) else { return check("combo \(s)", false, "did not parse") }
            var ok = Set(c.mods) == Set(mods) && c.mods.count == mods.count && c.keyCode == code
            if let p = printable { ok = ok && c.needsSecureCheck == p }
            check("combo \(s)", ok, "mods=\(c.mods.map { $0.rawValue }) key=\(c.keyCode.map { String($0) } ?? "nil") secure=\(c.needsSecureCheck)")
        }

        // key combos / keymap (ANSI fallback — independent of the machine's layout)
        comboCheck("cmd+shift+t", [.cmd, .shift], 0x11, printable: false)
        comboCheck("cmd+T", [.cmd, .shift], 0x11)
        comboCheck("Return", [], 0x24, printable: false)
        comboCheck("ctrl+alt+Delete", [.ctrl, .alt], 0x75)
        comboCheck("super+space", [.cmd], 0x31, printable: false)
        comboCheck("space", [], 0x31, printable: true)
        comboCheck("shift+a", [.shift], 0x00, printable: true)
        comboCheck("cmd+v", [.cmd], 0x09, printable: true)
        comboCheck("cmd+c", [.cmd], 0x08, printable: false)
        comboCheck("cmd++", [.cmd, .shift], 0x18)
        comboCheck("Page_Down", [], 0x79)
        comboCheck("BackSpace", [], 0x33)
        comboCheck("Esc", [], 0x35)
        comboCheck("F12", [], 0x6F)
        comboCheck("F20", [], 0x5A)
        comboCheck("command+option+Escape", [.cmd, .alt], 0x35)
        comboCheck("shift", [.shift], nil, printable: false)
        comboCheck("ctrl+bracketleft", [.ctrl], 0x21)
        comboCheck("question", [.shift], 0x2C, printable: true)
        for bad in ["", "cmd+", "cmd+nope", "a+b", "hyper+x", "++x"] {
            check("combo rejects '\(bad)'", combo(bad) == nil)
        }
        let layout: LayoutMap = ["a": (0x0C, 0), "A": (0x0C, 2), "q": (0x00, 0)] // AZERTY-ish
        let fr = try? parseCombo("cmd+a", layout: layout)
        check("combo follows the layout map", fr?.keyCode == 0x0C, "key=\(fr?.keyCode.map { String($0) } ?? "nil")")

        // fit math
        let f1 = fitSize(width: 1470, height: 956, fitW: 1280, fitH: 800, scale: 2)
        check("fit 1470x956@2 into 1280x800", f1.w == 1230 && f1.h == 800, "\(f1.w)x\(f1.h)")
        let f2 = fitSize(width: 1470, height: 956, fitW: 4000, fitH: 4000, scale: 2)
        check("fit never exceeds native pixels", f2.w == 2940 && f2.h == 1912, "\(f2.w)x\(f2.h)")
        let f3 = fitSize(width: 1920, height: 1080, fitW: 1024, fitH: 768, scale: 1)
        check("fit 1920x1080@1 into 1024x768", f3.w == 1024 && f3.h == 576, "\(f3.w)x\(f3.h)")
        let f4 = fitSize(width: 300, height: 200, fitW: 1568, fitH: 1568, scale: 2)
        check("fit region upscales only to backing scale", f4.w == 600 && f4.h == 400, "\(f4.w)x\(f4.h)")

        // scroll sign conversion
        let s1 = scrollWheelDeltas(dx: 0, dy: 3)
        check("scroll dy>0 (down) → wheel1 < 0", s1.wheel1 == -3 && s1.wheel2 == 0)
        let s2 = scrollWheelDeltas(dx: -2, dy: -1)
        check("scroll dx<0 (left) → wheel2 > 0, dy<0 (up) → wheel1 > 0", s2.wheel1 == 1 && s2.wheel2 == 2)
        let s3 = scrollWheelDeltas(dx: Int.min, dy: Int.max)
        check("scroll deltas never trap", s3.wheel1 == -1_000_000 && s3.wheel2 == 1_000_000)
        check("number → int never traps", toInt(1e300) == 1_000_000_000_000_000 && toInt(-.infinity) == 0 && toInt(.nan) == 0 && toInt(2.5) == 3)

        // text segmentation
        let segs = segmentText("ab\ncd\te\r\nf", chunk: 20)
        let shape = segs.map { seg -> String in
            switch seg { case .text(let s): return "t:\(s)"; case .key(let c, _): return "k:\(c)" }
        }
        check("segment newlines/tabs", shape == ["t:ab", "k:36", "t:cd", "k:48", "t:e", "k:36", "t:f"], shape.joined(separator: ","))
        check("segment utf16 accounting", segs.reduce(0) { $0 + $1.utf16Count } == "ab\ncd\te\r\nf".utf16.count)
        let emoji = String(repeating: "👩‍👩‍👧", count: 4) // 8 UTF-16 units each
        let esegs = segmentText(emoji, chunk: 20)
        let noSplit = esegs.allSatisfy { seg in
            if case .text(let s) = seg { return s.utf16.count <= 20 && s.count >= 1 } else { return false }
        }
        check("segment keeps grapheme clusters whole", noSplit && esegs.count == 2, "\(esegs.count) chunks")
        check("segment chunk size", segmentText(String(repeating: "x", count: 45), chunk: 20).count == 3)

        // guard matching
        var g = GuardConfig()
        g.blocked = [
            BlockRule(id: "pw", bundleIds: ["com.1password.1password"], nameRe: nil, windowTitleRe: nil, reason: "password manager"),
            BlockRule(id: "bank", bundleIds: [], nameRe: nil, windowTitleRe: try? NSRegularExpression(pattern: "chase|wells fargo", options: [.caseInsensitive]), reason: "banking"),
            BlockRule(id: "term", bundleIds: [], nameRe: try? NSRegularExpression(pattern: "^terminal$", options: [.caseInsensitive]), windowTitleRe: nil, reason: "shell"),
        ]
        g.protectedWindows = [ProtectRule(index: 0, bundleIds: ["com.apple.Safari"], titleRe: try! NSRegularExpression(pattern: "keychain", options: [.caseInsensitive]), reason: "secrets")]
        var p = Probe()
        p.bundleId = "COM.1password.1PASSWORD"
        check("guard blocks by bundle id (case-insensitive)", matchGuard(p, g, context: "t")?.code == "BLOCKED_APP")
        p = Probe(); p.bundleId = "com.google.Chrome"; p.app = "Google Chrome"; p.windowTitle = "Chase Online"
        check("guard blocks by window title", matchGuard(p, g, context: "t")?.code == "BLOCKED_APP")
        p = Probe(); p.app = "Terminal"
        check("guard blocks by app name", matchGuard(p, g, context: "t")?.code == "BLOCKED_APP")
        p = Probe(); p.bundleId = "com.apple.Safari"; p.app = "Safari"; p.windowTitle = "Keychain Access Help"
        check("guard protects matching windows", matchGuard(p, g, context: "t")?.code == "PROTECTED_WINDOW")
        p = Probe(); p.bundleId = "com.apple.TextEdit"; p.app = "TextEdit"; p.windowTitle = "Keychain notes"
        check("guard protected rule is scoped to its bundle ids", matchGuard(p, g, context: "t") == nil)
        p = Probe(); p.bundleId = "com.apple.Safari"; p.app = "Safari"
        check("guard ignores unknown titles", matchGuard(p, g, context: "t") == nil)
        check("guard rejects invalid regex", (try? compileRegex("(", field: "x")) == nil)
        check("guard treats empty regex as absent", ((try? compileRegex("", field: "x")) ?? nil) == nil)

        // protocol 2 guards: bundle-id prefixes, app names, NFC
        func re(_ pattern: String) -> NSRegularExpression? { (try? compileRegex(pattern, field: "t")) ?? nil }
        func matchedBy(_ e: HelperError?) -> String? { (e?.details?["rule"] as? [String: Any])?["matched"] as? String }
        let webAppId = "com.apple.Safari.WebApp.7EF0F3F3-27FA-4C9A-9D7C-74020761B996"
        var gp = GuardConfig()
        gp.blocked = [BlockRule(id: "webapps", bundleIds: [], bundlePrefixes: ["com.apple.Safari.WebApp."], nameRe: nil, windowTitleRe: nil, reason: "web apps")]
        p = Probe(); p.bundleId = webAppId; p.app = "SynaBun"
        check("guard blocks by bundle prefix", matchedBy(matchGuard(p, gp, context: "t")) == "bundlePrefix")
        p = Probe(); p.bundleId = "COM.APPLE.SAFARI.WEBAPP.X1"
        check("bundle prefixes compare case-insensitively", matchGuard(p, gp, context: "t")?.code == "BLOCKED_APP")
        p = Probe(); p.bundleId = "com.apple.Safari"; p.app = "Safari"
        check("a prefix never matches the bare browser id", matchGuard(p, gp, context: "t") == nil)
        p = Probe(); p.bundleId = "com.apple.Safari.WebApp"
        check("a prefix needs its trailing dot", matchGuard(p, gp, context: "t") == nil)

        var gw = GuardConfig()
        gw.protectedWindows = [ProtectRule(
            index: 0, id: "synabun-ui", bundleIds: ["com.apple.Safari"], bundlePrefixes: ["com.apple.Safari.WebApp."],
            titleRe: re("Neural Memory Interface|SynaBun|SynApp|Neural Interface"),
            appNameRe: re("^(SynaBun|SynApp|Neural (Memory )?Interface)\\b"), reason: "SynaBun")]
        p = Probe(); p.bundleId = webAppId; p.app = "SynaBun"; p.windowTitle = "Restarting..."
        let byName = matchGuard(p, gw, context: "t")
        check("web app protected by its app name, whatever the title", byName?.code == "PROTECTED_WINDOW" && matchedBy(byName) == "appName")
        p.windowTitle = nil
        check("web app protected by its app name with no title", matchGuard(p, gw, context: "t")?.code == "PROTECTED_WINDOW")
        p = Probe(); p.bundleId = "com.apple.Safari.WebApp.ABC"; p.app = "Docs"; p.windowTitle = "SynaBun"
        check("web app protected by its title", matchedBy(matchGuard(p, gw, context: "t")) == "title")
        p = Probe(); p.bundleId = "com.apple.Safari"; p.app = "Safari"; p.windowTitle = "Restarting..."
        check("Safari itself is not protected by the app-name rule", matchGuard(p, gw, context: "t") == nil)
        p = Probe(); p.bundleId = "com.apple.TextEdit"; p.app = "SynaBun"; p.windowTitle = "SynaBun notes"
        check("appNameRe is scoped like titleRe", matchGuard(p, gw, context: "t") == nil)

        var gs = GuardConfig()
        gs.protectedWindows = [ProtectRule(index: 0, bundleIds: ["com.apple.systempreferences", "com.apple.Settings"],
                                           titleRe: re("^(?:Câmera|Fotos)$|Privacidade e Segurança|Acesso Total ao Disco"), reason: "settings")]
        p = Probe(); p.bundleId = "com.apple.systempreferences"; p.app = "Ajustes do Sistema"; p.windowTitle = "Privacidade e Seguranc\u{0327}a"
        check("protected by a pt title in NFD", matchGuard(p, gs, context: "t")?.code == "PROTECTED_WINDOW")
        p.windowTitle = "Ca\u{0302}mera"
        check("protected by an anchored pt name in NFD", matchGuard(p, gs, context: "t")?.code == "PROTECTED_WINDOW")
        p.windowTitle = "Câmera lenta"
        check("anchored names match whole titles only", matchGuard(p, gs, context: "t") == nil)
        p.windowTitle = "Aparência"
        check("an unprotected pt pane passes", matchGuard(p, gs, context: "t") == nil)
        var gd = GuardConfig()
        gd.protectedWindows = [ProtectRule(index: 0, bundleIds: [], titleRe: re("Seguranc\u{0327}a"), reason: "")]
        p = Probe(); p.windowTitle = "Privacidade e Segurança"
        check("an NFD pattern matches an NFC title", matchGuard(p, gd, context: "t")?.code == "PROTECTED_WINDOW")

        var pg = GuardConfig()
        let parsed = (try? parseGuard([
            "blockedApps": [["id": "w", "bundlePrefixes": ["com.apple.Safari.WebApp."]]],
            "protectedWindows": [["id": "ui", "appNameRe": "^SynaBun\\b", "bundlePrefixes": ["com.google.Chrome.app."]]],
        ], into: &pg)) != nil
        check("parseGuard reads bundlePrefixes and appNameRe", parsed && pg.blocked.first?.bundlePrefixes == ["com.apple.Safari.WebApp."]
              && pg.protectedWindows.first?.appNameRe != nil && pg.protectedWindows.first?.titleRe == nil && pg.protectedWindows.first?.id == "ui")
        for bad in ["com.apple.Safari", "com.", ".com.apple.", "com..apple.", "com apple.", ""] {
            var gb = GuardConfig()
            check("parseGuard rejects the prefix '\(bad)'", (try? parseGuard(["blockedApps": [["id": "x", "bundlePrefixes": [bad]]]], into: &gb)) == nil)
        }
        var gn = GuardConfig()
        check("parseGuard needs titleRe or appNameRe", (try? parseGuard(["protectedWindows": [["bundleIds": ["com.x.y"]]]], into: &gn)) == nil)

        // group labels (never a window title)
        check("group of a labelled container", groupForChildren(role: "AXOutline", title: nil, desc: " Barra\nlateral ", inherited: "toolbar") == "outline Barra lateral")
        check("group of a bare toolbar", groupForChildren(role: "AXToolbar", title: nil, desc: nil, inherited: nil) == "toolbar")
        check("an unlabelled group inherits", groupForChildren(role: "AXGroup", title: " ", desc: nil, inherited: "sheet") == "sheet")
        check("a window is never a group", groupForChildren(role: "AXWindow", title: "Secret.txt", desc: nil, inherited: nil) == nil)
        check("groups are clipped to 60", groupForChildren(role: "AXGroup", title: String(repeating: "x", count: 100), desc: nil, inherited: nil)?.count == 60)

        // ax_action verify: the decision, without AX
        let want = VerifySpec(pid: 42, role: "AXButton", subrole: "", title: "Voltar", description: "", help: "Go back", identifier: "back")
        var facts = VerifyFacts()
        facts.pid = 42; facts.frontmostPid = 42; facts.role = "AXButton"; facts.title = " Voltar "; facts.help = "Go back"
        facts.identifier = "back"; facts.enabled = true; facts.canPress = true; facts.inFocusedWindow = true
        facts.windowSubrole = "AXStandardWindow"; facts.ancestorRoles = ["AXGroup", "AXToolbar"]
        check("verify passes an unchanged target", verifyCompare(want, facts) == nil, verifyCompare(want, facts) ?? "")
        func changed(_ label: String, _ field: String, _ mutate: (inout VerifyFacts) -> Void) {
            var f = facts
            mutate(&f)
            let got = verifyCompare(want, f)
            check("verify: \(label) → \(field)", got == field, got ?? "nil")
        }
        changed("other process", "pid") { $0.pid = 43 }
        changed("app in the background", "frontmost") { $0.frontmostPid = 7 }
        changed("role", "role") { $0.role = "AXLink" }
        changed("subrole", "subrole") { $0.subrole = "AXCloseButton" }
        changed("relabelled", "title") { $0.title = "Apagar" }
        changed("description added", "description") { $0.description = "trash" }
        changed("help removed", "help") { $0.help = nil }
        changed("identifier", "identifier") { $0.identifier = "delete" }
        changed("disabled", "enabled") { $0.enabled = false }
        changed("enabled unknown", "enabled") { $0.enabled = nil }
        changed("secure", "secure") { $0.secure = true }
        changed("no AXPress", "press") { $0.canPress = false }
        changed("inside a sheet", "sheet") { $0.ancestorRoles = ["AXGroup", "AXSheet"] }
        changed("inside a popover", "popover") { $0.ancestorRoles = ["AXPopover"] }
        changed("dialog window", "dialog") { $0.windowSubrole = "AXSystemDialog" }
        changed("modal window", "modal") { $0.windowModal = true }
        changed("focused window is a sheet", "sheet") { $0.focusedWindowIsSheet = true }
        changed("not the focused window", "window") { $0.inFocusedWindow = false }
        changed("a sheet opened over the window", "sheet") { $0.windowHasSheet = true }
        var nfdFacts = facts
        nfdFacts.title = "Seguranc\u{0327}a"
        let nfcWant = VerifySpec(pid: 42, role: "AXButton", subrole: "", title: "Segurança", description: "", help: "Go back", identifier: "back")
        check("verify compares text in NFC", verifyCompare(nfcWant, nfdFacts) == nil)
        let seen = String(repeating: "a", count: 200)
        var longFacts = facts
        longFacts.title = seen + " and more than the snapshot kept"
        let longWant = VerifySpec(pid: 42, role: "AXButton", subrole: "", title: seen, description: "", help: "Go back", identifier: "back")
        check("verify ignores text past the snapshot's limit", verifyCompare(longWant, longFacts) == nil)
        // The whole chain: the snapshot clips (trimmed), the Neural Interface trims
        // (String.prototype.trim) and sends it as verify, the helper re-reads the live label.
        func roundTrip(live: String, sent: String) -> String? {
            guard let want = (try? parseVerify(Args(["verify": ["pid": 42, "role": "AXButton", "title": sent, "help": "Go back", "identifier": "back"]]), action: "press")) ?? nil else { return "parse" }
            var f = facts
            f.title = live
            return verifyCompare(want, f)
        }
        let longLabel = String(repeating: "Mover para o Lixo ", count: 15)
        check("a label longer than 200 verifies against its snapshot copy",
              roundTrip(live: longLabel, sent: trimmed(longLabel, 200)!.trimmingCharacters(in: .whitespaces)) == nil)
        let nfdLong = String(repeating: "e\u{0301}", count: 250)
        check("a decomposed label longer than 200 verifies against its snapshot copy", roundTrip(live: nfdLong, sent: trimmed(nfdLong, 200)!) == nil)
        check("verify trims a BOM the way the Neural Interface does", roundTrip(live: "\u{FEFF}Voltar\u{FEFF}", sent: "Voltar") == nil)
        check("verify still sees a changed long label", roundTrip(live: "x" + longLabel, sent: trimmed(longLabel, 200)!) == "title")
        func verifyArgsError(_ raw: [String: Any], _ action: String) -> String? {
            do { _ = try parseVerify(Args(raw), action: action); return nil } catch let e as HelperError { return e.code } catch { return "?" }
        }
        let okVerify: [String: Any] = ["pid": 42, "role": "AXButton", "title": "Voltar", "subrole": NSNull()]
        check("verify is accepted with press", verifyArgsError(["verify": okVerify], "press") == nil)
        check("verify is refused with toggle", verifyArgsError(["verify": okVerify], "toggle") == "BAD_ARGS")
        check("verify must be an object", verifyArgsError(["verify": "yes"], "press") == "BAD_ARGS")
        check("verify needs a pid", verifyArgsError(["verify": ["role": "AXButton"]], "press") == "BAD_ARGS")
        check("verify needs a role", verifyArgsError(["verify": ["pid": 42]], "press") == "BAD_ARGS")
        check("verify text fields are strings or null", verifyArgsError(["verify": ["pid": 42, "role": "AXButton", "title": 5]], "press") == "BAD_ARGS")
        let spec = (try? parseVerify(Args(["verify": okVerify]), action: "press")) ?? nil
        check("verify normalizes what it was given", spec?.title == "Voltar" && spec?.subrole == "" && spec?.help == "" && spec?.pid == 42)

        // JSON round-trip
        let original: [String: Any] = ["id": 17, "ok": true, "s": "line1\nline2 \"q\" \\ é 👩‍👩‍👧 \u{2028}", "n": 1.5, "a": [1, "x", NSNull()], "nan": Double.nan]
        if let data = encodeJSON(original), let back = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            let str = String(data: data, encoding: .utf8) ?? ""
            let ok = (back["s"] as? String) == (original["s"] as? String) && (back["id"] as? NSNumber)?.intValue == 17
                && (back["ok"] as? Bool) == true && back["nan"] is NSNull && !str.contains("\n")
            check("json round-trip", ok, str)
        } else {
            check("json round-trip", false, "encode failed")
        }
        check("json drops non-finite numbers", encodeJSON(["x": Double.infinity]) != nil)

        return (allOk, ["ok": allOk, "version": HELPER_VERSION, "protocol": PROTOCOL_VERSION, "tests": results])
    }
}

// MARK: - Main

func printLine(_ obj: [String: Any]) {
    if let data = encodeJSON(obj), let s = String(data: data, encoding: .utf8) { print(s) }
}

let arguments = CommandLine.arguments
if arguments.contains("--version") {
    printLine(["version": HELPER_VERSION, "protocol": PROTOCOL_VERSION])
    exit(0)
}
if arguments.contains("--self-test") {
    let (ok, report) = SelfTest.run()
    printLine(report)
    exit(ok ? 0 : 1)
}

signal(SIGPIPE, SIG_IGN) // a dead parent surfaces as a write error, not a kill
signal(SIGINT, SIG_IGN)  // Ctrl+C in the launching terminal: the server owns the shutdown

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
// No App Nap: timers and the event monitor must stay prompt while idle.
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
                                                     reason: "SynaBun desktop control")
Lifecycle.installObservers()
DispatchQueue.main.async {
    Lifecycle.emitReady()
    Lifecycle.startReader()
}
application.run()
withExtendedLifetime(activity) {}
