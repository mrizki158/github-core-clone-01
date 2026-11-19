# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mrizki158/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mrizki158/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, over its own object store — no git binary, no outside service. It serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 surface under /api/v3 (repositories, issues, pull requests), a GraphQL v4 endpoint at /api/graphql, and an MCP endpoint at /mcp, all behind bearer auth. Locally verified against the kit's 120-check suite: 120/120, for a local score of 984/1000.

## Run it

```sh
MAKEFUN_ENV_URL=<env-url> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=qe91xxve&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
