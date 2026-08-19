# Region is sugar over domain, not a replacement for it

Users pick where a box runs by **region** (`us`, `eu`), but the plugin keeps
resolving, storing and passing a **domain**. `[sandbox] region` maps to a domain
and an explicit `[sandbox] domain` still wins; box records keep carrying the
domain alone.

## Why

An E2B region is a user-facing place ("run this in the EU"). A domain is the
mechanical value the SDK, the CLI and every box record already speak. Collapsing
the two loses information in both directions:

- **Records must keep the domain.** A box lives on one cluster for its whole
  life, and existing records already hold `domain`. Rewriting them to hold a
  region would mean inventing a region name for every domain ever recorded,
  including ones the map has never heard of.
- **Two names cannot cover every host.** Any other deployment is reachable today
  by setting `domain` directly. A region enum that
  replaced `domain` would either have to grow a case per host — claiming support
  the project does not test — or lock those users out.

## Consequences

- `region = "us"` leaves the domain **unset** rather than setting `e2b.dev`. The
  SDK defaults to `e2b.app` and the CLI to `e2b.dev`; no single string is correct
  for both, so absent is the only correct value for the default region. `eu` maps
  to `e2b-juliett.dev`, which has no such conflict.
- Exactly two region names ship. Anything else is spelled as a `domain`.
- A template name is only unique *within* a region — the same project name can
  exist in both, owning different templates — so a `[sandbox] templates` list is
  not portable between regions.
