/**
 * Team context of a caller (Agents system, phase P4): is this run a worker of a team slice?
 *
 * The `team` tool group is context-gated (tool-catalog.ts `context:team`): a server advertises it only to a run
 * that works a slice of a team. Who that is, is the Neural Interface's to say (its team scheduler knows every
 * slice's run), so the HTTP transport asks the host through the resolver it set here, with the pin the host
 * accepted for the request (http.ts acceptedTerminalPin: a run's id counts only with its terminal token). A stdio
 * child asks over HTTP once, as it starts (index.ts bindTeamContext).
 *
 * Advertising is all this decides. Every `team` call goes to the Neural Interface, which takes the caller's team
 * from its proven run and refuses a run that has none: a tool list is never the gate.
 */

export type TeamContextResolver = (runId: string) => boolean;

let resolver: TeamContextResolver | null = null;

/** The host's answer for a run id (the Neural Interface: its scheduler's `member`). null: no host, no team context. */
export function setTeamContextResolver(fn: TeamContextResolver | null): void {
  resolver = typeof fn === 'function' ? fn : null;
}

/** Does the host say this run works a team slice now? false without a host, for no run, and when the host fails. */
export function runHasTeamContext(runId: string | null | undefined): boolean {
  if (!runId || !resolver) return false;
  try { return resolver(String(runId)) === true; } catch { return false; }
}
