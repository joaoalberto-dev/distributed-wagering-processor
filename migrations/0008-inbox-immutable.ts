import { Migration } from '@mikro-orm/migrations';

/**
 * Inbox rows are written once, with the effect they record, and never
 * updated. Refusing an update keeps a delivery bound to its transaction and
 * payload hash, so a redelivery always replays the operation it carried.
 */
export class Migration0008InboxImmutable extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TRIGGER inbox_no_update_trg BEFORE UPDATE ON inbox
      FOR EACH ROW EXECUTE FUNCTION wagering_refuse()`);
  }

  override down(): void {
    this.addSql('DROP TRIGGER inbox_no_update_trg ON inbox');
  }
}
