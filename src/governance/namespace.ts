import type Database from 'better-sqlite3';

/** Build WHERE clause fragment for namespace filtering. */
export function namespaceFilter(
  namespace: string | undefined,
  defaultNs: string,
): { clause: string; params: string[] } {
  const ns = namespace ?? defaultNs;
  if (ns === '*') return { clause: '1=1', params: [] };
  return { clause: 'namespace = ?', params: [ns] };
}

/** List all namespaces with memory counts. */
export function listNamespaces(
  db: Database.Database,
): Array<{ namespace: string; count: number }> {
  return db
    .prepare(
      'SELECT namespace, COUNT(*) as count FROM memories WHERE is_deleted = 0 GROUP BY namespace ORDER BY count DESC',
    )
    .all() as Array<{ namespace: string; count: number }>;
}
