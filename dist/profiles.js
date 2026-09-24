// API integration hook: replace this function with a call to your own backend.
// Keep X API credentials on the server, never in browser code.
// Display names are derived from the handle until a real X profile lookup is connected.
export async function resolveDisplayName(handle) {
  return handle.split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ') || handle;
}
