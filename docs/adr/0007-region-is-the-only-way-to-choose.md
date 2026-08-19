# Region is the only way to choose where a box runs

Supersedes [ADR-0006](./0006-region-is-sugar-over-domain.md).

`[sandbox] region = "us" | "eu"` is the whole surface. There is no `domain` key.
`us` resolves to no host at all, letting the SDK use its default
(`https://api.e2b.app`, current production); `eu` resolves to
`https://api.e2b-juliett.dev`. A `domain` left in an old config is an **error**,
not an ignored line.

## Why this supersedes 0006

ADR-0006 kept `domain` as an escape hatch, reasoning that "two names cannot cover
every host" — `e2b-staging.dev`, `e2b.pro` and BYOC deployments would otherwise be
unreachable. Two things were wrong with that.

The hosts were **never verified**. They came from the SDK's `supportedDomains`
constant, not from E2B documentation. `api.e2b.pro` turns out to fail TLS
verification and return no HTTP at all; its DNS resolves only because the zone is
wildcarded. A constant was mistaken for a service, and the mistake justified a
config key.

And the two that *do* answer are not two regions. `api.e2b.app` is the current
production hostname and the SDK's default; `api.e2b.dev` is the older name kept on
a compatibility path. Both return 200 because they are **one environment under two
names** — so "cover every host" was solving for variety that does not exist.

US and EU are the regions this project points anyone at. A surface built for
hosts beyond them was carrying weight for nothing.

## Consequences

- **The word "domain" leaves the user's vocabulary.** A region is what a person
  picks; a host is a detail the plugin owns. Box records still store a domain —
  that is internal state pinning a box to where it was born, not configuration.
- **`E2B_DOMAIN` still works**, as does the domain inferred from `e2b auth login`.
  Those are outside this plugin's config surface, and the region skill and direct
  CLI invocations both depend on them.
- **An old `domain` key fails loudly**, naming the region to replace it with when
  the host is one we recognise. Ignoring it would move an EU user's boxes to US
  in silence — the precise failure regions exist to prevent, caused by the
  migration away from the thing that used to prevent it.
- **A deployment outside the two regions is no longer configurable.** Reachable
  by exporting `E2B_DOMAIN`, but not supported. If a third region ever ships, it
  gets a name here rather than a hostname in someone's config.
