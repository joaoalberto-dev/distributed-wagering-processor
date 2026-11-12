/** Fresh identities for each test, so specs never collide on shared tables. */

export function playerId(): string {
  return Bun.randomUUIDv7();
}

export function externalId(prefix = 'ext'): string {
  return `${prefix}-${Bun.randomUUIDv7()}`;
}

export type MoneyBody = { readonly amount: string; readonly currency: string };

export function brl(amount: string): MoneyBody {
  return { amount, currency: 'BRL' };
}

/** A `POST /wallets` body for a new player. */
export function openWalletBody(
  initialBalance: MoneyBody = brl('100.00'),
  player: string = playerId(),
): { playerId: string; initialBalance: MoneyBody } {
  return { playerId: player, initialBalance };
}

export type WagerBody = {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly money: MoneyBody;
  readonly referenceExternalTransactionId?: string;
};

/** A `POST /wagering/transactions` body: a `BET` of `25.00` with a fresh external ID. */
export function wagerBody(
  wallet: { readonly id: string; readonly playerId: string },
  overrides: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId('tx'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

/** The recommended `{providerId}:{externalTransactionId}` key (§8). */
export function keyOf(body: WagerBody): Record<string, string> {
  return {
    'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
  };
}
