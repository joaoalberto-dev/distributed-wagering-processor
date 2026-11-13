export type Assignment<Workload extends string> = {
  readonly workload: Workload | undefined;
  readonly walletIndex: number;
  readonly lane: 'hot' | 'distributed';
};

export function assignment<Workload extends string>(
  index: number,
  settings: {
    readonly seed: number;
    readonly profile: string;
    readonly mix: readonly Workload[];
  },
  walletCount: number,
): Assignment<Workload>;
