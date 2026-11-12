import { expect } from 'bun:test';
import type { HttpClient } from './http-client.js';

export type ReconciliationBody = {
  readonly walletId: string;
  readonly storedBalance: { amount: string; currency: string };
  readonly calculatedBalance: { amount: string; currency: string };
  readonly difference: { amount: string; currency: string };
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly issues: readonly { code: string; details?: unknown }[];
};

/** Asserts that every wallet's stored balance equals its ledger. */
export async function expectReconciled(
  client: HttpClient,
  walletIds: readonly string[],
): Promise<void> {
  for (const walletId of walletIds) {
    const response = await client.post<ReconciliationBody>(
      `/wallets/${walletId}/reconciliation`,
      undefined,
      { retryUnavailableMs: 10_000 },
    );
    expect(response.status).toBe(200);
    expect({ walletId, issues: response.body.issues }).toEqual({
      walletId,
      issues: [],
    });
    expect(response.body.consistent).toBe(true);
  }
}
