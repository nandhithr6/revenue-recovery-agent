# Payments primer

Domain background for this project. Written so the design decisions elsewhere in
`docs/` are readable without prior payments knowledge.

## The players in one payment

**A card payment** touches six parties, any of which can fail:

```
Customer -> Merchant site -> Razorpay -> Acquiring bank -> Card network -> Issuing bank
                                                          (Visa/RuPay)     (customer's bank)
```

- **Issuing bank** — issued the customer's card. Approves or declines, because it
  is their money at risk.
- **Acquiring bank** — on the merchant's side, receives the funds.
- **Card network** — Visa, Mastercard, RuPay. The rails between the two banks.

**A UPI payment** takes a different path, and this is the India-specific part:

```
Customer -> UPI app -> NPCI -> Customer's bank -> Merchant's bank
```

- **NPCI** — National Payments Corporation of India. Runs UPI, RuPay and IMPS.
  Effectively national payments infrastructure.
- **VPA** — Virtual Payment Address (`name@okhdfcbank`). A pointer to a bank
  account, so the account number is never exposed.

UPI dominates Indian digital payments, which is why this project's simulated
cohorts are UPI-weighted and why the taxonomy covers UPI error codes rather than
cards alone.

## Vocabulary

| Term | Meaning |
|---|---|
| **Merchant** | The business accepting payment. Razorpay's customer. |
| **Payment aggregator** | Razorpay's role: routes payments, holds the RBI licence to do so. |
| **Authorisation** | The bank confirming the funds exist and holding them. |
| **Capture** | Actually taking the held funds. Separate step from authorisation. |
| **Settlement** | Money reaching the merchant's account, typically days later. |
| **Success rate / auth rate** | Share of attempted payments that succeed. The metric merchants care most about. |
| **MDR** | Merchant Discount Rate. The per-transaction cut the merchant pays. |
| **Chargeback** | Customer disputes a payment with their bank; funds are reversed out of the merchant. |
| **Mandate / e-mandate / autopay** | Standing authorisation to charge repeatedly — subscriptions, EMIs, SIPs. |
| **Dunning** | The process of chasing failed recurring payments. Precisely this project's subject. |
| **Receivables** | Invoices issued but unpaid. B2B money owed. |
| **Downtime** | A bank or gateway temporarily broken. Razorpay publishes a Downtime API for it. |
| **2FA / OTP** | RBI mandates an additional authentication factor in India. Also a significant source of drop-off. |
| **Tokenisation** | RBI prohibits merchants storing raw card numbers; a network token is stored instead. |
| **DND** | TRAI's Do Not Disturb registry. Covers commercial calls and SMS. |

## Why payments fail often in India

Three structural reasons, all of which the recovery classes map onto:

1. **Bank infrastructure has real downtime.** Individual banks and gateways go
   down for stretches. Nothing is wrong with the customer or the instrument;
   waiting is the fix. → `TRANSIENT_INFRA`
2. **The mandatory OTP step adds a drop-off point.** Every additional screen
   loses some customers mid-flow. → `ABANDONMENT`, `AUTH_FAILURE`
3. **Scale strains the rails.** High-volume UPI traffic produces timeouts and
   collect-request expiries that are not really declines at all.

Add ordinary causes — empty balances before payday, expired cards, exhausted
daily limits — and a meaningful share of attempted payments fail for reasons that
are individually fixable.

That is the gap this project addresses. The customer wanted to pay; the money did
not move; and in most systems nobody follows up intelligently.

## Card data and this project

The recovery path never handles raw card details. A retry references the original
payment by identifier and asks the gateway to re-attempt it — which is both how
Razorpay's API works and what RBI's card-on-file tokenisation rules require.
Nothing in the design would need to change to run against live rails.

## Sources

- Razorpay card error codes — <https://razorpay.com/docs/errors/payments/cards/>
- Razorpay UPI error codes — <https://razorpay.com/docs/errors/payments/upi/>
- Razorpay error structure — <https://razorpay.com/docs/errors/>
