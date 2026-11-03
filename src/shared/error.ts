export function errorMessage(err: unknown): string {
  const message =
    err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err ?? '')
  // Electron wraps rejected invoke errors with transport details; show the original cause.
  return (
    message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim() ||
    'Unknown error'
  )
}
