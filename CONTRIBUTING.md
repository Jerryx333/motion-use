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

Bump `version` in `package.json`, the root entry in `package-lock.json`, `.claude-plugin/plugin.json`, `native/motion-render/Cargo.toml` and the motion-render entry in `native/Cargo.lock`, then push a tag `vX.Y.Z`. The release workflow packages the archive, checks that it installs, and attaches it and its `.sha256` to the GitHub Release.
