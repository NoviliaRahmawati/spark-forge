# Build brief — spark-forge (make.fun bounty github-core-clone-01)

FIRST TASK, before any code: rewrite this AGENTS.md in your own words, keeping every rule and path below, and write README.md fresh from the template at the bottom. Both are pre-existing counted files: the transcript gate fails an entry whose counted file keeps its recording-start content with no line written by the recorded agent. Do this first, in this session.

## Mission

Our make.fun account @sunny-coyote-31 already has an entry in this bounty ("Spark Forge", a source bundle built elsewhere): score 937 = feature 600/600 + agent 200/200 + perf 137/200, rank ~1590 of ~9800. Feature and agent are already maximal. The ONLY lever left is performance. Rank 1 scores 970 (perf 170), rank 20 scores 958 (perf 158).

Your job: build a NEW, faster forge in this repository that keeps 120/120 conformance checks and 15/15 MCP checks AND scores perf >= 170 (stretch 185+). The user's goal is top rank. Entries close 2026-11-21T06:30Z; the orchestrator handles submission — you build and test.

Context note: the user asked to improve a different entry (#4, gta6-twitch-ccu-forecast-01), but its entry deadline passed (2026-11-19T01:00Z). The orchestrator pivoted to this bounty as the best open path to top rank. This repository is that build.

## The task (authoritative: kit RULES.txt)

Kit: /home/boxd/makefun/github-core-clone/github-core-clone-01-kit — read RULES.txt fully first.

A standalone GitHub-compatible git forge: ONE process, `node /bot/main.ts` (Node 22), binds an ephemeral port (never 8080), POSTs {"port": N} to $MAKEFUN_ENV_URL/register, long-polls $MAKEFUN_ENV_URL/done until {"done": true}, exits 0. It serves from its own in-memory store, no UI:
- git smart HTTP at /{owner}/{repo}.git — upload-pack protocol v2 (Git-Protocol: version=2), receive-pack v0 with report-status, side-band-64k, delete-refs; fast-forward-only pushes
- REST v3 under /api/v3 (repos, issues, pulls, labels, contents; JSON always, X-GitHub-Request-Id header non-empty; bearer auth via MAKEFUN_SHOP_TOKEN, 401 without; wrong owner = 404)
- GraphQL v4 at /api/graphql (the documents gh and github-mcp-server send; introspection for Issue/PullRequest/Repository/SearchType; orderBy CREATED_AT DESC; createPullRequest; multi-document bodies; unknown field = 200 + errors)
- MCP at /mcp (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 + handshake fallback, server/discover, tools/list with >= 6 tools byte-identical across calls, tools/call with github-mcp-server argument shapes, proper error codes)

Runtime constraints: Node 22 erasable TypeScript only (no enums, namespaces, parameter properties — type stripping), standard library only, no git binary, no network beyond the suite at runtime, /bot is READ-ONLY (store must be in-memory), 2 CPUs / 1024 MB shared with the suite, 900 s wall, <= 16 MiB whole tree / 8 MiB per file. main.ts keeps the starter's lifecycle semantics but you write the file yourself (the entrypoint needs >= 1 authored line).

Determinism (final trials run live + replay, exports must match byte for byte): no Date.now()/new Date()/Math.random() in anything a response carries; timestamps come from MAKEFUN_TRIAL_NOW; IDs sequential or content-hashed; X-GitHub-Request-Id may be a deterministic counter. Two runs on the same instance must produce identical responses.

## Reference material (read, do not copy)

1. Our previous proven implementation (120/120 + 15/15, perf 137): /home/boxd/makefun/github-core-clone/reference/spark-forge-old/ — app.ts, git.ts, rest.ts, graphql.ts, mcp.ts, store.ts, main.ts. Read it to understand protocol shapes and edge cases. WRITE ALL CODE YOURSELF: the authorship gate counts a line's FIRST appearance — lines first seen in a read/tool result stay "read" even if you write them later, and >= 30% of counted lines must be authored by your own writes (aim >= 70%; the kit's unchanged starter files are excluded). Do not copy files or re-type old code verbatim; write your own implementation with your own structure. Some files must take their final content from >= 2 of your write/edit messages (build in steps: write, run, improve).
2. The sealed suite itself: kit sdk/conformance/ (checks-git.ts, checks-rest.ts, checks-graphql.ts, checks-mcp.ts, wire.ts, bench.ts, manifest.ts, calibration.json) — the exact checks, the seeded scenario, the benchmark protocol. This is the spec; read the checks you implement.

