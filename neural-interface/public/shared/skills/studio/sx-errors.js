// Server failures are translated by code. Unknown codes remain useful diagnostics without leaking server prose.
export function studioErrorText(t, error) {
  const code = error?.code || error?.body?.code;
  const keys = {
    WORKER_BROWSER: 'workerBrowser', GUEST_FORBIDDEN: 'owner', UI_ONLY: 'owner', OWNER_REQUIRED: 'owner',
    WORKERS_NOT_PERMITTED: 'owner', ASSISTANT_CREDENTIAL_REQUIRED: 'owner',
    PAGE_SECRET_REQUIRED: 'pageSession', UI_HEADER_REQUIRED: 'pageSession',
    revision_conflict: 'conflict', draft_conflict: 'conflict', etag_conflict: 'conflict',
    revision_not_found: 'missing', artifact_not_found: 'missing', not_found: 'missing',
    scan_incomplete: 'scanIncomplete', scan_blocked: 'scanBlocked', export_blocked: 'exportBlocked',
    catalog_incomplete: 'catalogIncomplete', source_changed: 'sourceChanged', unsafe_source: 'unsafeSource',
    export_review_required: 'exportReviewRequired', invalid_name: 'invalidName', invalid_format: 'invalidFormat',
    invalid_profile: 'invalidProfile', export_transform_failed: 'exportTransformFailed',
    blob_missing: 'revisionDamaged', blob_corrupt: 'revisionDamaged', revision_corrupt: 'revisionDamaged',
    export_incompatible: 'exportIncompatible', invalid_frontmatter: 'invalidFrontmatter',
    source_disabled: 'sourceDisabled', source_unavailable: 'sourceUnavailable',
  };
  const body = error?.body || error;
  if (code === 'export_blocked' && body?.reason === 'lint') return t('skillsStudio.errors.exportLint', { detail: (body.diagnostics || []).slice(0, 5).map((d) => [d.file, d.line, d.message].filter(Boolean).join(': ')).join('; ') });
  if (keys[code]) return t(`skillsStudio.errors.${keys[code]}`);
  return t('skillsStudio.errors.request', { code: typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : 'network' });
}
