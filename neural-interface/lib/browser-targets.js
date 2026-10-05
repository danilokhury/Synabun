/** Enumerate the actual Playwright locator, not CSS querySelectorAll. nth is exact. */
export async function describeLocatorMatches(page, selector, limit = 10) {
  try {
    return await page.locator(selector).evaluateAll((elements, limit) => elements.slice(0, limit).map((el, nth) => ({
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().slice(0, 60),
      ariaLabel: el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      visible: !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'),
      nth,
    })), limit).then(items => items.map(item => ({ ...item, selector })));
  } catch { return []; }
}

/** Heal only exact role/name matches within a discoverable original scope. */
export async function healLocatorByText(page, selector, textHint) {
  if (!textHint || typeof textHint !== 'string' || !selector) return null;
  const parts = selector.split(/\s*>>\s*/);
  const leaf = parts.pop();
  const roleMatch = leaf.match(/^role=(button|link|textbox|combobox|checkbox|radio|tab|menuitem)\b/)
    || leaf.match(/\[role=["'](button|link|textbox|combobox|checkbox|radio|tab|menuitem)["']\]/);
  const tag = leaf.match(/^(button|a|input|textarea|select)(?=[\s.#[:]|$)/)?.[1];
  const role = roleMatch?.[1] || ({ button: 'button', a: 'link', textarea: 'textbox', select: 'combobox' })[tag];
  if (!role) return null;
  // CSS ancestry is not safely inferred by rewriting arbitrary selector strings.
  if (!parts.length && /\s[>+~]?\s*\w/.test(leaf.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, ''))) return null;
  try {
    const scope = parts.length ? page.locator(parts.join(' >> ')) : page;
    const candidates = scope.getByRole(role, { name: textHint, exact: true });
    const count = await candidates.count();
    let found = null;
    for (let i = 0; i < count; i++) {
      const item = candidates.nth(i);
      if (await item.isVisible()) {
        if (found) return null;
        found = item;
      }
    }
    return found;
  } catch { return null; }
}

/** nthMatch is always an index in the complete matching set, including hidden nodes. */
export function validNthMatch(count, nthMatch) {
  return nthMatch === undefined || (Number.isInteger(nthMatch) && nthMatch >= 0 && nthMatch < count);
}

function targetContext(el) {
  const card = el.closest('article,[data-testid="tweet"],[data-urn],[data-item-id]');
  if (!card) return '';
  const id = card.getAttribute('data-urn') || card.getAttribute('data-item-id') || card.getAttribute('data-id') || '';
  const links = [...card.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
    .filter(href => /\/status\/|\/posts\/|\/videos\/|\/jobs\/view\//.test(href || '')).sort();
  return JSON.stringify([id, links]);
}

/** Preserve identity across pacing: a live CSS/nth locator can silently retarget. */
export async function captureTargetIdentity(locator, timeout = 5000) {
  const handle = await locator.elementHandle({ timeout });
  if (!handle) throw new Error('Click target disappeared before preparation.');
  try { return { handle, context: await handle.evaluate(targetContext) }; }
  catch (error) { await handle.dispose().catch(() => {}); throw error; }
}

export async function matchesTargetIdentity(locator, identity, timeout = 5000) {
  try {
    const same = await locator.evaluate((el, original) => el === original && el.isConnected, identity.handle, { timeout });
    return same && await locator.evaluate(targetContext, undefined, { timeout }) === identity.context;
  } catch { return false; }
}
