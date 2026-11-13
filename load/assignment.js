/**
 * Picks the workload and wallet for one k6 iteration. The k6 script and the
 * load verifier both import this, so they always agree on where traffic went.
 */
export function assignment(index, settings, walletCount) {
  const seed = (index + settings.seed) >>> 0;
  const hot = settings.profile === 'hot' || settings.profile === 'saturation';
  const walletIndex = hot
    ? seed % 5 === 0
      ? 1 + (Math.floor(seed / 5) % (walletCount - 1))
      : 0
    : (Math.imul(seed, 2654435761) >>> 0) % walletCount;
  return {
    workload: settings.mix[seed % settings.mix.length],
    walletIndex,
    lane: hot && walletIndex === 0 ? 'hot' : 'distributed',
  };
}
