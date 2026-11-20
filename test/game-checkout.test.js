import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";
const { db } = await import("../database2.js");
const { beginGameCheckout, cancelGameCheckout, claimPayPalCapture, finishGameCheckout, rememberGameCheckout, reverseGamePayment } = await import("../game-checkout.js");
const { creditPayment, handlePayPalWebhookEvent } = await import("../payments.js");
const { hasGamePurchase } = await import("../products.js");

let counter = 0;
function account() {
  return Number(db.prepare("INSERT INTO users (email,password_hash,created_at) VALUES (?,?,?)")
    .run("checkout-" + ++counter + "@example.test", "test", Date.now()).lastInsertRowid);
}

test("one account has one checkout reservation across providers and retries reuse its key", async () => {
  const user = account();
  const results = await Promise.allSettled([
    beginGameCheckout(user, "stripe"), beginGameCheckout(user, "paypal")
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.match(results[1].reason.message, /checkout is already active/);
  const row = results[0].value;
  assert.equal((await beginGameCheckout(user, "stripe")).checkout_key, row.checkout_key);
  rememberGameCheckout(row, "cs_test_pending", "https://checkout.example");
  assert.equal((await beginGameCheckout(user, "stripe")).checkout_url, "https://checkout.example");
  await cancelGameCheckout(user, "unrelated key");
  await assert.rejects(beginGameCheckout(user, "paypal"), /already active/);
  const stripe = { checkout: { sessions: {
    retrieve: async () => ({ status: "open", payment_status: "unpaid" }),
    expire: async () => ({ status: "expired", payment_status: "unpaid" })
  } } };
  await cancelGameCheckout(user, row.checkout_key, stripe);
  assert.equal((await beginGameCheckout(user, "paypal")).provider, "paypal");
});

test("expired Stripe time cannot release a session unless Stripe confirms it is unpaid and expired", async () => {
  const user = account();
  const row = await beginGameCheckout(user, "stripe");
  rememberGameCheckout(row, "cs_test_processing", "https://checkout.example", Date.now() - 1);
  const stripe = { checkout: { sessions: { retrieve: async () => ({ status: "complete", payment_status: "paid" }) } } };
  await assert.rejects(beginGameCheckout(user, "paypal", stripe), /already active/);
});

test("PayPal capture holds the slot until settlement and a stale order cannot reuse it", async () => {
  const user = account();
  const row = await beginGameCheckout(user, "paypal");
  rememberGameCheckout(row, "pending-paypal", "https://paypal.example");
  assert.throws(() => claimPayPalCapture(user, "different-order"), /expired/);
  claimPayPalCapture(user, "pending-paypal");
  db.prepare("UPDATE game_checkouts SET expires_at=0 WHERE user_id=?").run(user);
  await assert.rejects(cancelGameCheckout(user, row.checkout_key), /being confirmed/);
  await assert.rejects(beginGameCheckout(user, "stripe"), /already active/);
  finishGameCheckout(user, "paypal", "pending-paypal");
  assert.equal((await beginGameCheckout(user, "stripe")).provider, "stripe");
});

function stripeCredit(user, id) {
  const pending = { user_id: user, product_id: "full_game", provider: "stripe", order_id: "cs_" + id,
    amount: "4.99", currency: "USD", minutes: 0, payment_intent_id: id };
  return creditPayment({ pending, eventId: pending.order_id, capturedAmount: "4.99", capturedCurrency: "USD" });
}

test("a delayed success cannot resurrect a reversed payment and a separate valid purchase retains access", () => {
  const user = account();
  reverseGamePayment("stripe", "pi_refunded", "full refund");
  stripeCredit(user, "pi_refunded");
  assert.equal(hasGamePurchase(db, user), false);
  stripeCredit(user, "pi_valid");
  assert.equal(hasGamePurchase(db, user), true);
  reverseGamePayment("stripe", "pi_refunded", "full refund");
  assert.equal(hasGamePurchase(db, user), true);
  reverseGamePayment("stripe", "pi_valid", "lost dispute");
  assert.equal(hasGamePurchase(db, user), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?").get(user).n, 2);
});

test("PayPal partial refunds preserve access and a verified full refund revokes it", async t => {
  const user = account();
  db.prepare("INSERT INTO purchases (id,user_id,provider,product_id,minutes,amount,currency,created_at) VALUES (?,?,?,?,0,?,?,0)")
    .run("paypal:CAPTURE123", user, "paypal", "full_game", "4.99", "USD");
  let status = "PARTIALLY_REFUNDED";
  t.mock.method(globalThis, "fetch", async url => {
    if (url.endsWith("/v1/oauth2/token")) return { ok: true, json: async () => ({ access_token: "test" }) };
    assert.match(url, /\/v2\/payments\/captures\/CAPTURE123$/);
    return { ok: true, json: async () => ({ id: "CAPTURE123", status }) };
  });
  const event = { event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: { links: [{ rel: "up", href: "https://api-m.paypal.com/v2/payments/captures/CAPTURE123" }] } };
  assert.deepEqual(await handlePayPalWebhookEvent(event), { ignored: true });
  assert.equal(hasGamePurchase(db, user), true);
  status = "REFUNDED";
  assert.deepEqual(await handlePayPalWebhookEvent(event), { reversed: true });
  assert.equal(hasGamePurchase(db, user), false);
});

