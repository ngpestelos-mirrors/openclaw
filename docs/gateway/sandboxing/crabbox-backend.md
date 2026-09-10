---
summary: "Tool-call isolation on a Crabbox-leased box: one fixed lease per sandbox scope driven through the SSH backend"
title: "Crabbox backend"
read_when: "You want sandboxed tool execution on a throwaway cloud machine while the Gateway and agent loop stay local."
---

Tool-call isolation on a machine that Crabbox leases for the sandbox scope, using the same SSH transport and remote filesystem bridge as the generic SSH backend.

## Crabbox backend

Use `backend: "crabbox"` to run `exec`, file tools, and media reads on a throwaway machine that [Crabbox](https://github.com/openclaw/crabbox) leases for the sandbox scope. The Gateway, the agent loop, channels, and model credentials stay on the host. This is the option for a personal Gateway that should keep its setup local but must not run model-generated commands on the host and cannot or should not run Docker. To move the whole session off the host instead, use [cloud workers](/gateway/cloud-workers).

The backend leases one box per sandbox scope with a fixed lease ID derived from the scope, so a Gateway restart or a second session in the same scope adopts the existing lease instead of allocating another one. It then hands the lease's SSH endpoint and per-lease key to the [SSH backend](/gateway/sandboxing/ssh-backend): the remote workspace is seeded once and becomes canonical, and `openclaw sandbox recreate` stops the lease so the next use provisions a fresh box. Crabbox chooses the cloud provider. Only direct providers with fixed lease IDs are supported (for example Daytona, AWS, Machine0, and local containers), and Crabbox must be authenticated for that provider on the Gateway host.

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

The `sandbox` block is what registers the backend. `provider`, `class`, `ttl`, `idleTimeout`, and `binary` are optional and fall back to the Crabbox configuration on the host. `agents.defaults.sandbox.ssh.workspaceRoot` still selects the remote root. Lease endpoints and per-lease SSH keys come from `crabbox inspect`, so `agents.defaults.sandbox.ssh.target` and identity settings are ignored, and host keys are not pinned because every lease is a fresh machine.

`openclaw sandbox list`/`recreate`/prune treat Crabbox runtimes like other remote runtimes; removing a runtime stops the lease. Every tool call crosses the network, so expect higher latency than Docker, and the lease bills while it idles until `idleTimeout` or `ttl` releases it. The sandboxed browser and `sandbox.docker.binds` are not supported on this backend.
