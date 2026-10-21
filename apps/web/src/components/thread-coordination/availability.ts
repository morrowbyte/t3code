// Keep WEA-31's browser-local groups dormant until their interaction design is ready.
// This does not gate server-owned parent/child thread lineage or agent tools.
export function isThreadCoordinationAvailable() {
  return false;
}
