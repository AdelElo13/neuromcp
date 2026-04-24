# Comparison — neuromcp vs. other AI memory systems

> **Honesty rule for this page**: every row is publicly verifiable from the
> linked source. Where a competitor publishes its own benchmark on its own
> harness we link the source and label it accordingly. We do NOT re-run
> their numbers on our harness without their consent.

Last updated: 2026-04-24

## At a glance

| | neuromcp | Mem0 | Hindsight | Mastra OM | Zep / Graphiti | ChatGPT Memory |
|---|---|---|---|---|---|---|
| Runs locally without an account | ✅ | ⚠️ Docker self-host (second-class)¹ | ✅ | ⚠️ libSQL local possible | ❌ | ❌ |
| Required API keys at runtime | None² | OpenAI / Anthropic | None² | OpenAI / Gemini | OpenAI | OpenAI (built-in) |
| MCP server out of the box | ✅ | ❌ (Python lib + cloud REST) | ✅ | ❌ | ❌ | n/a |
| Open source | AGPL-3.0 (engine) + MIT (bin/templates/docs) | Apache 2.0 (core) | MIT | MIT (Mastra core) | partial (Graphiti OSS) | proprietary |
| Hosted commercial tier | ❌ (planned) | ✅ ($19–$249) | ❌ | ✅ | ✅ | ✅ |
| Headline LongMemEval-S score³ | **96.08% (n=102)** | 93.4% (own harness) | 94.6% (own harness) | 94.87% (gpt-5-mini, own harness) | 63.8% | 57.7% |
| Headline benchmark sample | n=102 | n=500 | n=? | n=? | n=500 | n=500 |

¹ Mem0's Docker self-host exists but is documented as "not production
ready"; cloud features (Pro/Enterprise tier) are not available there.

² neuromcp uses a local embedding model (Ollama or ONNX) by default — no
API key. If you wire an LLM-based summary or entity extractor, that step
needs the relevant CLI/API; the rest of the pipeline doesn't.

³ Source for each row:
- neuromcp: this repo, see README + `eval/` reproducer.
- Mem0: <https://docs.mem0.ai/research>.
- Hindsight: <https://github.com/hindsightai/hindsight>.
- Mastra OM: <https://mastra.ai/blog/mastra-observational-memory>.
- Zep / Graphiti: <https://www.getzep.com/blog/state-of-the-art-on-longmemeval/>.
- ChatGPT Memory + GPT-4 native: figures from the LongMemEval paper, <https://arxiv.org/abs/2410.10813>.

## Cost & runtime cost

|  | neuromcp default | Mem0 Pro |
|---|---|---|
| Per-1K-memories ingest | ≈ 0 (local embeddings) | $0–$5 (depends on plan + LLM cost) |
| Per-query | ≈ 0 (local search) | $0.001–$0.005 (cloud routing + LLM) |
| Per-month at 100K memories / 100K queries | ≈ €0 (your laptop) | ≈ $249/mo Pro tier |

If your workload is bursty (a coding agent ingesting and re-querying its
own context all day) the local-cost-zero baseline matters. If your
workload is once-a-day batch ingest with light query traffic, Mem0's
hosted tier may be cheaper than the laptop you'd dedicate to running
neuromcp 24/7. Pick consciously.

## Architectural differences (1-paragraph each)

**neuromcp**: SQLite + sqlite-vec + BM25 in a single Node process.
Hybrid retrieval (vector + BM25 + graph + usefulness prior) with
optional cross-encoder rerank. Persistent Markdown wiki on disk for
human-curated knowledge. MCP server speaks `store_memory`,
`search_memory`, `recall_memory`, plus consolidation + entity tools.
Auto-consolidation scheduler does dedup + decay + compress on an
interval (default 6h).

**Mem0**: Multi-backend Python/TypeScript library (24+ vector DBs,
16+ LLM providers). Managed cloud platform on top of the OSS core.
Graph memory (Neo4j) only on the cloud tier. Selected by AWS as the
exclusive memory provider for the AWS Agent SDK.

**Hindsight**: Local-first MCP server in Rust. Fact extraction with
Gemini-flash-lite. Strong R@10 on its own benchmark; less of a story
on multi-modal or graph reasoning.

**Mastra OM**: Observational Memory pattern (Observer → Reflector →
main agent) on top of LibSQL. Cloud Mastra has more ergonomics; OSS
core can run locally. Trades query latency for a richer memory model.

**Zep / Graphiti**: Hosted graph memory product with an OSS Python
library (Graphiti) for the temporal-graph engine. Strong claims on
long-horizon recall but lower public scores on the canonical LongMemEval
benchmark (LongMemEval paper measured 63.8%).

**ChatGPT Memory**: Closed-source, ships built into ChatGPT/Plus. Score
on the LongMemEval paper baseline is 57.7% — surprising for a
production system; the paper authors discuss why.

## Why we are not "the best"

- We're a single-developer project. Mem0 has a $24M Series A, Mastra
  has a team, Zep has SOC2. Engineering depth is theirs to lose.
- Our 96.08% is on n=102 (sample, not full split). Wilson 95% CI
  ≈ 90.5–98.7%. Until we publish n=500 with the same config, "top
  tier" is the right claim, "best" is not.
- Cross-row entity dedup, multi-device sync, on-device LLM extraction
  for full quality, and SOC2/GDPR documentation are all on the
  roadmap, not shipped today.

## Why pick neuromcp anyway

- You want one MCP server that works with every MCP client.
- You don't want your conversations on someone else's servers.
- You want to run your own benchmark on your own data and see the
  numbers, not a vendor's marketing chart.
- You want to read the code that touches your memory.
- You want to add your own retrieval scoring without permission.

If those don't matter to you, pick whichever vendor has the support
contract you need. We won't argue.
