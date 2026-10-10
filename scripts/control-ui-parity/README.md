# Control UI visual parity

Generate screenshots through the existing mock-Gateway E2E build, then compare
capture directories. Generated baselines and reports are artifacts; do not commit
them.

```sh
pnpm ui:parity capture --output /absolute/path/to/artifacts
pnpm ui:parity diff /absolute/path/to/before /absolute/path/to/after --output /absolute/path/to/reports
```

Each capture prints its fresh directory. It contains PNGs, `manifest.json`, and a
browser-openable `index.html` with per-example feedback fields and **Copy feedback**.
The manifest records the source HEAD, dirty paths, browser, platform, fixture
fingerprint, exact expected shot set, and each PNG's hash and dimensions. The diff
writes an HTML comparison, JSON report, and changed-pixel PNGs. Exit 0 means all
expected shots match exactly; missing, incomplete, incompatible, or changed
captures fail.

Use the same frozen harness, browser version, platform, fonts, and profile/scene
selection at each source ref. A screenshot baseline is only evidence for the
source and fixtures recorded in its manifest. Dirty source is reported, not
silently described as a clean ref.

For a focused iteration:

```sh
pnpm ui:parity capture --scene '^route-chat$' --profile '^desktop-light$'
```

For a CSS sensitivity check, repeat that selection with a file containing a
visible rule, such as `body { filter: invert(1); }`:

```sh
pnpm ui:parity capture --scene '^route-chat$' --profile '^desktop-light$' --css /absolute/path/to/probe.css
```

`--css` changes only the captured browser and records the stylesheet hash. It does
not edit source. Capture always uses the shared settled-layout, visible-image,
font, and static-animation preparation. Dates, locale, timezone, device scale,
and fixture randomness are fixed. No real Gateway or credentials are used.

## Catalog and remaining qualification

`scenarios.ts` owns route entries and interaction recipes. The current catalog
includes every static route ID, Chat empty/error/long-content states, session
menus, the appearance submenu, a rename dialog, and Settings controls. Twelve
profiles cover desktop/mobile, light/dark, RTL, enlarged text, forced colors,
and reduced motion. This is a coverage matrix, not a full Cartesian product of
all accessibility settings.

This initial implementation is **not yet browser-qualified**. The first Testbox
attempt expired during source preparation, before its capture command ran.
Remaining work includes completing meaningful per-route loading/error/populated
fixtures, plugin/Workboard state, long lists, rich hovercards, overflowing tabs,
and inspecting the complete stress gallery. A successful generic route-host
capture alone does not establish these state contracts. Do not use the current
catalog as the completed migration parity gate until those fixtures and the
same-ref zero-diff/CSS-change browser proofs pass.
