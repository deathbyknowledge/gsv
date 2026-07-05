export type MockSqlRow = Record<string, unknown>;

export type MockSqlCursor<T> = Iterable<T> & {
  toArray(): T[];
};

export function mockSqlRows<T = MockSqlRow>(items: T[] = []): MockSqlCursor<T> {
  return {
    toArray: () => items,
    *[Symbol.iterator]() {
      yield* items;
    },
  };
}

export function createMockSqlTables() {
  const tables = new Map<string, MockSqlRow[]>();

  function getTable(name: string): MockSqlRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  return { tables, getTable };
}

export function handleMockSchemaStatement<T = MockSqlRow>(
  query: string,
  getTable?: (name: string) => MockSqlRow[],
): MockSqlCursor<T> | null {
  if (query.startsWith("DROP TABLE IF EXISTS")) {
    return mockSqlRows<T>();
  }
  if (query.startsWith("CREATE TABLE IF NOT EXISTS")) {
    const match = query.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
    if (match && getTable) getTable(match[1]);
    return mockSqlRows<T>();
  }
  if (query.startsWith("CREATE INDEX IF NOT EXISTS")) {
    return mockSqlRows<T>();
  }
  return null;
}
