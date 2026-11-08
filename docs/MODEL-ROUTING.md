# Bubu v2 — Default Model Routing

The default model IDs are selected from the exact catalog the owner supplied. The mapping is benchmark-informed, not a claim that provider-side benchmark scores are guaranteed to reproduce through Sumopod.

| Task tier | Default Sumopod model | Why this role |
|---|---|---|
| Fast | `claude-haiku-5-5` | Anthropic positions Haiku 5.5 for high-volume, latency-sensitive tasks, classification, routing, summaries and subagent work. |
| Balanced | `claude-sonnet-5-5` | Strong speed/intelligence/cost balance for everyday agent work, coding, and knowledge tasks. |
| Reasoning / Agent | `claude-opus-5-5` | Stronger fit for complex, open-ended work requiring sustained judgment and long-horizon agentic execution. |
| Coding | `claude-sonnet-5-5` | Strong coding benchmark results at lower cost than Opus; suitable for routine coding and debugging. |
| Long-context summary | `gemini/gemini-3.1-pro-preview` | Strong reasoning and long-context capability; suitable for synthesizing large source material. |

## Public benchmark evidence

- Anthropic's Haiku 5.5 release positions it as its fastest and most cost-efficient model for high-volume tasks. The release reports Terminal-Bench 4.0 at 39.2%, while explicitly recommending larger models for complex agentic coding. Source: https://www.anthropic.com/claude-haiku-5-5
- Anthropic's Sonnet 5.5 release reports Terminal-Bench 4.0 at 70.6%, CursorBench 4.0 at 55.5%, and describes Sonnet as a faster, lower-cost complement to Opus. Source: https://www.anthropic.com/claude-sonnet-5-5
- Anthropic's Opus 5.5 release reports Terminal-Bench 4.0 at 66.4%, FrontierCode v1.1 at 54.4%, and GDPval-AA v2.1 at 1846; Anthropic positions Opus for complex coding, agentic work, and knowledge work. Source: https://www.anthropic.com/claude-opus-5-5
- Google DeepMind's Gemini 3.1 Pro model card reports GPQA Diamond 94.3%, HLE 44.4%, SWE-bench Verified 80.6%, Terminal-Bench 2.0 68.5%, and a 1M-token long-context evaluation. Source: https://deepmind.google/models/model-cards/gemini-3-1-pro/

Benchmark scores use different harnesses, effort settings, and evaluation dates. They are signals for workload assignment, not a single directly comparable league table.

## Minimal `.env`

No model variables are required. Defaults live in `src/config/env.js`.

Optional overrides:
```env
# MODEL_FAST=claude-haiku-5-5
# MODEL_BALANCED=claude-sonnet-5-5
# MODEL_REASONING=claude-opus-5-5
# MODEL_CODING=claude-sonnet-5-5
# MODEL_SUMMARY=gemini/gemini-3.1-pro-preview
```

The model router maps task categories to these tiers. Sumopod is the only provider. No secondary provider fallback is configured.

## Provider compatibility note

The Sumopod gateway is used through its OpenAI-compatible `/chat/completions` endpoint. Bubu does not force `temperature` because recent Claude models use adaptive thinking and may reject temperature/top-p parameters. Tool calls are passed using the OpenAI-compatible `tools` field.
