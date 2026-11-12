import { describe, expect, it } from 'bun:test';
import { Metrics } from './metrics.js';

describe('Metrics', () => {
  it('exposes the counters the application raises, with their labels', async () => {
    const metrics = new Metrics();
    metrics.transactionDecided('BET', 'PROCESSED', 'http');
    metrics.reconciliationDivergence('BALANCE_MISMATCH');
    metrics.outboxPublishAttempt('sender-fault');
    metrics.bulkheadRejected('http');
    metrics.processingDuration('http', 0.02);

    const text = await metrics.render();
    expect(text).toContain(
      'wager_transactions_total{kind="BET",status="PROCESSED",channel="http"} 1',
    );
    expect(text).toContain(
      'reconciliation_divergences_total{issue="BALANCE_MISMATCH"} 1',
    );
    expect(text).toContain(
      'outbox_publish_attempts_total{result="sender-fault"} 1',
    );
    expect(text).toContain('outbox_sender_faults_total 1');
    expect(text).toContain('bulkhead_rejections_total{group="http"} 1');
    expect(text).toContain(
      'wager_processing_duration_seconds_bucket{le="0.025",channel="http"} 1',
    );
    expect(metrics.contentType).toContain('text/plain');
  });

  it('reports the circuit state as 0, 1, or 2, closed from the start', async () => {
    const metrics = new Metrics();
    expect(await metrics.render()).toContain(
      'circuit_state{dependency="postgres"} 0',
    );
    metrics.circuitChanged('postgres', 'open');
    expect(await metrics.render()).toContain(
      'circuit_state{dependency="postgres"} 2',
    );
    metrics.circuitChanged('postgres', 'half-open');
    expect(await metrics.render()).toContain(
      'circuit_state{dependency="postgres"} 1',
    );
  });

  it('keeps registries of separate instances apart', async () => {
    const first = new Metrics();
    first.inboxDuplicate();
    expect(await new Metrics().render()).toContain('inbox_duplicates_total 0');
  });
});
