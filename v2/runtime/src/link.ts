import { GsvFailure } from "@gsv/catalog";

/** Owner-named objects hold a link to their current space; a call carrying an older generation gets `moved`. */
export type SpaceLink = { space: string; generation: number };

export const LINK_TABLE = "CREATE TABLE link (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, space TEXT NOT NULL, generation INTEGER NOT NULL)";

export function readLink(sql: SqlStorage): (SpaceLink & { owner: string }) | undefined {
  return sql.exec<SpaceLink & { owner: string }>("SELECT owner, space, generation FROM link WHERE id = 1").toArray()[0];
}

/** Writes the link, never replacing a newer generation, and refuses callers that resolved an older one. */
export function acceptLink(sql: SqlStorage, owner: string, caller: SpaceLink): void {
  sql.exec(
    `INSERT INTO link (id, owner, space, generation) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET space = excluded.space, generation = excluded.generation WHERE excluded.generation > link.generation`,
    owner, caller.space, caller.generation,
  );
  const link = readLink(sql);
  if (!link || link.owner !== owner) throw new GsvFailure("not_found", "No such owner object.");
  if (caller.generation < link.generation) throw new GsvFailure("moved", "The owner moved; resolve it again.");
}
