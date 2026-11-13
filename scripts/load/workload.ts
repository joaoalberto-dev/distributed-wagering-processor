export const K6_VERSION = '1.4.2';
export const profiles = [
  'smoke',
  'distributed',
  'hot',
  'mixed',
  'saturation',
] as const;
export type Profile = (typeof profiles)[number];

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
type Step = {
  readonly id: string;
  readonly kind: Kind;
  readonly amount: string;
  readonly currency?: string;
  readonly reference?: string;
  readonly response: 200 | 202 | 422;
  /** Expected ledger delta in minor units, represented as a string for k6. */
  readonly delta: string;
  readonly failure?: string;
  readonly duplicate?: boolean;
};

const bet: Step = {
  id: 'bet',
  kind: 'BET',
  amount: '1.00',
  response: 200,
  delta: '-100',
};

export const workloads = {
  bet: [bet],
  replay: [{ ...bet, duplicate: true }],
  rejection: [
    {
      ...bet,
      currency: 'USD',
      response: 422,
      delta: '0',
      failure: 'CURRENCY_MISMATCH',
    },
  ],
  mixed: [
    {
      id: 'refund',
      kind: 'REFUND',
      amount: '1.00',
      reference: 'refunded',
      response: 202,
      delta: '100',
    },
    { ...bet, id: 'refunded' },
    bet,
    {
      id: 'win',
      kind: 'WIN',
      amount: '2.00',
      reference: 'bet',
      response: 200,
      delta: '200',
    },
    {
      id: 'loss',
      kind: 'LOSS',
      amount: '1.00',
      reference: 'bet',
      response: 200,
      delta: '0',
    },
    {
      id: 'rollback',
      kind: 'ROLLBACK',
      amount: '2.00',
      reference: 'win',
      response: 200,
      delta: '-200',
    },
  ],
} as const satisfies Record<string, readonly Step[]>;

export type Workload = keyof typeof workloads;
export type LoadStep = Step;
export const OPENING = '1000000000.00';

export function arrivalStages(profile: Profile, seconds: number, rate: number) {
  const steady = { seconds, rate };
  return profile === 'saturation'
    ? [steady, { seconds, rate: rate * 2 }, { seconds, rate: rate * 4 }]
    : [{ seconds: Math.max(1, Math.ceil(seconds / 3)), rate }, steady];
}

export const SMOKE_ITERATIONS = 12;
