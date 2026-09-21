import { ContextPublications } from "./shared-context-publications";
import { ContextSources } from "./shared-context-sources";

export class SharedContextStore {
  readonly publications: ContextPublications;
  readonly sources: ContextSources;
  constructor(readonly storage: DurableObjectStorage) {
    this.publications = new ContextPublications(storage.sql);
    this.sources = new ContextSources(storage);
  }

  nextDue(now = Date.now()): number | null {
    if (this.publications.withdrawals(now).length) return now;
    const sync = this.sources.nextDue();
    const retained = this.storage.sql.exec<{ n: number }>(`SELECT
      (SELECT count(*) FROM social_context_publications) + (SELECT count(*) FROM social_context_consents)
      + (SELECT count(*) FROM social_context_receipts) AS n`).one().n;
    return retained ? Math.min(sync ?? Infinity, now + 60 * 60_000) : sync;
  }
}
