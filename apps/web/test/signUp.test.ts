import { describe, expect, test } from 'vitest';
import { invitationTokenOf } from '../src/routes/sign-up.js';

describe('sign-up from an invitation link', () => {
  test('reads the token of an accept-invite redirect', () => {
    const token = '11111111-1111-4111-8111-111111111111.abc_DEF-123';
    expect(invitationTokenOf(`/accept-invite/${encodeURIComponent(token)}`)).toBe(token);
  });

  test('anything else is not an invitation', () => {
    expect(invitationTokenOf(undefined)).toBeNull();
    expect(invitationTokenOf('/w/acme')).toBeNull();
    expect(invitationTokenOf('/accept-invite/')).toBeNull();
    expect(invitationTokenOf('/accept-invite/a/b')).toBeNull();
    expect(invitationTokenOf('https://evil.example/accept-invite/x')).toBeNull();
    expect(invitationTokenOf('/accept-invite/%E0%A4%A')).toBeNull();
  });
});
