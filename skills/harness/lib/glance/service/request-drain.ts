export interface DrainOptions { timeoutMs?: number; sleep?(ms: number): Promise<void>; }

export async function drainServer(server: Bun.Server<unknown>, options: DrainOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  server.stop(false);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = (server as unknown as { pendingRequests?: number }).pendingRequests;
    if (typeof pending === "number" && pending <= 0) break;
    await sleep(25);
  }
  server.stop(true);
}
