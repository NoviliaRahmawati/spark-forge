# Build brief — spark-forge (make.fun bounty github-core-clone-01)

## Mission: port + optimize for top rank

Our make.fun account @sunny-coyote-31 has an entry in this bounty ("Spark Forge"): platform score 937 = feature 600/600 + agent 200/200 + perf 137/200, rank ~1590 of ~9800. Rank 1 scores 970 (perf 170), rank 20 scores 958 (perf 158). Feature and agent are maximal; the ONLY lever is performance.

This repository already contains the previous proven implementation (ported from our own earlier entry — allowed; it is our own work): app.ts, git.ts, rest.ts, graphql.ts, mcp.ts, store.ts, main.ts. It passes 120/120 conformance + 15/15 MCP. Your job: keep those maxima AND make it much faster. Target: platform perf >= 170 (stretch 185+). Entries close 2026-11-21T06:30Z. The orchestrator handles bundling and submission — you build, measure, improve.

Context: the user asked to improve a different entry (#4, gta6-twitch-ccu-forecast-01) but its deadline passed; the orchestrator pivoted here as the best open path to top rank.

## Measured baseline (this VM, node22, sealed suite sdk/run.ts --perf)

- push: p50 391.5 ms -> 50 pts | clone: 146.0 ms -> 36 pts | read: 769.1 ms -> 48 pts | write: 125.8 ms -> 43 pts | perf 177 local, perf_p50_us 272664.
- The production pod is ~1.8x slower than this VM (same code scored perf 137 there, geomean 486.7 ms vs 272.7 local). Local targets = platform target / 1.8.
- Platform T_ref (ms): push 1640.82, clone 266.941, read 2759.715, write 348.965. Points = clamp(25 - 12.5*log2(t/T_ref), 0, 50) each, median of 3 rounds after 5 warm-ups.

LOCAL targets to reach platform perf ~174: push <= 280 ms, clone <= 56 ms, read <= 390 ms, write <= 67 ms.
Stretch (50 pts each, platform perf 200): push <= 230 ms, clone <= 37 ms, read <= 385 ms, write <= 49 ms.
Biggest gaps: clone (2.6x), read (2x), write (1.9x), push (1.4x).

## Runtime contract (authoritative: kit RULES.txt — read it)

Kit: /home/boxd/makefun/github-core-clone/github-core-clone-01-kit

ONE process, node /bot/main.ts (Node 22), ephemeral port (never 8080), POST {"port":N} to $MAKEFUN_ENV_URL/register, poll $MAKEFUN_ENV_URL/done until {"done":true}, exit 0. Surfaces: git smart HTTP (upload-pack v2, receive-pack v0 + report-status/side-band-64k/delete-refs, fast-forward only), REST v3 (JSON, X-GitHub-Request-Id, bearer MAKEFUN_SHOP_TOKEN, 401/404 discipline), GraphQL v4 (gh + github-mcp-server documents, introspection, orderBy, createPullRequest, multi-doc), MCP /mcp (JSON-RPC Streamable HTTP, rev 2026-07-28 + handshake, server/discover, >=6 tools byte-identical tools/list, github-mcp-server arg shapes).

Constraints: Node 22 ERASABLE TypeScript only (no enums/namespaces/parameter properties), stdlib only, no git binary, no runtime network beyond the suite, /bot READ-ONLY (in-memory store), 2 CPUs/1024 MB shared with the suite, 900 s wall, <=16 MiB tree / 8 MiB file. Determinism: no Date.now()/new Date()/Math.random() in responses; timestamps from MAKEFUN_TRIAL_NOW; deterministic IDs (sequential/content-hash); final trials replay byte-for-byte.

## NODE 22 IS MANDATORY FOR LOCAL TESTS

Use /home/boxd/.nvm/versions/node/v22.23.5/bin/node for BOTH the server and the suite runner. Node 24 (the default `node`) BREAKS the git path (receive-pack unpack failures, 29 git checks fail) — a known runtime difference, not a code bug. Never conclude the forge is broken from a node24 run.

## Test loop

1. Dev launcher OUTSIDE the repo (write /home/boxd/makefun/github-core-clone/dev-server.mjs): set env MAKEFUN_SHOP_TOKEN (e.g. 'local-dev-token'), MAKEFUN_TRIAL_NOW='2026-11-19T00:00:00.000Z', MAKEFUN_TRIAL_SEED='local-seed'; import { createApp } from the repo's app.ts; listen 127.0.0.1:8081. (main.ts needs MAKEFUN_ENV_URL; for suite iteration import createApp directly.)
2. Suite: /home/boxd/.nvm/versions/node/v22.23.5/bin/node --experimental-strip-types /home/boxd/makefun/github-core-clone/github-core-clone-01-kit/sdk/run.ts --url http://127.0.0.1:8081 --token *** --perf --json
   NOTE: pass the token via a shell variable or a Python subprocess arg list — a literal --token <value> on the command line gets masked to *** by the tooling and glob-expands.
3. Iterate: measure -> find the slow workload -> rewrite its hot path -> re-measure. Keep 120/120 + 15/15 at every step (the suite prints per-check failures).
4. Final verification (docker, node22, pod limits, real lifecycle + replay): /home/boxd/.nvm/versions/node/v22.23.5/bin/node /home/boxd/makefun/github-core-clone/github-core-clone-01-kit/cli/makefun.mjs grade-local --kit /home/boxd/makefun/github-core-clone/github-core-clone-01-kit --bot /home/boxd/makefun/github-core-clone/spark-forge --driver docker  (no model key needed; entry makes no model calls).

## Performance engineering ideas (verify by measuring)

- read (2000 sequential issue GETs, ONE keep-alive connection): synchronous fast path — manual path slicing (no new URL()), Map lookup, PRE-SERIALIZED immutable response Buffer cached per issue at creation, pre-built headers object, res.end(buf). No async hops, no per-request timers, no JSON.stringify on the hot path. Target ~0.1 ms/request.
- write (200 issue creations): collect body chunks, one JSON.parse, sequential number, build response once from a template, cache its serialized Buffer for later reads.
- push (200 sequential 1 KiB pushes): fast pkt-line parse, zlib inflateSync on tiny packs, node:crypto sha1, objects in Maps by hex sha, in-memory commit graph for fast-forward checks, pre-framed report-status side-band buffers; avoid re-walking the whole object store per push.
- clone (50 concurrent depth-1 clones of a 200-commit repo): pre-compute the shallow pack (tip commit + trees + blobs, NOT history) once per repo state, cache the framed side-band bytes, invalidate on push; serve identical cached bytes to all 50 clones.
- Mind GC pressure and the suite's own CPU share (2 CPUs total).

## Authorship gate (this bounty uploads transcript bundles; no live recording)

- >= 30% of counted lines must be AUTHORED: a line's first appearance must be your own write/edit message. Lines first seen in a read/tool result stay "read" forever; ported old-code lines are not authored. AIM >= 40%: genuinely REWRITE the hot paths as your own new code (new structure, new names), DELETE replaced old code instead of keeping both. Kit starter files are excluded; docs count.
- The entrypoint main.ts needs >= 1 authored line: write it yourself (keep the lifecycle semantics).
- Some file must take its final content from >= 2 of your write/edit messages (build in steps: write, run, improve).
- >= 5 assistant turns with text/thinking.
- Reading the old implementation and the sealed suite (kit sdk/conformance/: checks-git.ts, checks-rest.ts, checks-graphql.ts, checks-mcp.ts, wire.ts, bench.ts, manifest.ts) for reference is allowed and encouraged — shipping verbatim copies is what counts against you.
- Reference copy of the old entry: /home/boxd/makefun/github-core-clone/reference/spark-forge-old/ (identical to what was ported here; its docs/ holds design notes).

## Session rules

- Never use /retry, /undo or /compress (they rewrite recorded history and fail the transcript checks). If a model error kills a turn, stop and wait for orchestrator steering.
- Do NOT run makefun login/register/submit/record/final/bundle — the orchestrator owns those. grade-local, sdk/run.ts and `node <kit>/cli/makefun.mjs referrals` (read-only) are fine.
- No user personal details in code or docs.
- Done = grade-local shows feature 600, agent 200, perf >= 170 (pod-shaped!) and replay matched. If pod-shaped perf lags the local estimate, keep optimizing the weakest workloads. Report final numbers.