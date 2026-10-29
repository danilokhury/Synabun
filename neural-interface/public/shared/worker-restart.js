/** Shared provider-panel status. A suspension still owns the tab, but is not working. */
export function workerRestart(run) {
  const suspended = run?.status === 'suspended';
  const resumes = Number(run?.resumes) || 0;
  return {
    suspended,
    active: suspended || ['starting', 'running'].includes(run?.status),
    key: suspended ? 'workerRestart.suspended' : resumes ? 'workerRestart.resumed' : null,
    stamp: suspended ? `suspended:${run.suspendedAt || ''}` : `resumed:${resumes}`,
    resumes,
  };
}
