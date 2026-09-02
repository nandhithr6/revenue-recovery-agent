# Architecture Decision Records

Why the system is shaped the way it is. Each ADR records the context, the
decision, and the trade accepted — including the ones that went against us.

| # | Decision |
|---|---|
| [0001](0001-simulate-rather-than-integrate.md) | Simulate the rails, adopt Razorpay's real error taxonomy |
| [0002](0002-guardrails-outside-the-policy.md) | Guardrails live outside the policy — the brain proposes, the brakes decide |
| [0003](0003-where-we-chose-not-to-use-an-llm.md) | **Where we chose *not* to use an LLM** |
| [0004](0004-price-annoyance-as-a-currency.md) | Price customer annoyance as a currency |
| [0005](0005-the-agent-must-not-read-ground-truth.md) | The agent must not read the simulator's ground truth |
| [0006](0006-defer-do-not-drop.md) | Compliance defers, it does not drop |

See also [ENGINEERING-LOG.md](../ENGINEERING-LOG.md) — what broke during the
build and what we did about it.
