const GLOBAL_KEY = '__synabunNativeLoopWindowId';

// Per-document identity: unlike sessionStorage, this is not cloned when the
// browser duplicates a tab. Every native automation claim and persisted active
// panel owner in this document uses the same value.
export const nativeLoopWindowId = globalThis[GLOBAL_KEY] || crypto.randomUUID();
globalThis[GLOBAL_KEY] = nativeLoopWindowId;
