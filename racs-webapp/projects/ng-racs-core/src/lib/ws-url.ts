/**
 * The WebSocket URL of API path `path` under `apiBase` (see `RacsConfig.apiBase`): on this page's
 * host when the base is a path, `ws`/`wss` after the page's or the base's scheme.
 */
export function wsUrl(apiBase: string, path: string, params: URLSearchParams): string {
  const url = new URL(`${apiBase}${path}`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = params.toString();
  return url.href;
}
