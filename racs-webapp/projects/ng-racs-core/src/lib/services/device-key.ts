/**
 * Where something kept per camera is stored in the browser: by MAC, since the server's device ids
 * only last as long as its process (and are handed out again after a restart).
 */

/**
 * `<prefix>.<mac lowercase>`; `<prefix>.id<id>` for a known device without a MAC; null while the
 * device isn't known yet (not in the registry's connected list), so nothing is read or written
 * under a key that would change a moment later.
 */
export function deviceStorageKey(
  prefix: string,
  device: { id: number; mac?: string | null } | null | undefined,
): string | null {
  if (!device) {
    return null;
  }
  return `${prefix}.${device.mac ? device.mac.toLowerCase() : `id${device.id}`}`;
}

/**
 * Moves the value under `from` to `to`, once: never over an existing `to` (then `from` stays, it
 * may be another camera's), and drops `from` instead when `accept` refuses it.
 */
export function migrateStorage(from: string, to: string, accept?: (raw: string) => boolean): void {
  try {
    const raw = localStorage.getItem(from);
    if (raw === null || from === to || localStorage.getItem(to) !== null) {
      return;
    }
    if (!accept || accept(raw)) {
      localStorage.setItem(to, raw);
    }
    localStorage.removeItem(from);
  } catch {
    // Remembering is a convenience only.
  }
}
