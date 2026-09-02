# ADR 0004 — Price customer annoyance as a currency

**Status:** Accepted
**Date:** 2026-09-02
Supersedes an earlier design that scored rupees only.

## Context

The first scoreboard ranked strategies on net value: recovered minus spend. The
reason-aware agent won — and posted 1,101 annoyance points against fixed
dunning's 212. It was winning by being noisier.

We then checked whether a stricter cost model would fix that, and found it could
not. At a median ticket of about ₹850 against per-message costs measured in
paise, recovery outweighs spend by two orders of magnitude. Return on spend ran
109x to 530x across every scenario. **No defensible cost table makes aggression
unprofitable.** Making a naive strategy lose money would need per-retry costs
around ₹375 — that is not a cost model, it is a rigged benchmark, and a panel
would find it immediately.

## Decision

Give annoyance an explicit exchange rate and fold it into the same arithmetic as
rupees.

```
SPAM_POINT_PRICE_PAISE = 2000     // Rs 20 per annoyance point

email 1 pt    sms 5    whatsapp 5    voice 10    silent retry 0
```

The headline metric becomes:

```
net value after annoyance = recovered - spend - (spam points x Rs 20)
```

## Why

The binding constraint on a recovery system was never the message cost. It is
that customers get irritated, issuers notice repeated authorisation attempts
against flagged instruments, and merchants lose relationships. Those are real
costs that simply are not denominated in rupees.

Pricing them makes restraint fall out of the same expected-value calculation as
everything else, rather than being bolted on as a special rule. The agent is not
uniformly polite or uniformly pushy — it is **proportionate**. A ₹400 abandoned
cart earns an email and nothing louder. A ₹50,000 receivable earns a WhatsApp
message, because there the intrusion is genuinely worth it.

Reporting a single number matters too. Rupees and annoyance in separate columns
invites a reader to pick whichever supports their conclusion. One number forces
the trade to be explicit, at a rate we state openly and that can be argued with.

## Consequences

- Agent spam fell 1,101 → 705 while recovery *rose* ₹8.03L → ₹9.16L: it had been
  spending expensive channels on cases too small to justify them.
- The ₹20 figure is a judgement call and the results are sensitive to it. Raise
  it and the agent goes quiet; lower it and it gets pushy. Stated in the open
  rather than buried, so a reader who disagrees can see exactly what it changes.
- Cases can now carry negative net value: a small amount retried unsuccessfully
  costs money and returns nothing. That is correct, and it is visible.
