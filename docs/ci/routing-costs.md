---
summary: "Measured CI provider costs, routing decisions, and the 15-minute qualification"
title: "CI routing costs"
read_when:
  - You are changing CI provider placement or packing budgets
  - You need to distinguish measured workflow walls from planner estimates
---

## Routing from measured wall time

Use GitHub-hosted runners for independent checks that fit the workflow's remaining time. Retain Blacksmith where the measured job tail threatens completion. Qualify RunsOn by workload before assigning it a production tier. Requested Blacksmith 8/16/32 labels delivered 2/4/8 CPUs in the capacity probe; labels are not worker counts.

The table compares eleven successful B1/R1 main runs with five later successful main runs: `35679872894`, `35679457587`, `35678156129`, `35677164460`, and `35675497006`. These are longitudinal observations with different source revisions, not controlled provider comparisons. Values are median [maximum] complete job seconds; a dash means unmeasured. Existing trust, retry, and [hosted assignment admission](/ci/runners#hybrid-hosted-assignment-guard) still apply.

| Job family                                                 |            Blacksmith |                               GitHub-hosted | Hybrid placement               |
| ---------------------------------------------------------- | --------------------: | ------------------------------------------: | ------------------------------ |
| `preflight`                                                |               46 [48] |                                           — | Blacksmith; starts the graph   |
| `security-fast`                                            |                     — |                                     45 [66] | Hosted when admitted           |
| `build-artifacts`                                          |             280 [314] |                                   599 [898] | Blacksmith 16-class            |
| `check-lint`                                               |             461 [499] |                                   624 [631] | Hosted on admitted main pushes |
| `check-lint-core-1` / `-2`                                 |                     — |                       311 [377] / 332 [358] | Hosted                         |
| `check-prod-types`                                         |                     — |                                   240 [282] | Hosted                         |
| `check-test-types`                                         |             358 [387] |                                   608 [664] | Hosted on admitted main pushes |
| `check-test-types-core-1` / `-2`                           | 281 [321] / 257 [329] |                       521 [572] / 496 [524] | Hosted when admitted           |
| `check-dependencies`                                       |             228 [260] |                                   434 [476] | Hosted when admitted           |
| `check-additional-extension-package-boundary`              |             200 [221] |                                   287 [377] | Hosted when admitted           |
| `check-additional-runtime-topology-architecture`           |             133 [161] |                                   289 [320] | Hosted when admitted           |
| `check-additional-boundaries`                              |                     — |                                   217 [232] | Hosted                         |
| `check-bundled-channel-config-metadata`                    |                     — |                                   107 [140] | Hosted                         |
| `check-guards` / `check-npm-lock`                          |                     — |                         148 [192] / 72 [82] | Hosted                         |
| `check-prompt-snapshots` / `check-source-contracts`        |                     — |                        76 [108] / 100 [104] | Hosted                         |
| Fast baseline / Bun launcher / bundled protocol / coercion |                     — | 158 [167] / 110 [147] / 211 [223] / 64 [89] | Hosted                         |
| Fast channel / plugin contracts                            |                     — |                       322 [325] / 225 [248] | Hosted                         |
| `control-ui-performance`                                   |                     — |                                   120 [130] | Hosted                         |
| Docs / Python skills / native and Control UI i18n          |                     — |                        No comparable sample | Retain existing hosted routes  |
| `openclaw/ci-gate`                                         |                     — |                                       3 [6] | Hosted                         |

Independent hosted checks reached at most 664 seconds in this sample. Artifact builds reached 898 seconds before the shared preflight and gate; they retain Blacksmith. Only the gate depends on `build-artifacts`: the workflow does not contain a serial build-to-test job dependency.

| Test family                               | Available complete-job evidence                                                    | Placement and remaining measurement                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Compact large, baseline bin 13            | Blacksmith 932 [967]s across five runs                                             | Retain Blacksmith; correct underestimated serial packing                                   |
| Other compact large bins                  | Blacksmith 57–616s                                                                 | No hosted comparator for the exact inventories                                             |
| Compact small bins                        | Blacksmith 70–731s; bin 23 median 668s                                             | No hosted comparator for the exact inventories                                             |
| Whole agents-support historical benchmark | Blacksmith 706s; hosted 1909s                                                      | Retain Blacksmith for this parallel-heavy workload; do not apply its ratio to every family |
| Changed-extension envelopes               | Recent 47-row PR sample: median 281s, maximum 473s; another sample has a 982s tail | Retain current runner and process boundaries; combined jobs need native proof              |
| UI unit shards                            | Hosted 296/411/317s, one run                                                       | Hosted when admitted                                                                       |
| Control UI E2E shards 1–12                | Blacksmith 269–526s, one run                                                       | Retain 16-class; hosted comparison missing                                                 |
| Browser-extension E2E                     | Hosted 232s, one run                                                               | Hosted when admitted                                                                       |
| Real-Gateway UI E2E                       | Blacksmith 712s, one run                                                           | Retain 32-class                                                                            |
| Windows                                   | Historical Blacksmith 676/797s on the old two-row inventory                        | Retain native route; current five-row and hosted comparison missing                        |
| macOS Node / Swift                        | No successful sample in these receipts                                             | Retain native routes; no latency claim                                                     |

Numbered compact bins change when membership changes. A matching suffix does not establish a matching workload. Full manual native qualification, including iOS and Android, is not proven within fifteen minutes by these Linux measurements.

## RunsOn remains unqualified

The [on-demand pilot](https://github.com/openclaw/openclaw/actions/runs/35549787290) measured the two critical compact jobs at 561/816 seconds on Blacksmith versus 755/1259 seconds on `c8i.4xlarge`: 35%/54% slower. Full Gateway-core failed on AWS at every tested worker count. Cron scaled from 156 to 138 seconds on `c8i.8xlarge` and 126 to 110 seconds on `c8a.8xlarge` at 8 versus 16 workers, but lacks a matching Blacksmith control. Checks, artifact builds, extensions, and UI have no pilot comparison.

The opt-in `runson` profile derives from hybrid and extracts the three `core-runtime-cron-parallel-*` children into one serial job on `c8i.8xlarge`: 32 vCPUs, 64 GiB RAM, `ubuntu24-full-x64`, and an 80 GB gp3 root. On the current inventory, all 258 cron files retain their two-worker job and group ceilings. The three source Blacksmith jobs retain their other children. This profile also separates the two measured serial CLI-process/tooling tail pairs while retaining their Blacksmith 8-class runners. Together these changes take broad-PR Node rows from 101 to 104 and compact rows from 63 to 66, within unchanged caps. Other families retain their hybrid placement. The pilot's full cron configuration used eight workers, so its 156-second wall is a candidate-selection measurement, not a prediction for this two-worker job. Qualify the exact-head Spot job and complete workflow before relying on the fifteen-minute wall; pilot times alone do not qualify this profile.

The CLI pair's measured children took 435.93 and 364.57 seconds; separating them gives a 495.93-second largest job with 60 seconds of setup. The tooling pair took 197.17 and 458.71 seconds, giving a 518.71-second largest separated job. Splits require the exact measured selector-generation keys and preserve complete child contracts, worker limits and deadlines. Changed generations need new evidence. These exceptions apply only to `runson`; the `hybrid` plan is unchanged. The next retained successful tail was 609 seconds, so the same-run model is 97 seconds of admission +609 seconds +97 seconds of gate allowance =803 seconds (13m23s). Failed baseline jobs and variable queues prevent treating that as a wall-time guarantee.

[Baseline run 35688659765](https://github.com/openclaw/openclaw/actions/runs/35688659765) measured these exact child descriptors on three Blacksmith 32-class jobs, each with plan concurrency one: service 122.38 seconds, core 36.40 seconds, and isolated-agent 93.85 seconds. The combined 252.63 seconds is 4.2105 measured serial child minutes, or approximately $0.2695 at the historical $0.064/minute list rate. Extraction removes that child work from Blacksmith before runtime interactions and billing variation; it does not remove the three source jobs or their setup. Their complete job walls include other children and are not a matching comparison. Compare the new AWS job’s allocation cost with this baseline; child work alone does not establish realized net savings.

Selection uses the `runson` backend on a canonical, trusted same-repository PR's first attempt, or the [maintainer qualification dispatch](/ci/runners#runson-qualification) with an exact current PR head. The repository variable remains unchanged. The existing RunsOn GitHub App supplies runners from workflow labels; no interactive AWS login is part of dispatch. The latest operator identity check failed because the AWS SSO session was expired, so administrative state, teardown, and selected-AZ prices remain unverified. The public regional price feed is available without those credentials.

Jobs request `spot=true/retry=false`. Spot has native on-demand fallback when capacity is unavailable; the [provider's fallback documentation](https://runs-on.com/docs/costs/spot-pricing/#default-behavior) describes an additional 2–3 seconds, not a complete assignment SLA. `retry=false` opts out of automatic interruption reruns because the full-workflow recovery delay has not been shown to fit the original 900-second wall. An interruption can therefore fail this qualification. This is a Spot placement experiment, not an interruption-safe fifteen-minute tier.

The selected `c8i.8xlarge` has no local instance-store NVMe. No sticky disk, warm pool, custom image, or storage change is enabled. RunsOn automatically configures local NVMe on compatible instance-store types such as `c8id`; the pilot's corrected overlay verifier has not supplied a live performance comparison for that storage route. See [RunsOn local NVMe](https://runs-on.com/docs/runners/capabilities/local-storage-nvme/).

The [public AWS Spot price feed](https://website.spot.ec2.aws.a2z.com/spot.json) reported `c8i.8xlarge` Linux in `us-east-1` at $0.6586/hour when fetched on September 22, 2026, at 06:02:13 UTC; its HTTP last-modified timestamp was 06:01:21 UTC. This is a current regional reference with no availability-zone identity or assumed averaging method, not the selected runner's billing rate. The $1.49936/hour on-demand reference remains the historical September 17 quote. Using the pilot's 156-second wall gives the following illustrative compute costs:

| `c8i.8xlarge` allocation | Reference compute rate | 156 job seconds | 187 seconds including illustrative allocation |
| ------------------------ | ---------------------: | --------------: | --------------------------------------------: |
| Spot, current regional   |           $0.6586/hour |        $0.02854 |                                      $0.03421 |
| On-demand, historical    |          $1.49936/hour |         $0.0650 |                                       $0.0779 |

Price actual allocation through teardown, then add storage, networking, and control-plane charges. No expected blended rate is claimed without observed fallback and interruption frequencies. The earlier approximately $0.09 sample is not a flat job price. These illustrations do not establish the current subset's speed or cost.

Native [interruption recovery](https://runs-on.com/docs/runners/labels/#retry) remains a future option requiring measured slack. RunsOn [v3.3 permits two automatic reruns](https://runs-on.com/changelog/v3.3.0/) with `retry=when-interrupted`: it waits for the entire workflow attempt to finish, then reruns failed jobs and dependents. Newly launched recovery capacity is on-demand, but GitHub can assign an existing matching Spot runner. Admission must therefore account for `first-attempt completion + retry delays + both failed/dependent replays <= 900s`; merely placing a job off the critical path is insufficient. A 720-second first attempt leaves 180 seconds, less than the pilot's 156-second job plus an illustrative 31-second assignment even before recovery dispatch and the gate.

Report observed interruptions and retry attempts separately from this documented provider behavior. No-capacity fallback or a manually requested rerun is not interruption-recovery proof. Until a complete recovery fits the original wall, the opt-in profile keeps automatic interruption retry disabled and makes no interruption-safe 900-second claim.

## Packing and cost arithmetic

The 300-second changed-extension budget combines the same 119 child envelopes into 40 jobs instead of 47 on the September 22 counting inventory. Estimated work remains 10,140 seconds. At 45–60 seconds of fixed setup per job, the extension slice changes from 204.25–216 to 199–209 machine-minutes: a 5.25–7 minute saving. At the historical 8-class list rate of $0.016/minute, that is $0.084–0.112 per broad PR. Public hosted execution has no metered Linux runner charge; this saving is capacity there, not a cash saving.

The [capacity-pricing correction](https://github.com/openclaw/openclaw/pull/155277) owns compact estimates. Replaying its committed `47b18faa725` inventory with only the extension budget changed gives the following conditional counts. That dependency was still under review when sampled; this table is not qualification of its candidate or proof of the final combined branch.

| Profile    | Broad PR Node rows, 240s → 300s | Unchanged core Node rows | Largest predicted core / extension job |
| ---------- | ------------------------------: | -----------------------: | -------------------------------------: |
| Blacksmith |                       132 → 125 |                       85 |                             595 / 300s |
| Hybrid     |                       130 → 123 |                       83 |                             518 / 300s |
| GitHub     |                       112 → 105 |                       65 |                             330 / 300s |

Each profile also has two dist descriptors outside the Node matrix. Main does not append these extension envelopes. Compact/PR/push/plugin caps stay 90/130/70/50. Worker counts, assertions, test deadlines, runtime-build ownership, and native-worker file ceilings remain unchanged. The workflow no longer promotes extension bundle numbers 16 and 25 to the 16-class: those positions now contain different work and follow their planner-owned 8-class route. Native proof must measure this capacity change too.

Predictions can be wrong. The old 982-second extension job included database-worker, Codex, and Matrix children taking 351/354/125 seconds; the candidate places their corresponding envelopes in separate bundles. Only the Matrix selector is identical. Its 27-second estimate substantially understates the observed 125 seconds. Applying that observation conservatively to all four Matrix children in their candidate bundle gives about 725 seconds including 60 seconds of setup, with uncertainty in the other children still requiring native proof.

## Whole-run acceptance

[Baseline run 35679872894](https://github.com/openclaw/openclaw/actions/runs/35679872894) took 21m18s: 5m20s before preflight creation and 15m58s from preflight creation through the gate. Blacksmith class median assignment was 8/8/3 seconds for 32/16/8-class. Workflow admission and runner assignment are different waits; include both in whole-run latency.

The baseline allocated 29/2/10 active Blacksmith 32/16/8-class jobs and 25 hosted Ubuntu jobs. Skipped placeholders consumed no runners. That is 258.15 Blacksmith machine-minutes; historical label rates imply $13.84, while the campaign's supplied estimate was $18–20. These are pricing assumptions, not an invoice. Moving artifact builds back adds one Blacksmith job and approximately 4.67 Blacksmith minutes using the older build median; extension compaction applies to PRs only.

Completion requires measured main-shaped and broad-fallback PR-shaped runs for each changed profile at or below 900 seconds, with every Blacksmith class median assignment below 60 seconds. Record actual job and step walls, total workflow wall, class counts, and cost against the same baseline. Planner estimates, reduced rows, and a successful test result alone do not establish this performance gate. The routing and packing changes remain unqualified until those exact-head observations exist.
