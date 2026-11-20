import { describe, test, expect, afterEach } from "@jest/globals";
import { db } from "../../database2.js";
import { Session, BASE_URL, uniqueEmail, TEST_PASSWORD, signStripePayload } from "./helpers.js";

const secret = process.env.STRIPE_WEBHOOK_SECRET;
const maybe = secret ? describe : describe.skip;

async function createVerifiedUser(cleanupEmails) {
  const email = uniqueEmail("stripe");
  cleanupEmails.push(email);
  const session = new Session(BASE_URL);
  await session.postCsrf("/api/signup", { email, password: TEST_PASSWORD });
  db.prepare(`UPDATE users SET email_verified=1 WHERE email=?`).run(email);
  const row = db.prepare(`SELECT id FROM users WHERE email=?`).get(email);
  return row.id;
}

function checkoutSessionEvent({ id, userId, productId = "hour", amountTotal = 200, currency = "usd" }) {
  return {
    id: `evt_${id}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id,
        payment_status: "paid",
        amount_total: amountTotal,
        currency,
        metadata: { userId: String(userId), productId }
      }
    }
  };
}

async function postWebhook(payload, signatureHeader) {
  const res = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signatureHeader },
    body: payload
  });
  return { status: res.status, body: await res.json() };
}

// Skipped automatically unless the server and this test process share the
// same STRIPE_WEBHOOK_SECRET (i.e. both loaded the same .env / test env).
maybe("Stripe webhook \u2014 signed test events (no real Stripe checkout needed)", () => {
  const cleanupEmails = [];
  afterEach(() => {
    // purchases intentionally don't cascade-delete with users (financial
    // audit records survive account deletion), so remove them first.
    while (cleanupEmails.length) {
      const email = cleanupEmails.pop();
      const user = db.prepare(`SELECT id FROM users WHERE email=?`).get(email);
      if (user) db.prepare(`DELETE FROM purchases WHERE user_id=?`).run(user.id);
      db.prepare(`DELETE FROM users WHERE email=?`).run(email);
    }
  });

  test("valid checkout.session.completed credits time once; replay is ignored as duplicate", async () => {
    const userId = await createVerifiedUser(cleanupEmails);
    const sessionId = `cs_test_${Date.now()}`;
    const event = checkoutSessionEvent({ id: sessionId, userId });

    const first = signStripePayload(event, secret);
    const firstRes = await postWebhook(first.payload, first.signatureHeader);
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.credited).toBe(true);

    // Same event, re-signed (fresh timestamp) but same session id — must no-op.
    const replay = signStripePayload(event, secret);
    const replayRes = await postWebhook(replay.payload, replay.signatureHeader);
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.duplicate).toBe(true);
  });

  test("a full-game purchase unlocks the account without consuming previous play time", async () => {
    const userId = await createVerifiedUser(cleanupEmails);
    db.prepare("INSERT INTO time_tracking (user_id,remaining_seconds,updated_at) VALUES (?,75,0) ON CONFLICT(user_id) DO UPDATE SET remaining_seconds=75").run(userId);
    const user = db.prepare("SELECT email FROM users WHERE id=?").get(userId);
    const session = new Session(BASE_URL);
    await session.postCsrf("/api/login", { email: user.email, password: TEST_PASSWORD });
    const event = checkoutSessionEvent({ id: "cs_test_full_" + userId + "_" + Date.now(), userId, productId: "full_game", amountTotal: 499 });
    const { payload, signatureHeader } = signStripePayload(event, secret);
    expect((await postWebhook(payload, signatureHeader)).body.credited).toBe(true);
    expect((await postWebhook(payload, signatureHeader)).body.duplicate).toBe(true);
    expect((await session.request("GET", "/api/access")).body).toMatchObject({ ownsGame: true, canPlay: true, remainingSeconds: null, accessExpiresAt: null });
    expect((await session.request("GET", "/game")).status).toBe(200);
    expect((await session.postCsrf("/api/access/heartbeat", {})).body.ownsGame).toBe(true);
    expect(db.prepare("SELECT remaining_seconds FROM time_tracking WHERE user_id=?").get(userId).remaining_seconds).toBe(75);
    const checkout = await session.postCsrf("/api/checkout/stripe", { productId: "full_game", withdrawalConsent: true });
    expect(checkout.body.error).toMatch(/already owns/);
  });

  test("wrong currency in webhook payload is rejected", async () => {
    const userId = await createVerifiedUser(cleanupEmails);
    const event = checkoutSessionEvent({ id: `cs_test_${Date.now()}_cur`, userId, currency: "eur" });
    const { payload, signatureHeader } = signStripePayload(event, secret);
    const res = await postWebhook(payload, signatureHeader);
    expect(res.status).toBe(400);
  });

  test("wrong amount in webhook payload is rejected", async () => {
    const userId = await createVerifiedUser(cleanupEmails);
    const event = checkoutSessionEvent({ id: `cs_test_${Date.now()}_amt`, userId, amountTotal: 999999 });
    const { payload, signatureHeader } = signStripePayload(event, secret);
    const res = await postWebhook(payload, signatureHeader);
    expect(res.status).toBe(400);
  });

  test("unknown product in webhook metadata is rejected", async () => {
    const userId = await createVerifiedUser(cleanupEmails);
    const event = checkoutSessionEvent({ id: `cs_test_${Date.now()}_prod`, userId, productId: "fake" });
    const { payload, signatureHeader } = signStripePayload(event, secret);
    const res = await postWebhook(payload, signatureHeader);
    expect(res.status).toBe(400);
  });
});
