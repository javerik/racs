import { InjectionToken } from '@angular/core';
import { LASERLINE_TOOL, type Tool } from './services/tool-window.service';

/** How the RACS services reach the server and what the app around them offers. */
export interface RacsConfig {
  /**
   * The REST API's base: a path on the page's origin (`/api/v1`, behind the same server or a
   * proxy) or an absolute `http(s)://host:port/api/v1` for a server on another origin. The
   * WebSocket URLs are derived from it. No trailing slash.
   */
  apiBase: string;
  /** The web apps bundled beside the UI (the shell's *Tools*), each opened in a window of its own. */
  tools: readonly Tool[];
  /** Start the client session and the events socket when the app starts (see `provideRacs`). */
  autoStart: boolean;
}

export const DEFAULT_RACS_CONFIG: RacsConfig = {
  apiBase: '/api/v1',
  tools: [LASERLINE_TOOL],
  autoStart: true,
};

/** The configuration in effect; `provideRacs` sets it, the defaults apply without it. */
export const RACS_CONFIG = new InjectionToken<RacsConfig>('RACS_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_RACS_CONFIG,
});

/** `config` over the defaults, with the API base's trailing slashes removed. */
export function resolveRacsConfig(config: Partial<RacsConfig> = {}): RacsConfig {
  const merged = { ...DEFAULT_RACS_CONFIG, ...config };
  return { ...merged, apiBase: merged.apiBase.replace(/\/+$/, '') };
}
