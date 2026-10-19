# Contributing

Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/leeguooooo/motion-use && cd motion-use
npm ci --ignore-scripts
node bin/motion-use.mjs doctor
npm run lint && npm test
```

## Checking your change

- `npm test` covers brief validation, escaping, timing and output safety.
- For anything visual, render keyframes of both styles in both formats and look at them:

  ```bash
  node bin/motion-use.mjs still examples/chrome-use/brief.json   # explainer
  node bin/motion-use.mjs still examples/mail-use/brief.json     # promo
  ```

  Put the contact sheets (`examples/*/out/stills/**/sheet.png`) in the pull request.
- Changes to timing or audio: render one MP4 with `render --quality draft` and check it plays through.

## Rules of the codebase

- Brief text reaches the page only through `esc()` in `src/html.mjs`. No brief value goes into a `<script>`, an event handler, a URL or CSS; theme colors are validated hex.
- Animation is CSS with explicit delays. No timers, no `Date.now()`, no randomness without a seed: every frame must come out the same on every render.
- Rendering stays offline. No remote fonts, images or scripts.
- New assets need a license that allows redistribution, recorded in `ASSETS.md`. New dependencies must pass `node scripts/licenses.mjs`.

## Releasing (maintainers)

Merging to `main` now releases automatically after the exact main commit passes CI. `Automatic release` prepares the version and tag, then directly calls the existing four-platform build/test/package/install/publish workflow. Only `GITHUB_TOKEN` is required; no npm publication or personal token.

An already prepared version above the last reachable stable tag is retained. Otherwise Conventional Commits select major for breaking changes, minor for `feat`, and patch by default (including documentation/maintenance merges). All five version files are updated together by a bot commit. That commit and the immutable tag are pushed atomically without force. A newer main head causes an older CI completion to skip; the newer commit's CI will release it. Published tags are never moved.

Bot pushes do not start another push workflow. The reusable release call is intentional and prevents a silent missing release or recursive bump loop. Release builds check out the exact prepared SHA, including the native matrix, and verify it matches the tag.

To retry a failed publication without incrementing the version, dispatch `Release` with its existing `vX.Y.Z` tag. `Automatic release` can also be dispatched on main when that exact source has a successful main CI run. Manual stable tag pushes remain supported. Inspect all release assets and SHA256 checksums before claiming artifact acceptance.
