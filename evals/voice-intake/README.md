# Native Voice intake

Runs the real `makeCodexVoiceIntakeDecider` against synthetic live-speech snapshots. The runner imports the production prompt, contracts, isolation and warm-session factory from source. It never dispatches the classified work.

| Model        | Settings                           |
| ------------ | ---------------------------------- |
| `gpt-6-luna` | Priority, medium and low reasoning |

The six cases cover an unfinished utterance containing a complete task, correction of the exact running task, common knowledge, independent current research, an explicitly excluded project and reuse of a completed result. Documents, learning, manager reports and colleague research are represented. All case data is synthetic.

Two additional opt-in regressions cover a chart proposal rejected during a new constraint and a chart explicitly withdrawn afterward. Select them with `--case rejected-chart-keeps-current-constraint,rejected-chart-stays-cancelled --effort low` for six native decisions with the default three samples. The default six-case comparison and its 36-turn cap stay unchanged.

Use an already installed compatible Codex binary and the existing provider OAuth session. No API key is required. The expected binary SHA-256 is mandatory. This eval does not change authentication or install dependencies.

```sh
pnpm voice-intake --out /private/task/native-intake \
  --binary /path/to/compatible/codex --binary-sha256 <verified-sha256>
```

The output directory must be new. `--samples` defaults to three and is capped at three; the entire run is capped at 36 model turns. `--case <comma-separated-ids>`, `--effort low,medium` (the default order), `--model <id>` and `--baseline <summary.json>` are supported. Start with one case and one sample when checking another native runtime. The default full run records the first successful sample in `setup.json` and stops immediately on a protocol, capability or isolation failure, without retrying it.

Each effort uses one isolated temporary working directory and one lease/generation. Decisions run serially through the production factory; all scopes and temporary directories are closed afterward. After each completed effort, the runner verifies that another generation and a closed lease cannot start a native turn. With at most 18 decisions per lease, this run does not reach the factory's 32-turn history rotation. Native initialization, process, thread and turn counts are recorded independently of decision wall time. Any observed native error (including a retry notification), decode failure or isolation violation aborts the decision and closes its scope without a runner retry. Protocol capture retains method names, counts and isolation assertions only; it never stores config or authentication payloads. A production refusal such as `unexpected_capability` may have no decoded decision; this metadata cannot establish its precise cause. Partial runs must report actual completed/attempted counts, the failure duration separately and which lease fences ran.

Every decision receives fresh segment and intent IDs derived from its lease and version. Intent source provenance and the grader's expected target are remapped together; text, revisions, source offsets, quotes and the six rubrics stay unchanged. Earlier snapshots therefore cannot justify duplicate suppression through identical source identity. These remain semantically repeated texts in a warm thread, not statistically independent samples. The fixed effort order and one cold observation per effort also limit latency comparisons. Preserve earlier findings, including the original repeated-ID run and its four Medium omissions; a new run does not erase or pool them into the new methodology.

`results.jsonl` retains the synthetic snapshots, decisions, grader results and durations; `summary.json` reports sample-majority case scores and cleanup. `protocol-metadata.jsonl` contains the sanitized native observations. Cold wall time includes native process/bootstrap cost. Warm wall time includes model decision and validation. Neither is dispatch latency, first audio or end-to-end Voice acceptance.

The automatic grader checks action type/count, intent/project identity, permissions, required task meaning and exact unambiguous source quotes/revisions. Review every decision against the case rubric for unsupported goals or actions; lexical checks alone cannot establish semantic correctness. A case fails when half or more of its samples fail. Preserve failed cases unchanged.

Keep raw grades alongside any manual adjudication. The grader uses a leading word boundary for English “send”, so German “passend” remains valid; sending requests are still rejected. Earlier captures retain the original lexical false positive and its manual adjudication. Incomplete effort groups do not establish a full comparison, and rejected decisions are not valid-decision latency observations.

A full default run consumes 36 paid/subscription model decisions. Monetary cost is not exposed by this native path and is not estimated. Output is private task material with a seven-day manifest; delete the owned captures when they are no longer needed. Do not commit output or real user data.
