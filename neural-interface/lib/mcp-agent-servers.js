// Registry conversion is read-only. An explicit switch is authoritative; missing switches are on.
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function agentAccessFrom(registry) {
  const reg = asObject(registry);
  if (reg.agentAccess && typeof reg.agentAccess === 'object' && !Array.isArray(reg.agentAccess)) return { ...reg.agentAccess };
  const profile = asObject(asObject(reg.profiles)[reg.activeProfile]);
  if (!Array.isArray(profile.servers)) return {};
  const granted = new Set(profile.servers);
  // The old reconciliation marker distinguishes a de-selection from a genuinely new server.
  const known = new Set(Array.isArray(reg.profileDefaults?.knownServers)
    ? reg.profileDefaults.knownServers : Object.keys(asObject(reg.servers)));
  return Object.fromEntries(Object.entries(asObject(reg.servers))
    .filter(([name, entry]) => !entry?.builtin && known.has(name) && !granted.has(name))
    .map(([name]) => [name, false]));
}

export function agentServerNames(registry) {
  const reg = asObject(registry);
  const access = agentAccessFrom(reg);
  return Object.entries(asObject(reg.servers))
    .filter(([name, entry]) => !entry?.builtin && access[name] !== false)
    .map(([name]) => name);
}

/**
 * Tools that mutate ad state or spend budget, keyed by MCP server name.
 *
 * FleetView agents run with `--permission-mode bypassPermissions`, so the read-only
 * allowlist in .claude/settings.json does not apply to them. These are pushed as
 * `--disallowedTools` instead: agents keep full read/reporting access, while anything
 * that creates, edits, activates, or deletes stays with a human.
 */
export const MCP_SERVER_WRITE_TOOLS = {
  'meta-ads': [
    'ads_create_campaign', 'ads_create_ad_set', 'ads_create_ad', 'ads_create_creative',
    'ads_update_entity', 'ads_activate_entity', 'ads_boost_ig_post',
    'ads_create_custom_audience', 'ads_update_custom_audience',
    'ads_update_custom_audience_users', 'ads_delete_custom_audience',
    'ads_catalog_create', 'ads_catalog_update_catalog',
    'ads_catalog_product_create', 'ads_catalog_update_product', 'ads_catalog_delete_product',
    'ads_catalog_create_product_set', 'ads_catalog_update_product_set', 'ads_catalog_product_set_delete',
    'ads_catalog_create_product_feed', 'ads_catalog_update_product_feed',
    'ads_catalog_create_product_feed_upload_session', 'ads_catalog_product_feed_delete',
    'ads_catalog_create_feed_rule', 'ads_catalog_product_feed_delete_rule',
    'ads_catalog_event_source_connect', 'ads_catalog_event_source_disconnect',
    'ads_pixel_event_create', 'ads_pixel_event_update', 'ads_pixel_event_delete',
    'ads_pixel_parameter_create', 'ads_pixel_parameter_update', 'ads_pixel_parameter_delete',
    'ads_experiment_abtest_create_test', 'ads_experiment_abtest_update_test',
    'ads_experiment_lift_create_test',
  ],
};

/** Fully-qualified deny list for whichever servers an agent's --mcp-config actually grants. */
export function buildAgentDisallowedTools(mcpConfigJson) {
  let serverNames = [];
  try {
    serverNames = Object.keys(asObject(JSON.parse(mcpConfigJson || '{}')).mcpServers || {});
  } catch { return []; }
  const deny = [];
  for (const server of serverNames) {
    for (const tool of MCP_SERVER_WRITE_TOOLS[server] || []) deny.push(`mcp__${server}__${tool}`);
  }
  return deny;
}
