# Contributing

Issues and pull requests are welcome.

- Run `npm ci && npm --prefix web ci`, then `npm test`, `npm run typecheck` and `npm run build` before opening a PR.
- Keep the engine (`src/engine/`) free of HTTP and database imports.
- UI components come from the official shadcn/ui registry (`npx shadcn add ...`); please don't hand-roll replacements.
- Never commit NDI SDK or runtime files, downloaded models, `.env` files, or camera frames that show people. Frames for local tests go in `test/fixtures/private/` (git-ignored).
- New camera drivers implement the interface in `src/engine/cameras/types.ts` and come with tests that use a fake transport.
- By contributing you agree that your contribution is licensed under the AGPL-3.0-only, like the rest of the project.
