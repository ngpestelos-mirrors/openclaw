---
summary: "Tool-call isolation on a Crabbox-leased box: one fixed lease per sandbox scope driven through the SSH backend"
title: "Crabbox backend"
read_when: "You want sandboxed tool execution on a throwaway cloud machine while the Gateway and agent loop stay local."
---

Tool-call isolation on a machine that Crabbox leases for the sandbox scope, using the same SSH transport and remote filesystem bridge as the generic SSH backend.

## Crabbox backend

Use `backend: "crabbox"` to run `exec`, file tools, and media reads on a throwaway machine that [Crabbox](https://github.com/openclaw/crabbox) leases for the sandbox scope. The Gateway, the agent loop, channels, and model credentials stay on the host. This is the option for a personal Gateway that should keep its setup local but must not run model-generated commands on the host and cannot or should not run Docker. To move the whole session off the host instead, use [cloud workers](/gateway/cloud-workers).

The backend leases one box per sandbox runtime with a fixed Crabbox lease ID that is recorded in the sandbox registry, so a Gateway restart adopts the live lease instead of allocating another one. It then hands the lease's SSH endpoint to the [SSH backend](/gateway/sandboxing/ssh-backend): the remote workspace is seeded once and becomes canonical. `openclaw sandbox recreate` stops the lease; because a stopped fixed ID is terminal in Crabbox, the next use mints a new ID and provisions a fresh box. Crabbox chooses the cloud provider. Only direct providers with fixed lease IDs are supported (for example Daytona, AWS, Machine0, and local containers), and Crabbox must be authenticated for that provider on the Gateway host.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "crabbox",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      crabbox: {
        enabled: true,
        config: {
          sandbox: {
            provider: "daytona", // any Crabbox provider with fixed lease IDs
            class: "small",
            ttl: "2h",
            idleTimeout: "30m",
          },
        },
      },
    },
  },
}
```

The `sandbox` block is what registers the backend. `provider`, `class`, `ttl`, `idleTimeout`, and `binary` are optional and fall back to the Crabbox configuration on the host. `agents.defaults.sandbox.ssh.workspaceRoot` still selects the remote root. Lease endpoints and per-lease SSH keys come from `crabbox ssh`, so `agents.defaults.sandbox.ssh.target` and identity settings are ignored. Crabbox records each lease's host key in its per-lease `known_hosts` on first contact, and every later connection must match it; token-based providers such as Daytona put a short-lived token in the SSH user, which the backend refreshes before it expires.

`openclaw sandbox list`/`recreate`/prune treat Crabbox runtimes like other remote runtimes; removing a runtime stops the lease. Every tool call crosses the network, so expect higher latency than Docker, and the lease bills while it idles until `idleTimeout` or `ttl` releases it. The sandboxed browser and `sandbox.docker.binds` are not supported on this backend.
