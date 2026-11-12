import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import {
  contractAmount,
  currency,
  externalId,
  idempotencyKey,
  lowercaseUuid,
  money,
} from './primitives.js';

const ok = (schema: z.ZodType, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true);
const bad = (schema: z.ZodType, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(false);

describe('externalId', () => {
  it('accepts 1–128 of [A-Za-z0-9._:-]', () => {
    ok(externalId, 'provider-a:tx_1.2');
    ok(externalId, 'x'.repeat(128));
  });
  it('rejects other characters, empty, and longer values', () => {
    bad(externalId, 'has space');
    bad(externalId, '');
    bad(externalId, 'x'.repeat(129));
    bad(externalId, 42);
  });
});

describe('lowercaseUuid', () => {
  it('accepts a canonical lowercase UUID', () => {
    ok(lowercaseUuid, '0192f291-27dd-7d3f-8071-5f8685deef37');
  });
  it('rejects uppercase and non-canonical forms', () => {
    bad(lowercaseUuid, '0192F291-27DD-7D3F-8071-5F8685DEEF37');
    bad(lowercaseUuid, '0192f29127dd7d3f80715f8685deef37');
    bad(lowercaseUuid, '{0192f291-27dd-7d3f-8071-5f8685deef37}');
  });
});

describe('contractAmount', () => {
  it('accepts zero and the ceiling', () => {
    ok(contractAmount, '0.00');
    ok(contractAmount, '25.50');
    ok(contractAmount, '999999999999.99');
  });
  it('rejects negatives, the wrong scale, leading zeros, numbers, and amounts above the ceiling', () => {
    bad(contractAmount, '-1.00');
    bad(contractAmount, '25.5');
    bad(contractAmount, '25');
    bad(contractAmount, '01.00');
    bad(contractAmount, '+1.00');
    bad(contractAmount, '1e3');
    bad(contractAmount, ' 1.00');
    bad(contractAmount, 25);
    bad(contractAmount, '1000000000000.00');
  });
});

describe('currency', () => {
  it('accepts three uppercase letters', () => ok(currency, 'BRL'));
  it('rejects anything else', () => {
    bad(currency, 'brl');
    bad(currency, 'BRLX');
  });
});

describe('money', () => {
  it('accepts amount and currency', () => {
    ok(money, { amount: '1.00', currency: 'BRL' });
  });
  it('rejects unknown fields and a missing currency', () => {
    bad(money, { amount: '1.00', currency: 'BRL', scale: 2 });
    bad(money, { amount: '1.00' });
  });
});

describe('idempotencyKey', () => {
  it('accepts 1–255 printable ASCII characters', () => {
    ok(idempotencyKey, 'provider-a:transaction-123');
    ok(idempotencyKey, '!'.repeat(255));
  });
  it('rejects spaces, non-ASCII, empty, and longer keys', () => {
    bad(idempotencyKey, 'a b');
    bad(idempotencyKey, 'chave-ç');
    bad(idempotencyKey, '');
    bad(idempotencyKey, 'k'.repeat(256));
  });
});
