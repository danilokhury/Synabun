// ── What the approval flag and dialog say (re-review of 2026-11-11, finding 3). DOM-free, no imports. ──
//
// The server decides (lib/automation-approval.js: the review, its digest, the case); this module only turns its
// answers into the words and the buttons the page shows, so the wording is unit-tested under Node
// (tests/automation-approval-view.test.mjs). `t(key, vars)` is the page's translator (i18n.js).

/** The account a run uses, in words: the profile by name (or id), or the default browser. */
export function accountText(account, t) {
  if (!account) return t('automationApproval.account.unknown');
  if (account.kind === 'morelogin') {
    const profile = account.name ? `${account.name} (${account.envId})` : String(account.envId);
    return account.source === 'group'
      ? t('automationApproval.account.groupProfile', { profile, group: account.groupName || '' })
      : t('automationApproval.account.ownProfile', { profile });
  }
  if (account.connectMode === 'morelogin' && account.envId) {
    return t('automationApproval.account.defaultProfile', { profile: account.name ? `${account.name} (${account.envId})` : String(account.envId) });
  }
  return t('automationApproval.account.defaultBrowser');
}

/** The short profile name for the flag ("<profile>" in "needs your approval to run in <profile>"). */
export function profileLabel(account) {
  if (!account || account.kind !== 'morelogin') return '';
  return account.name || String(account.envId || '');
}

/** What marked it, in words: an agent, an import, a restore. */
export function sourceText(from, t) {
  return t(from === 'import' ? 'automationApproval.from.import' : from === 'restore' ? 'automationApproval.from.restore' : 'automationApproval.from.agent');
}

/**
 * The flag of a marked schedule (`summary`: an entry of GET /api/automation-approvals, or a review), or null.
 * → { tone: 'warn'|'info', short, text }: `short` for a list row, `text` for the editor and the detail.
 */
export function scheduleFlag(summary, t) {
  if (!summary || !summary.marks || (!summary.marks.schedule && !summary.marks.template)) return null;
  const who = summary.marks.schedule ? sourceText(summary.marks.scheduleFrom, t) : sourceText(summary.marks.templateFrom, t);
  const what = summary.marks.schedule && summary.marks.template ? t('automationApproval.what.both')
    : summary.marks.schedule ? t('automationApproval.what.schedule') : t('automationApproval.what.template');
  const profile = profileLabel(summary.account);
  if (summary.case === 'blocked') {
    return { tone: 'warn', short: t('automationApproval.flag.blockedShort', { profile }), text: t('automationApproval.flag.blocked', { who, what, profile }) };
  }
  if (summary.case === 'on-list') {
    return { tone: 'info', short: t('automationApproval.flag.onListShort'), text: t('automationApproval.flag.onList', { who, what, profile }) };
  }
  return { tone: 'info', short: t('automationApproval.flag.noProfileShort'), text: t('automationApproval.flag.noProfile', { who, what }) };
}

/** The flag of a marked template, or null. */
export function templateFlag(template, summary, t) {
  const marked = template?.editedBy === 'agent' || summary?.marks?.template === true;
  if (!marked) return null;
  const who = sourceText(summary?.marks?.templateFrom || template?.unreviewedFrom || 'agent', t);
  return { tone: 'warn', short: t('automationApproval.flag.templateShort'), text: t('automationApproval.flag.template', { who }) };
}

/** What the dialog says will happen after approval, from the review's `afterApproval`. */
export function afterApprovalText(review, t) {
  if (!review) return '';
  if (review.kind === 'template') return t('automationApproval.after.template');
  if (review.afterApproval === 'list') return t('automationApproval.after.groupStillAgent', { group: review.account?.groupName || '' });
  if (review.afterApproval === 'default') return t('automationApproval.after.default');
  return t('automationApproval.after.owner', { profile: profileLabel(review.account) });
}

/** The weekday names the dialog shows for a review's day themes (0 = Sunday), through Intl in the page's locale. */
export function weekdayName(day, locale = 'en') {
  try {
    // 2024-01-07 was a Sunday.
    return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + Number(day))));
  } catch { return String(day); }
}
