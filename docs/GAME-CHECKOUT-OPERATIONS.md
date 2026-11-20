# One-time checkout operations

Breluce keeps one active full-game checkout per account across Stripe and PayPal. Returning through a provider's cancellation link releases an unpaid checkout. Stripe must confirm expiration before the account can switch providers. PayPal captures that may have succeeded stay reserved until their outcome is reconciled. Completed payments and previous hourly credits are recorded separately.

## Webhook subscriptions

Add these events to the existing production webhook destinations. Keep the existing signing secrets and completed-payment subscriptions.

- Stripe at `/api/webhooks/stripe`: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, and `charge.dispute.closed`. Keep `checkout.session.async_payment_succeeded` if the previous Stripe configuration allowed delayed payment methods.
- PayPal at `/api/webhooks/paypal`: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, and `PAYMENT.CAPTURE.REVERSED`.

A full refund, a lost Stripe dispute, or a PayPal capture reversal removes access from that purchase. A partial refund keeps access. A separate valid full-game purchase, legacy play-time credits, and manually granted free access remain available.

## Rollout checks

- Test card and PayPal in separate sandbox accounts. Open the second provider while the first checkout is active. Cancel the first checkout and confirm the second can then open.
- Complete a sandbox purchase and confirm that repeating the completion event cannot add another purchase. Issue a partial refund, then refund the remainder. Check the account after each event.
- Stripe sessions created before this rollout are outside the new reservation. Review or expire outstanding pre-rollout full-game sessions in Stripe before advertising checkout. A previously opened, uncaptured full-game PayPal order must be restarted after rollout, and completed captures still reconcile through their webhook.
- If a provider call fails with an uncertain payment result, verify the provider's records before releasing a reservation. Reconcile completed or reversed payments through the provider webhook.

