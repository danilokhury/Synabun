// How long a sidepanel session may stay silent in a turn before its watchdog
// steps in. Quiet extended thinking is expected.
export function claudeStallSeconds(effort, lowerEffortDefault = 90) {
  if (effort === 'max' || effort === 'xhigh') return 300;
  if (effort === 'high') return 120;
  return lowerEffortDefault;
}
