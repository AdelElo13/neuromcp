# License decision — RESOLVED 2026-04-24

> Status: **AGPL-3.0 (engine) + MIT (carve-out)** chosen.
> Implementation shipped in commit on 2026-04-24.
> See `LICENSE` and `LICENSE-EXAMPLES`. README license FAQ updated.

## Current state

- License: **MIT** (in `package.json` and `LICENSE`).
- All public commits to date are by the maintainer (Adel) — there are no
  external contributors with rights that would block a re-license.
- No CLA was in place before today; `CONTRIBUTING.md` (added 2026-04-24)
  is the first version.

## Tradeoff

| | MIT (current) | AGPL-3.0 | BSL (Business Source License) |
|---|---|---|---|
| Adoption ceiling | Highest. Picked freely by enterprise + commercial. | Medium. Many corps disallow AGPL. | Medium. Most corps tolerate BSL with the conversion clause. |
| Defence against SaaS-fork | None. A competitor can host neuromcp as their SaaS. | Strong. Hosting requires open-sourcing the host's code. | Strong for N years (typically 3–4), then converts to MIT/Apache. |
| Exit / acquisition value | Highest. Maximum theoretical buyer pool. | Medium-high. Some buyers pay a re-license premium. | Medium-high. Conversion clock can be a feature in deals. |
| Precedent | Most npm, React, Vue. | MongoDB (SSPL → AGPL family), Grafana, Nextcloud. | HashiCorp (Terraform), Sentry, Cockroach Labs. |

## What the strategy doc recommends

The 22 april strategy doc proposes **AGPL-3.0 for `src/` (the engine) +
MIT for everything in `examples/`, `docs/`, integration bridges, and
helper scripts**. Reasoning:

1. The defensive moat against a Mem0 / VC-funded competitor hosting our
   code as their product is real. Mem0 has the engineering headcount to
   feature-match in 4–6 months; AGPL slows that path to "rewrite from
   scratch" rather than "fork and host".
2. The MIT carve-out for examples and bridges keeps adoption frictionless
   for downstream code that *uses* neuromcp (their code stays MIT-clean).
3. Open-source projects at our scale routinely re-license at v1.0 (we are
   on v0.18). Doing it before v1.0 + before contributors sign the CLA is
   the cleanest moment.

## Risks of switching to AGPL

- **Adoption hit**: some corps' license policy auto-rejects AGPL. This is
  fewer than people fear (Google's policy is the most-cited; many others
  allow AGPL with review).
- **Perception**: AGPL is sometimes perceived as "open-source-but-not-really".
  Pre-empt with a clear FAQ section in README.
- **Incompatibility**: our existing dependencies need to be AGPL-compatible.
  All current deps (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`,
  `zod`, `@modelcontextprotocol/sdk`) are MIT/Apache, so AGPL is fine.
- **One-way door**: re-licensing AGPL → MIT later requires every contributor's
  consent. With CLA in place this is solvable; without CLA it's not.

## Risks of staying on MIT

- A single competitor with capital can fork, rebrand, host, and out-market us
  in <6 months. We could be commoditised by our own code.
- All "moat" then has to be earned in the narrative (positioning, brand,
  community) — which is harder than a license clause.
- Acquisition value is similar either way (Microsoft/IBM bought open
  projects for $7.5B and $34B respectively; MIT is not a cap).

## Recommendation (for owner to decide)

If the goal is **fast adoption + max acquihire pool**: keep MIT.
If the goal is **defend against Mem0-class competitor + protect long-term
SaaS upside**: switch to **AGPL-3.0 (engine) + MIT (examples)** before
the first wave of external contributors arrives.

The CLA in `CONTRIBUTING.md` is written to allow either path so the
decision can wait, but waiting beyond ~10 external contributors makes
re-license much harder.

## Action items if AGPL is chosen

1. Update `LICENSE` and `package.json` `"license"` field.
2. Add an `EXAMPLES_LICENSE` (MIT) covering `examples/`, `docs/`,
   `templates/`, `scripts/`.
3. Update README + add an FAQ entry: *"Can I use neuromcp commercially?"*
4. Trademark "neuromcp" (Benelux BOIP first, EUIPO follow-up) before
   the version bump — the trademark plus AGPL is what gives leverage.
5. Bump major version to **v1.0.0** with the license change in the
   release notes.

## Action items if MIT stays

1. Make the choice deliberate — write an issue documenting the decision
   so it doesn't get re-litigated quarterly.
2. Compensate with brand investment: trademark, public benchmarks,
   "official" landing page, formal team page.
3. Plan acquisition negotiating posture differently (contract terms,
   not license terms, become the protection).
