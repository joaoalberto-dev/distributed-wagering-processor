import { Money } from '../../../domain/money/money.js';

/** Builds `Money` from a `numeric(14,2)` column, which the driver returns as an exact string. */
export function moneyFromColumns(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}
