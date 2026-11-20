import { randomUUID } from "node:crypto";
import { db } from "./database2.js";
import { hasGamePurchase } from "./products.js";

const PAYPAL_APPROVAL_MS = 3 * 60 * 60 * 1000;
const STRIPE_CHECKOUT_MS = 45 * 60 * 1000;
const read = db.prepare("SELECT * FROM game_checkouts WHERE user_id=?");
const release = db.prepare("DELETE FROM game_checkouts WHERE user_id=? AND checkout_key=?");
const acquire = db.transaction((userId, provider, now) => {
  if (hasGamePurchase(db, userId)) throw new Error("this account already owns Breluce");
  let row = read.get(userId);
  if (row?.provider === "paypal" && !row.capturing && row.expires_at <= now) {
    release.run(userId, row.checkout_key);
    row = null;
  }
  if (row) return row;
  db.prepare("INSERT INTO game_checkouts (user_id, provider, checkout_key, expires_at) VALUES (?,?,?,?)")
    .run(userId, provider, randomUUID(), now + (provider === "paypal" ? PAYPAL_APPROVAL_MS : STRIPE_CHECKOUT_MS));
  return read.get(userId);
});

export async function beginGameCheckout(userId, provider, stripe) {
  let row = acquire.immediate(userId, provider, Date.now());
  // Stripe, unlike PayPal, can collect without a callback through our server.
  if (row.provider === "stripe" && row.provider_ref && row.expires_at <= Date.now() && stripe) {
    const session = await stripe.checkout.sessions.retrieve(row.provider_ref);
    if (session.status === "expired" && session.payment_status === "unpaid") {
      release.run(userId, row.checkout_key);
      row = acquire.immediate(userId, provider, Date.now());
    }
  }
  if (row.provider !== provider) {
    throw new Error("A checkout is already active. Continue with " + (row.provider === "stripe" ? "Card" : "PayPal") + ".");
  }
  if (row.capturing) throw new Error("PayPal payment is being confirmed. Return to your PayPal checkout to finish.");
  if (row.expires_at && row.expires_at <= Date.now()) throw new Error("The previous checkout is still being reconciled.");
  return row;
}

export function rememberGameCheckout(row, providerRef, url, expiresAt = row.expires_at) {
  if (!providerRef || !url) throw new Error("Payment provider returned an incomplete checkout");
  const result = db.prepare("UPDATE game_checkouts SET provider_ref=?, checkout_url=?, expires_at=? WHERE user_id=? AND checkout_key=?")
    .run(providerRef, url, expiresAt, row.user_id, row.checkout_key);
  if (!result.changes) throw new Error("This checkout is no longer active. Start a new checkout.");
}

const claimCapture = db.transaction((userId, orderId) => {
  const row = read.get(userId);
  if (hasGamePurchase(db, userId)) throw new Error("this account already owns Breluce");
  if (!row || row.provider !== "paypal" || row.provider_ref !== orderId ||
      (!row.capturing && row.expires_at <= Date.now())) {
    throw new Error("This PayPal checkout expired. Start a new checkout.");
  }
  db.prepare("UPDATE game_checkouts SET capturing=1 WHERE user_id=? AND checkout_key=?")
    .run(userId, row.checkout_key);
});

export function claimPayPalCapture(userId, orderId) {
  claimCapture.immediate(userId, orderId);
}

export function finishGameCheckout(userId, provider, providerRef, checkoutKey) {
  const row = read.get(userId);
  if (row?.provider === provider &&
      ((providerRef && row.provider_ref === providerRef) || (checkoutKey && row.checkout_key === checkoutKey))) {
    release.run(userId, row.checkout_key);
  }
}

const cancelPayPal = db.transaction((userId, checkoutKey) => {
  const row = read.get(userId);
  if (row?.checkout_key !== checkoutKey || row.provider !== "paypal") return;
  if (row.capturing) throw new Error("PayPal payment is being confirmed.");
  release.run(userId, checkoutKey);
});

export async function cancelGameCheckout(userId, checkoutKey, stripe) {
  const row = read.get(userId);
  if (!row || row.checkout_key !== checkoutKey) return;
  if (row.provider === "paypal") return cancelPayPal.immediate(userId, checkoutKey);
  if (!row.provider_ref || !stripe) throw new Error("The previous checkout is still being reconciled.");
  let session = await stripe.checkout.sessions.retrieve(row.provider_ref);
  if (session.status === "open") session = await stripe.checkout.sessions.expire(row.provider_ref);
  if (session.status !== "expired" || session.payment_status !== "unpaid") {
    throw new Error("The previous checkout is still being reconciled.");
  }
  release.run(userId, checkoutKey);
}

export function reverseGamePayment(provider, paymentId, reason) {
  if (typeof paymentId !== "string" || !paymentId) throw new Error("Missing payment reference");
  db.prepare("INSERT OR IGNORE INTO game_payment_reversals (provider,payment_id,reason,created_at) VALUES (?,?,?,?)")
    .run(provider, paymentId, reason, Date.now());
  return { reversed: true };
}
