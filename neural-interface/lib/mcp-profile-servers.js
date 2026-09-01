/**
 * Pure logic for which external MCP servers a profile grants to a runtime,
 * and the write-guard applied to runtimes that bypass permission prompts.
 *
 * Kept free of filesystem access so the reconciliation rules — which decide
 * whether a user's de-selection survives a restart — can be tested directly.
 */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function builtinNames(registry) {
  return new Set(
    Object.entries(asObject(asObject(registry).servers))
      .filter(([, info]) => asObject(info).builtin)
      .map(([name]) => name)
  );
}

/**
 * External servers the given profile (default: the active one) grants.
 * Builtins are excluded — runtimes inject SynaBun separately with their own pins.
 */
export function selectProfileServerNames(registry, profileName) {
  const reg = asObject(registry);
  const servers = asObject(reg.servers);
  const profile = asObject(asObject(reg.profiles)[profileName || reg.activeProfile]);
  if (!Array.isArray(profile.servers)) return [];
  const builtins = builtinNames(reg);
  return profile.servers.filter(name => servers[name] && !builtins.has(name));
}

/**
 * Startup reconciliation. Mutates `registry` in place; returns true if anything changed.
 *
 * `profileDefaults.knownServers` is the migration marker. On the first run under this
 * scheme we only record the servers that already exist, so a server the user removed in
 * the External Servers grid stays removed. Afterwards, only genuinely new servers are
 * auto-assigned, and only when `autoAddNewServers` is on. Builtins are pruned from
 * every profile's list because runtimes never read them from there.
 */
export function reconcileProfileServers(registry) {
  const reg = asObject(registry);
  let changed = false;

  if (!reg.profileDefaults) {
    reg.profileDefaults = { autoAddNewServers: true, excludeProfiles: ['core'] };
    changed = true;
  }
  const defaults = reg.profileDefaults;
  const exclude = new Set(defaults.excludeProfiles || []);
  const builtins = builtinNames(reg);
  const assignable = Object.keys(asObject(reg.servers)).filter(name => !builtins.has(name));
  const seeded = Array.isArray(defaults.knownServers);
  const known = new Set(seeded ? defaults.knownServers : assignable);

  for (const [profileName, rawProfile] of Object.entries(asObject(reg.profiles))) {
    const profile = asObject(rawProfile);
    if (!Array.isArray(profile.servers)) { profile.servers = []; changed = true; }
    const pruned = profile.servers.filter(name => !builtins.has(name));
    if (pruned.length !== profile.servers.length) { profile.servers = pruned; changed = true; }
    if (exclude.has(profileName) || !defaults.autoAddNewServers) continue;
    for (const serverName of assignable) {
      if (known.has(serverName)) continue;
      if (!profile.servers.includes(serverName)) {
        profile.servers.push(serverName);
        changed = true;
      }
    }
  }

  const nextKnown = assignable.slice().sort();
  if (!seeded || nextKnown.join(' ') !== defaults.knownServers.slice().sort().join(' ')) {
    defaults.knownServers = nextKnown;
    changed = true;
  }
  return changed;
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
