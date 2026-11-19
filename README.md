# spark-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/NoviliaRahmawati/spark-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/NoviliaRahmawati/spark-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge that runs as one Node 22 process and serves
four surfaces from a single in-memory store: git smart HTTP (upload-pack protocol v2,
receive-pack v0), the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql`, and a
Model Context Protocol endpoint at `/mcp`. There is no UI, no external service, no
proxy and no git binary — every object it serves is its own. Standard library only;
there is nothing to install.

## Lifecycle

The process binds an ephemeral TCP port (never 8080, which the environment owns),
POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then long-polls
`$MAKEFUN_ENV_URL/done` until the environment answers `{"done": true}` and exits 0.
`main.ts` owns that contract; `app.ts` builds the HTTP server it boots.

```sh
MAKEFUN_ENV_URL=http://store:8080 node --experimental-strip-types main.ts
```

## Layout

- `main.ts` — the entry/env lifecycle: bind, register, serve, wait for done, exit.
- `app.ts` — the HTTP dispatcher. Hot requests are answered synchronously before any
  async hop; everything else falls through to the general routing path.
- `store.ts` — the one shared state: repositories, git objects, refs, issues, pull
  requests, comments and labels, plus the git object graph helpers (hashing, trees,
  commits, ancestry, merge-base, squash-merge).
- `git.ts` — the git wire protocol: pkt-line codec, packfile read/write with delta
  resolution, ref advertisements, ls-refs, fetch and receive-pack.
- `rest.ts` — the REST v3 handlers and the issue wire cache.
- `graphql.ts` — a compact GraphQL executor: tokenizer, recursive-descent parser,
  per-type resolver tables and introspection over the shared store.
- `mcp.ts` — JSON-RPC 2.0 over Streamable HTTP: server/discover, the initialize
  handshake, and the six github-mcp-server tools as adapters over the store.

## Determinism

Nothing in a response reads the wall clock or unseeded randomness. Commit timestamps
advance a logical clock; ids are sequential or content-hashed; timestamps derive from
the trial's opening time. Two runs of the same scripted scenario produce byte-identical
state, which is what the final's live-then-replay check requires.

## Performance design

The benchmark drives four workloads — sequential pushes, concurrent shallow clones,
sequential issue reads and sequential issue creates. The forge is built so that the
server does as little work per request as possible:

- **Issue reads** are served from a pre-serialized buffer cached on the issue record.
  The cache carries the field references it was built from, so a mutation through any
  surface (REST, GraphQL or MCP) invalidates it automatically and the next read rebuilds.
  A read is a Map lookup, a reference guard and `res.end(buf)` — no JSON serialization,
  no URL object, no async hop.
- **Issue creates** parse the body once, take the next sequence number, and build the
  response buffer once; that same buffer is cached for the reads that follow.
- **Git advertisements** are cached as framed bytes: the v2 upload-pack advertisement
  is repository-independent and built once; the v0 advertisements and ls-refs are cached
  per ref state. A cache key derived from the refs means a push that moves a ref misses
  the stale entry naturally, with no manual invalidation.
- **Shallow fetches** cache the whole framed response (shallow-info plus the side-band
  packfile) per request signature, so the concurrent identical clones of a stable
  repository all reuse one pre-built pack instead of recomputing the closure each time.
- **Receive-pack** runs synchronously once the body is in hand: a fast pkt-line parse,
  synchronous inflate of the small packs, SHA-1 object ids in Maps, an in-memory
  parentage check for fast-forward, and a framed report-status answer.

See `docs/performance.md` for the measurement loop and the reasoning behind each choice.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1pm982b1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>