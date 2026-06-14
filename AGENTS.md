<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This project runs **Next.js 16** (App Router, React 19.2). It has breaking changes that differ from your training data. Trust the in-repo docs over your memory: the authoritative, version-pinned docs ship at `node_modules/next/dist/docs/`. The cheat-sheet below covers the common traps; for anything not listed, **before touching routing, caching, data fetching, images, or `next.config`, grep that folder for the API and read its page** instead of generating from memory. Heed deprecation notices.

## Next.js 16 deltas (what differs from your priors)

**Async request APIs — fully removed sync access.** `cookies()`, `headers()`, `draftMode()`, and `params` / `searchParams` (in `page`/`layout`/`route`/`default`, metadata image routes) are Promise-only — always `await` them. `params`/`id` passed to `opengraph-image`/`twitter-image`/`icon`/`apple-icon` and to `sitemap` (under `generateSitemaps`) are now Promises too. Use `PageProps<'/route'>` / `LayoutProps` / `RouteContext` helpers (`npx next typegen`).

**`middleware` → `proxy`.** `middleware.ts` is deprecated; use `proxy.ts` with an exported `proxy()` function. `proxy` runs on the **nodejs** runtime only (no `edge`); keep `middleware` if you still need edge. Config flags renamed: `skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`.

**Caching.** `cacheLife`/`cacheTag` are stable — import without `unstable_` prefix. `revalidateTag(tag)` now **requires** a second cacheLife arg: `revalidateTag('posts', 'max')`. New Server-Action-only APIs: `updateTag(tag)` (read-your-writes, immediate refresh) and `refresh()` (refresh client router). PPR flag removed → opt into `cacheComponents: true` in config.

**Instant navigation gotcha.** With Cache Components, Suspense / `loading.js` alone do NOT guarantee instant client navigation. Export `export const unstable_instant = { prefetch: 'static' }` from routes that must navigate instantly — it validates the cache structure at dev/build time. See `01-app/02-guides/instant-navigation.md`.

**Turbopack is the default** for `next dev` and `next build` (no `--turbopack` flag). A custom `webpack` config makes `next build` **fail** unless you pass `--webpack`. Turbopack config moved from `experimental.turbopack` to top-level `turbopack` in `next.config`. `next dev` outputs to `.next/dev` (concurrent dev+build OK).

**`next/image` config defaults changed (breaking).** `minimumCacheTTL` 60s → 4h; `imageSizes` dropped `16`; `qualities` now only `[75]`; local images with query strings need `images.localPatterns[].search`; local-IP optimization blocked (`dangerouslyAllowLocalIP`); redirects capped at 3 (`maximumRedirects`). `images.domains` deprecated → use `remotePatterns`. `next/legacy/image` deprecated.

**Removed entirely:** `next lint` (use ESLint/Biome directly; `next build` no longer lints), `serverRuntimeConfig`/`publicRuntimeConfig` (use env vars + `connection()` for runtime reads), AMP (`next/amp`, `amp` config), `experimental.dynamicIO` (→ `cacheComponents`), `unstable_rootParams`, some `devIndicators` options.

**Other:** parallel-route slots now require an explicit `default.js` (build fails without it); `scroll-behavior: smooth` is no longer auto-overridden on navigation (add `data-scroll-behavior="smooth"` to `<html>` to restore); ESLint plugin defaults to Flat Config; `next build` output dropped the `size` / `First Load JS` metrics. Min Node 20.9, TypeScript 5.1, React 19.

Full guide: `01-app/02-guides/upgrading/version-16.md`.
<!-- END:nextjs-agent-rules -->
