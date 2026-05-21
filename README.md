# @vibecontrols/vibe-plugin-plan

Plan orchestration meta-plugin for the [VibeControls](https://vibecontrols.com)
agent. Owns the `PlanProvider` contract and the `/api/plan/*` REST surface;
dispatches plan sessions to a registered provider (e.g.
[`@vibecontrols/vibe-plugin-plan-plannotator`](https://github.com/algoshred/vibe-plugin-plan-plannotator)).

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-plan
vibe plugin install @vibecontrols/vibe-plugin-plan-plannotator
```

## REST API

All routes are mounted under `/api/plan` on the agent.

| Method   | Path                            | Description                                                         |
| -------- | ------------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/health`                       | Provider count + active session count                               |
| `GET`    | `/providers`                    | List registered providers with capabilities                         |
| `GET`    | `/providers/:name/capabilities` | Capabilities for a specific provider                                |
| `POST`   | `/sessions`                     | Start a plan session via the chosen provider                        |
| `GET`    | `/sessions`                     | List sessions (filters: `status`, `projectId`, `provider`, `limit`) |
| `GET`    | `/sessions/:id`                 | Read a session — refreshes from the provider if still active        |
| `POST`   | `/sessions/:id/feedback`        | Submit approve/deny feedback with optional annotations              |
| `DELETE` | `/sessions/:id`                 | End a session                                                       |

`POST /sessions` body:

```json
{
  "provider": "plannotator",
  "projectId": "vibe-abc123",
  "mode": "plan",
  "prompt": "## Plan\n- step 1\n- step 2",
  "agent": "claude-code"
}
```

## CLI

```bash
vibe plan providers           # list providers
vibe plan list                # list sessions
vibe plan status <id>         # show one session
vibe plan end <id>            # end a session
```

## Writing a provider

Implement the `PlanProvider` interface from this package and register it
in your plugin's `onServerStart`:

```ts
import type { PlanProvider } from "@vibecontrols/vibe-plugin-plan";

const provider: PlanProvider = { /* ... */ };

async onServerStart(_app, host) {
  host.serviceRegistry?.registerProvider?.("plan", provider, "my-provider");
}
```

The meta plugin's routes will resolve your provider by name (`body.provider`)
or pick the default-registered one.

## Development

```bash
bun install
bun run sanity   # lint, type:check, test, build
```

## License

Proprietary — Burdenoff Consultancy Services Pvt. Ltd.
