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
