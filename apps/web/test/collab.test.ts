import { describe, expect, test } from 'vitest';
import { collabDocumentName, collabUrl, connectionState } from '../src/lib/collab.js';

describe('collabUrl', () => {
  test('derives ws:// from an http page on its own host under /collab', () => {
    expect(collabUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/collab');
  });

  test('derives wss:// from an https page', () => {
    expect(collabUrl({ protocol: 'https:', host: 'wiki.example.test' })).toBe('wss://wiki.example.test/collab');
  });

  test('an override wins, trimmed of trailing slashes', () => {
    expect(collabUrl({ protocol: 'https:', host: 'wiki.example.test' }, 'wss://collab.example.test/')).toBe(
      'wss://collab.example.test'
    );
  });

  test('an empty or missing override is ignored', () => {
    expect(collabUrl({ protocol: 'http:', host: 'h' }, '')).toBe('ws://h/collab');
    expect(collabUrl({ protocol: 'http:', host: 'h' }, '   ')).toBe('ws://h/collab');
    expect(collabUrl({ protocol: 'http:', host: 'h' }, undefined)).toBe('ws://h/collab');
  });
});

describe('collabDocumentName', () => {
  test('is "{tenantId}:{pageId}", the name the collab server parses', () => {
    const t = '11111111-1111-4111-8111-111111111111';
    const p = '22222222-2222-4222-8222-222222222222';
    expect(collabDocumentName(t, p)).toBe(`${t}:${p}`);
  });

  test('lower-cases both ids, since the server accepts only the canonical spelling', () => {
    expect(collabDocumentName('AAAAAAAA-1111-4111-8111-111111111111', 'BBBBBBBB-2222-4222-8222-222222222222')).toBe(
      'aaaaaaaa-1111-4111-8111-111111111111:bbbbbbbb-2222-4222-8222-222222222222'
    );
  });
});

describe('connectionState', () => {
  test('is connected only when the socket is open and the document synced', () => {
    expect(connectionState({ socket: 'connected', synced: true, authFailed: false })).toBe('connected');
    expect(connectionState({ socket: 'connected', synced: false, authFailed: false })).toBe('connecting');
    expect(connectionState({ socket: 'connecting', synced: false, authFailed: false })).toBe('connecting');
  });

  test('a closed socket is offline', () => {
    expect(connectionState({ socket: 'disconnected', synced: false, authFailed: false })).toBe('offline');
  });

  test('an authentication that kept failing is offline even on an open socket', () => {
    expect(connectionState({ socket: 'connected', synced: false, authFailed: true })).toBe('offline');
  });
});
