import type { AccessRefusal, ClientRef, CloseReason, DeviceAccess, Role } from './models/racs.models';

/**
 * Pure helpers for the multi-user parts of the UI: how clients are named, what a role allows,
 * and the texts for refusals, live-stream closes and closed devices (specs/multi-user.md).
 */

/** `name · client_id`, `client_id` without a name, `you` for this client. */
export function clientLabel(ref: ClientRef | null | undefined, own?: string | null): string {
  if (!ref) {
    return 'anonymous';
  }
  if (own && ref.client_id === own) {
    return 'you';
  }
  return ref.name ? `${ref.name} · ${ref.client_id}` : ref.client_id;
}

/** The short form for running text ("held by line-script"): the name, else the client id. */
export function clientName(ref: ClientRef | null | undefined, own?: string | null): string {
  if (!ref) {
    return 'another client';
  }
  if (own && ref.client_id === own) {
    return 'you';
  }
  return ref.name || ref.client_id;
}

export function canRead(role: Role): boolean {
  return role !== 'meta';
}

export function canWrite(role: Role): boolean {
  return role === 'owner' || role === 'writer';
}

/** Why this client may not write to the device, or `null` when it may. */
export function readOnlyReason(access: DeviceAccess | null | undefined): string | null {
  if (!access || canWrite(access.you)) {
    return null;
  }
  const holder = clientName(access.owner);
  return access.you === 'meta' ? `locked · held by ${holder}` : `read-only · held by ${holder}`;
}

/** The access refusal in an HTTP error (`HttpErrorResponse.error`), if it is one. */
export function refusalOf(e: unknown): AccessRefusal | null {
  if (!e || typeof e !== 'object' || !('error' in e)) {
    return null;
  }
  let body = (e as { error?: unknown }).error;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return body as AccessRefusal;
  }
  return null;
}

/** A refusal as one line of text. `own` (this client's id) is left out of who is in the way. */
export function refusalMessage(r: AccessRefusal, own?: string | null): string {
  switch (r.error) {
    case 'read_only':
      return `read-only · held by ${clientName(r.owner)}`;
    case 'device_locked':
      return r.owner ? `locked · held by ${clientName(r.owner)}` : `locked · ${r.mode ?? 'exclusive'}`;
    case 'device_in_use': {
      const others = (r.members ?? []).filter((m) => m.client_id !== own);
      const names = others.map((m) => clientName(m));
      const holder = r.holder;
      if (holder && holder.client_id !== own && !(r.members ?? []).some((m) => m.client_id === holder.client_id)) {
        names.push(holder.client_id ? holder.client_id : `an anonymous ${holder.kind === 'live' ? 'viewer' : 'burst'}`);
      }
      return names.length ? `in use by ${names.join(', ')}` : 'in use by other clients';
    }
    case 'session_required':
      return 'a session is required';
    case 'session_expired':
      return 'session expired';
    case 'session_conflict':
      return 'session conflict';
  }
}

/** The text for a live socket that ended other than normally. */
export function liveCloseMessage(code: number, reason: string): string {
  switch (code) {
    case 1001:
      return reason === 'device disconnected' ? 'Device disconnected' : 'The stream ended';
    case 4001:
      return 'Session expired · a new one was started, start the stream again';
    case 4003:
      return 'Access revoked · another client took exclusive control';
    default:
      return reason || `Live stream closed (${code})`;
  }
}

/** Why a device was closed, for the workspace's `missing` state. */
export function closedMessage(reason: CloseReason | null, by: ClientRef | null, own?: string | null): string {
  const who = by ? clientName(by, own) : null;
  switch (reason) {
    case 'idle':
      return 'closed · nobody used it';
    case 'forced':
      return who ? `closed by ${who} for everyone` : 'closed for everyone';
    case 'error':
      return 'closed · the camera failed';
    default:
      return who ? `disconnected by ${who}` : 'disconnected';
  }
}
