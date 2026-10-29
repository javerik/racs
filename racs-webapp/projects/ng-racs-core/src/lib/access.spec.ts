import {
  canRead,
  canWrite,
  clientLabel,
  clientName,
  closedMessage,
  liveCloseMessage,
  readOnlyReason,
  refusalMessage,
  refusalOf,
} from './access';
import type { DeviceAccess } from './models/racs.models';

const script = { client_id: '77d0aa12', name: 'line-script' };

function access(over: Partial<DeviceAccess>): DeviceAccess {
  return { device: 0, mode: 'shared', owner: null, members: [], holder: null, viewers: 0, you: 'writer', ...over };
}

describe('access helpers', () => {
  it('names clients', () => {
    expect(clientLabel(script)).toBe('line-script · 77d0aa12');
    expect(clientLabel({ client_id: '3f2a9c1e', name: null })).toBe('3f2a9c1e');
    expect(clientLabel(script, '77d0aa12')).toBe('you');
    expect(clientLabel(null)).toBe('anonymous');
    expect(clientName(script)).toBe('line-script');
    expect(clientName(null)).toBe('another client');
  });

  it('knows what a role allows', () => {
    expect([canWrite('owner'), canWrite('writer'), canWrite('reader'), canWrite('meta')]).toEqual([true, true, false, false]);
    expect([canRead('reader'), canRead('meta')]).toEqual([true, false]);
  });

  it('says why a client may not write', () => {
    expect(readOnlyReason(access({}))).toBeNull();
    expect(readOnlyReason(access({ mode: 'ro-shared', owner: script, you: 'owner' }))).toBeNull();
    expect(readOnlyReason(access({ mode: 'ro-shared', owner: script, you: 'reader' }))).toBe('read-only · held by line-script');
    expect(readOnlyReason(access({ mode: 'exclusive', owner: script, you: 'meta' }))).toBe('locked · held by line-script');
  });

  it('reads refusals from HTTP errors, also text ones', () => {
    expect(refusalOf({ error: { error: 'read_only', mode: 'ro-shared', owner: script } })?.error).toBe('read_only');
    expect(refusalOf({ error: '{"error":"session_expired"}' })?.error).toBe('session_expired');
    expect(refusalOf({ error: 'Error: StoreError(Busy(0))' })).toBeNull();
    expect(refusalOf(new Error('x'))).toBeNull();
  });

  it('turns refusals into one line', () => {
    expect(refusalMessage({ error: 'read_only', mode: 'ro-shared', owner: script })).toBe('read-only · held by line-script');
    expect(refusalMessage({ error: 'device_locked', mode: 'exclusive', owner: script })).toBe('locked · held by line-script');
    expect(refusalMessage({ error: 'device_locked', mode: 'ro-shared', owner: null })).toBe('locked · ro-shared');
    expect(
      refusalMessage({
        error: 'device_in_use',
        mode: 'shared',
        owner: null,
        members: [script],
        holder: { kind: 'live', client_id: null },
      }),
    ).toBe('in use by line-script, an anonymous viewer');
    // This client's own stream is not in the way.
    expect(
      refusalMessage(
        { error: 'device_in_use', mode: 'shared', owner: null, members: [script], holder: { kind: 'live', client_id: 'me000000' } },
        'me000000',
      ),
    ).toBe('in use by line-script');
  });

  it('explains live-stream closes', () => {
    expect(liveCloseMessage(1001, 'device disconnected')).toBe('Device disconnected');
    expect(liveCloseMessage(4001, 'session expired')).toMatch(/^Session expired/);
    expect(liveCloseMessage(4003, 'access revoked')).toMatch(/^Access revoked/);
    expect(liveCloseMessage(1011, 'acquisition failed')).toBe('acquisition failed');
    expect(liveCloseMessage(1006, '')).toBe('Live stream closed (1006)');
  });

  it('explains why a device closed', () => {
    expect(closedMessage('idle', null)).toBe('closed · nobody used it');
    expect(closedMessage('forced', script)).toBe('closed by line-script for everyone');
    expect(closedMessage('request', script, '77d0aa12')).toBe('disconnected by you');
    expect(closedMessage('error', null)).toBe('closed · the camera failed');
  });
});
