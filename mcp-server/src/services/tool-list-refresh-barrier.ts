/** OpenCode reloads its tool registry 100 ms after fetching MCP tools. Hold the initiating
 * HTTP tool answer until that fetch has completed and the registry has had time to settle.
 * A timeout is a failed refresh, never a claim that the host has callable tools. */
export class ToolListRefreshBarrier {
  private pending = new Set<() => void>();

  constructor(private timeoutMs = 1_250, private settleMs = 200) {}

  listed(): void {
    for (const resolve of this.pending) resolve();
  }

  async refresh(notify: () => Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete!: () => void;
    const listed = new Promise<boolean>((resolve) => {
      complete = () => resolve(true);
      this.pending.add(complete);
      timer = setTimeout(() => resolve(false), this.timeoutMs);
    });
    try {
      // A broken notification stream must not hold the tool answer forever either.
      if (!await Promise.race([notify().then(() => listed), listed])) return false;
      await new Promise(resolve => setTimeout(resolve, this.settleMs));
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      this.pending.delete(complete);
    }
  }
}
