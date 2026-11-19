# spark-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/NoviliaRahmawati/spark-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/NoviliaRahmawati/spark-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A fast, standalone GitHub-compatible git forge: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4 and MCP, served from one Node 22 process over its own in-memory store. No UI, no outside service, no git binary. Built and performance-tuned by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the contest environment at `$MAKEFUN_ENV_URL`, serves the suite, and exits when the environment reports done. There is nothing to install: standard library only.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1pm982b1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>