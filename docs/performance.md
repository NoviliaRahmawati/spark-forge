# Performance notes

How spark-forge was tuned for the four timed workloads, and why each choice is shaped
the way it is. The governing constraint: the benchmark client is sealed, so the only
lever is the work the forge does per request. The goal is to make that work as close
to zero as the wire protocol allows, while keeping every conformance check green and
the state export byte-for-byte reproducible.

## The measurement loop

Iteration runs against the kit's sealed suite on Node 22 (the runtime the grader uses):

1. A dev launcher outside the repository sets the trial environment and imports
   `createApp()` from `app.ts`, binding a loopback port.
2. The suite (`sdk/run.ts --perf --json`) drives the 120 conformance checks, the 15 MCP
   checks, then the four workloads — three timed rounds each after five warm-ups — and
   prints per-workload medians and points.
3. Each measurement gets a fresh process: the store is in-memory, so a reused server
   would carry stale repositories and refs from the previous run and fail setup.
4. The final check is `grade-local`, which runs the real lifecycle and the live-then-
   replay determinism check under the trial's limits.

A workload's points are `clamp(25 - 12.5 * log2(t / T_ref), 0, 50)`, so halving a median
adds about 12.5 points; the tie-break is the geometric mean of the four medians.

## Where the time goes

Profiling the read workload with the suite's own REST client against a trivial endpoint
shows the cost is dominated by the client round-trip (fetch dispatch, header handling,
body read and JSON parse) plus loopback latency, not by the forge. The server-side floor
for a cached response is a small fraction of a millisecond. The consequence: the biggest
wins come from removing server work entirely on the hot paths, and from letting the
client and server run on separate cores (the trial pod has two CPUs).

## The four hot paths

### read — sequential issue GETs on one keep-alive connection

Each issue record carries a `wire` cache: the serialized GET response bytes, the ready
response headers, and the field references (title, body, state, labels) the bytes were
built from. `tryFastIssueGet` parses the path by slicing (no `new URL()`), looks the
issue up in a Map, and serves the cached buffer with `res.writeHead` + `res.end` while
the references still match. The guard is four reference comparisons, so it is effectively
free, and it is correct across surfaces: any mutation assigns a new string or array
reference, which misses the guard and rebuilds. There is no JSON serialization, no
request-id allocation and no async hop on a cache hit.

### write — sequential issue creates

`tryFastIssuePost` parses the path and body without a URL object, takes the next issue
number, builds the response once, and caches those exact bytes on the new record so the
read workload that follows hits the cache on every request. The create answer and the
later GET share one buffer.

### push — sequential receive-pack updates

Once the body is collected, receive-pack runs synchronously: a fast pkt-line parse,
`inflateSync` on the small packs (the async zlib stream API costs a threadpool round
trip per entry, far more than the synchronous call on a 1 KiB object), SHA-1 ids into
Maps, and a fast-forward check that first tests whether the current tip is a parent of
the new commit (the sequential-push case) before falling back to an ancestry walk. The
report-status answer is framed into side-band-64k when the client asks for it.

### clone — concurrent depth-1 clones of a stable repository

A depth-1 clone is three HTTP exchanges (advertisement, ls-refs, fetch) and the pack it
receives holds only the tip commit, its tree and its blob — not the history. Every
response that is a pure function of the repository state is built once and cached as
framed bytes:

- the v2 advertisement is repository-independent, so one global buffer serves all;
- the v0 advertisements and the default ls-refs are cached per ref state;
- the whole fetch response (shallow-info plus the side-band packfile) is cached per
  request signature.

The cache keys are derived from the refs and the request, so a push that moves a ref
naturally misses the stale entries; nothing is invalidated by hand, and a stale entry
can never be served. The concurrent identical clones therefore reuse one pre-built pack
instead of each recomputing the closure and re-deflating the objects.

## Correctness guardrails

- The fast paths only accelerate requests they can serve verbatim; anything else (a
  query string, percent-escapes, a pull request, a missing record, an unauthenticated
  call) falls through to the general router, which keeps the exact status codes and
  body shapes the suite asserts.
- The wire cache's reference guard means a cached issue response can never outlive a
  mutation, regardless of which surface made it.
- Determinism is preserved: no wall clock or unseeded randomness reaches a response,
  ids are sequential or content-hashed, and the logical clock stamps commits. The
  live-then-replay check confirms the state export matches byte for byte.