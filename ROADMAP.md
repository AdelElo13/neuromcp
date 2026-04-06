# neuromcp Roadmap: State-of-the-Art met Meerdere Lagen

## Doel
Over 3 weken neuromcp naar state-of-the-art brengen met 5 nieuwe lagen.

## Huidige Architectuur (v0.5.1)
```
MCP Interface → Cognitief → Knowledge Graph → Consolidatie → Search → Storage → Embeddings → Wiki
```

## 5 Lagen in Volgorde

### Laag 1: Episodisch Geheugen (Week 1)
- `episodes` tabel + `episode_id` op memories
- `start_episode` / `end_episode` tools
- Sessie-context tracking, episode-based recall
- Files: schema.ts, migrations.ts, types.ts, tools/episode.ts, server.ts

### Laag 2: Semantische Clusters (Week 1)
- k-means clustering op embeddings bij consolidatie
- `clusters` tabel + `cluster_id` op memories
- Cluster-aware search ("meer van dit cluster")
- Files: cognitive/clustering.ts, consolidation/planner.ts, schema.ts

### Laag 3: Hiërarchische Samenvatting (Week 2)
- Extractieve samenvattingen per cluster/episode/namespace
- Samenvattingen als memories met source='consolidation'
- Search: eerst samenvattingen, dan drill down
- Files: cognitive/summarize.ts, consolidation/planner.ts

### Laag 4: Gewogen Graph Propagatie (Week 2)
- Lichtgewicht PageRank over knowledge graph
- `centrality` score op entities
- Centrality meegewogen in RRF search scoring
- Files: graph/pagerank.ts, graph/entities.ts, search.ts

### Laag 5: Adaptief Belang (Week 3)
- Importance stijgt bij herhaald gebruik + recency + centrality
- Vervangt simpele decay door adaptief model
- Formula: base + access_boost * log(1+count) + recency + centrality
- Files: cognitive/importance.ts, consolidation/decay.ts, config.ts

## Verificatie per Laag
1. Unit tests in tests/unit/
2. Integratie tests in tests/integration/
3. npm run test + npm run lint
4. Handmatig testen via MCP client
