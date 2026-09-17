// API integration hook: replace this function with a call to your own backend.
// Keep X API credentials on the server, never in browser code.
// Every current display name is a local alias, not a verified X identity.
const LOCAL_PROFILES = Object.freeze({ mayachen: 'Maya Chen', alexrivera: 'Alex Rivera', jordanlee: 'Jordan Lee', sam_builds: 'Sam Parker', nova: 'Nova' });
export async function resolveDisplayName(handle) {
  return LOCAL_PROFILES[handle] || handle.split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ') || handle;
}
