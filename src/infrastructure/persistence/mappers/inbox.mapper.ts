import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import type { InboxRecord } from '../records/inbox.record.js';

export const inboxMapper = {
  toDomain(record: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      idempotencyKey: record.idempotencyKey,
      transactionId: record.transactionId,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt,
    });
  },
};