## Performance engineering (the whole point)

T_ref (reference forge medians, ms): push 1640.82 (200 sequential 1 KiB pushes), clone 266.941 (50 concurrent depth-1 clones of a 200-commit repo), read 2759.715 (2000 sequential issue GETs on ONE keep-alive connection), write 348.965 (200 sequential issue creations). Points per workload = clamp(25 - 12.5*log2(t/T_ref), 0, 50); perf = sum. Each workload: median of 3 timed rounds after 5 warm-ups, inputs pre-built.

Targets to beat rank 1 (perf ~170 needs geometric-mean ratio ~0.38; aim better): push <= 500 ms, clone <= 100 ms, read <= 700 ms, write <= 120 ms (that combination ~ perf 183). Ideas, verify with measurements:
- read/write hot paths: synchronous request handling, manual path slicing instead of new URL(), pre-serialized immutable response Buffers cached per issue (issue GET responses never change after creation), pre-built header objects, res.end(buffer) with content-length; no per-request timers, no async hops on the hot path.
- push: tiny packs — fast pkt-line parse, zlib inflateSync on small buffers, node:crypto sha1, objects in Maps keyed by hex sha, in-memory commit graph for fast-forward checks, pre-framed report-status side-band responses.
- clone: pre-compute the depth-1 pack (tip commit + trees + blobs, NOT history) once per repo state, cache the framed side-band buffer, invalidate on push; serve the same bytes to all 50 concurrent clones.
- Keep the suite's own CPU needs in mind (2 CPUs shared): avoid busy work, avoid GC pressure (reuse buffers where safe).

## Test loop (use it constantly)

Fast iteration — the sealed suite against your running server:
1. Start your server locally with a dev launcher OUTSIDE the repo (e.g. /home/boxd/makefun/github-core-clone/dev-server.mjs importing this repo's app.ts): set MAKEFUN_SHOP_TOKEN (the bearer the suite presents; the token names the login that owns repos — read wire.ts), MAKEFUN_TRIAL_NOW (a fixed ISO time), MAKEFUN_TRIAL_SEED; listen on 127.0.0.1:8081. The repo's main.ts needs MAKEFUN_ENV_URL, so for suite iteration import createApp() directly.
2. Run: node --experimental-strip-types /home/boxd/makefun/github-core-clone/github-core-clone-01-kit/sdk/run.ts --url http://127.0.0.1:8081 --token *** --perf [--json]
3. Iterate until 120/120 feature + 15/15 MCP and the perf targets. Local node is v24; the pod runs node22 — keep TS erasable and stdlib-only.

Full trial verification (docker, node22, real lifecycle + replay determinism), before you declare done:
node /home/boxd/makefun/github-core-clone/github-core-clone-01-kit/cli/makefun.mjs grade-local --kit /home/boxd/makefun/github-core-clone/github-core-clone-01-kit --bot /home/boxd/makefun/github-core-clone/spark-forge --driver docker
(no model key needed — this entry makes no model calls). It prints every column and the replay verdict.

## Rules of the session

- You are recorded live by make.fun (strict transcripts). Never use /retry, /undo or /compress; never delete or rewrite session history. If a model error kills a turn, stop and wait — the orchestrator will steer you.
- Do NOT run makefun login/register/submit/record/final — the orchestrator owns the account and submission. You may run grade-local, sdk/run.ts, and `node <kit>/cli/makefun.mjs referrals` (read-only) for the README ref code.
- Keep going until the full grade-local trial shows feature 600, agent 200, perf >= 170 and a matching replay. Report the final numbers.
- No personal details of the user in code or docs.

## README.md template (fill {description} and {run}; owner/repo already filled; get {referral_code} from `node <kit>/cli/makefun.mjs referrals`)

# spark-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/NoviliaRahmawati/spark-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/NoviliaRahmawati/spark-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

{description}

## Run it

```sh
{run}
```

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>