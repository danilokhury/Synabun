// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — the way from the panel into Settings
// Provider sign-in lives in Settings → OpenCode. ui-settings.js is large, so it
// is loaded only when the user asks for it.
// ─────────────────────────────────────────────────────────────────────────────

// OCP001 is the first control of the "service providers" section.
const PROVIDERS_CONTROL = 'OCP001';

export async function openProviderSettings() {
  try {
    const settings = await import('../ui-settings.js');
    await settings.openSettingsModal({ scrollTo: PROVIDERS_CONTROL });
    return true;
  } catch (err) {
    console.warn('[ocp-v2-settings-link] could not open Settings', err);
    return false;
  }
}
