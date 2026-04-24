# Contributing to neuromcp

Thanks for considering a contribution. This project is small, opinionated, and
moves fast. Reading this doc once will save you an hour later.

## Quick start

```bash
git clone https://github.com/AdelElo13/neuromcp.git
cd neuromcp
npm install
npm test          # 297 unit + integration tests
npm run lint      # eslint + tsc --noEmit
npm run build     # tsup
```

You need **Node 20+** and a working `better-sqlite3` build (the `npm install`
step compiles it). On Apple Silicon make sure `xcode-select --install` ran.

## What we accept

- **Bug fixes** with a regression test that fails before the fix.
- **Performance improvements** with a before/after benchmark in the PR description.
- **New retrieval features** behind an opt-in env var or config flag — never on by default.
- **Documentation** including misc README/QUICKSTART/docs improvements.
- **Cross-MCP-client integration guides** under `docs/integrations/`.

## What we decline (or push back on)

- New cloud dependencies. neuromcp is local-first by architecture.
- Adding telemetry. None today, none ever.
- Renaming public exports without a deprecation cycle.
- Pulling in heavy native dependencies beyond `better-sqlite3` and `sqlite-vec`.
- Anything that breaks `import` paths in `package.json`'s `exports` map.

## Opening a PR

1. Branch off `main`.
2. Add tests. Coverage thresholds in `vitest.config.ts` are enforced in CI.
3. Run `npm run lint && npm run test:coverage && npm run build` before pushing.
4. Write a PR description that includes: **what** changed, **why**, and the
   **smallest reproducer or test** showing the new behaviour.
5. If the change touches retrieval scoring, include a one-paragraph note on
   expected impact for the LongMemEval pipeline so the maintainer can spot
   regressions early.

## Contributor License Agreement (CLA)

By submitting a pull request you agree that your contribution is licensed
under the project's current open-source license, and that you grant the
maintainer a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
license to use, reproduce, modify, distribute, and sublicense your contribution
under any open-source license the maintainer may select for the project in
the future, including dual-license arrangements for enterprise use.

This protects the project's ability to evolve its license (e.g. add an
enterprise commercial tier) without each contributor having veto power. It is
modelled on the [Apache Individual CLA](https://www.apache.org/licenses/contributor-agreements.html).

If your employer claims rights to code you write, get them to file a
**Corporate CLA** with the maintainer before opening a PR. Email
adel@neuromcp.dev (placeholder) — we'll send the form.

You retain all copyright in your contribution.

## Communication

- **Bug reports / feature requests**: [GitHub Issues](https://github.com/AdelElo13/neuromcp/issues).
- **Architecture discussions**: open a Discussion thread before a large PR.
- **Security issues**: do NOT open a public issue. Email adel@neuromcp.dev
  (placeholder) and wait for acknowledgement.

## Code style

- TypeScript strict mode. No `any` outside `tests/`.
- Prefer pure functions and `Database`-injected helpers over global state.
- One file per concern — modules under 400 lines.
- Tests next to the file they cover (unit) or in `tests/integration/`.

## License

By contributing you accept the project's current LICENSE and the CLA above.
