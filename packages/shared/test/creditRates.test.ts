import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { millicreditsFor, parseCreditRates } from '../src/creditRates.js';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x',
  COLLAB_TOKEN_SECRET: 'c'.repeat(32),
  INTERNAL_SECRET: 'i'.repeat(32),
};

const json = '{"default":{"input":1,"output":4},"models":{"m":{"input":2,"output":8}}}';

describe('MODEL_CREDIT_RATES', () => {
  it('rates from inline JSON and from a file are the same', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-'));
    const file = path.join(dir, 'rates.json');
    fs.writeFileSync(file, json);
    expect(parseCreditRates(file)).toEqual(parseCreditRates(json));
    expect(parseCreditRates(json)).toEqual({
      default: { input: 1, output: 4 },
      models: { m: { input: 2, output: 8 } },
    });
  });

  it('charges listed models at their rate and others at default, warning once', () => {
    const rates = parseCreditRates(json);
    expect(millicreditsFor(rates, 'm', 1500, 500)).toBe(7000);
    const warn = vi.fn();
    expect(millicreditsFor(rates, 'x-unlisted', 1500, 500, warn)).toBe(3500);
    expect(millicreditsFor(rates, 'x-unlisted', 1500, 500, warn)).toBe(3500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('x-unlisted');
  });

  it('rounds up, so any nonzero usage costs at least 1 millicredit', () => {
    const rates = parseCreditRates('{"default":{"input":0.0001,"output":0},"models":{}}');
    expect(millicreditsFor(rates, 'tiny', 1, 0, () => {})).toBe(1);
    const tenth = parseCreditRates('{"default":{"input":0.1,"output":0},"models":{}}');
    expect(millicreditsFor(tenth, 'tenth', 3000, 0, () => {})).toBe(300);
  });

  it('deterministic models are free unless listed', () => {
    const rates = parseCreditRates(json);
    expect(millicreditsFor(rates, 'kinote-deterministic-2560-v1', 1000, 1000)).toBe(0);
    expect(millicreditsFor(rates, 'deterministic-answer-v1', 1000, 1000)).toBe(0);
    const listed = parseCreditRates(
      '{"default":{"input":1,"output":1},"models":{"kinote-deterministic-2560-v1":{"input":1,"output":0}}}'
    );
    expect(millicreditsFor(listed, 'kinote-deterministic-2560-v1', 1000, 0)).toBe(1000);
  });

  it('null rates charge nothing', () => {
    expect(parseCreditRates(undefined)).toBeNull();
    expect(millicreditsFor(null, 'm', 1_000_000, 1_000_000)).toBe(0);
  });

  it('bad settings refuse to start', () => {
    for (const bad of ['{oops', '/nope.json', '{"default":{"input":-1,"output":0}}']) {
      expect(() => loadConfig({ ...base, MODEL_CREDIT_RATES: bad })).toThrow(/MODEL_CREDIT_RATES/);
    }
    expect(loadConfig({ ...base, MODEL_CREDIT_RATES: json }).MODEL_CREDIT_RATES).toBe(json);
  });

  it('CONTROL_PLANE_TOKENS splits and rejects short tokens', () => {
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(40);
    expect(loadConfig({ ...base, CONTROL_PLANE_TOKENS: ` ${a}, ,${b} ` }).CONTROL_PLANE_TOKENS).toEqual([a, b]);
    expect(loadConfig(base).CONTROL_PLANE_TOKENS).toBeUndefined();
    expect(() => loadConfig({ ...base, CONTROL_PLANE_TOKENS: `${a},short` })).toThrow(/CONTROL_PLANE_TOKENS/);
  });

  it('BILLING_URL must be a URL', () => {
    expect(loadConfig({ ...base, BILLING_URL: 'https://billing.example/upgrade' }).BILLING_URL).toBe(
      'https://billing.example/upgrade'
    );
    expect(() => loadConfig({ ...base, BILLING_URL: 'not a url' })).toThrow(/BILLING_URL/);
  });
});
