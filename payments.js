import crypto from "crypto";
import paypal from "@paypal/checkout-server-sdk";
import { createStripeClient } from "./stripe-client.js";
import { db } from "./database2.js";
import { FULL_GAME_ID, getProduct, getPurchasedProduct } from "./products.js";
import { recordAuditEvent } from "./security.js";
import { cancelGameCheckout, beginGameCheckout, claimPayPalCapture, finishGameCheckout, rememberGameCheckout, reverseGamePayment } from "./game-checkout.js";

const PAYPAL_API_BASE = process.env.NODE_ENV === "production" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const stripe = process.env.STRIPE_SECRET_KEY ? createStripeClient(process.env.STRIPE_SECRET_KEY) : null;

async function getStripeCustomer(userId) {
  const user = db.prepare(`SELECT email, stripe_customer_id FROM users WHERE id=?`).get(userId);
  if (!user) throw new Error("unknown user");
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { userId: String(userId) }
  });
  db.prepare(`UPDATE users SET stripe_customer_id=? WHERE id=? AND stripe_customer_id IS NULL`)
    .run(customer.id, userId);
  return db.prepare(`SELECT stripe_customer_id FROM users WHERE id=?`).get(userId).stripe_customer_id;
}

function getPayPalClient() {
  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) throw new Error("PayPal is not configured");
  const environment = process.env.NODE_ENV === "production"
    ? new paypal.core.LiveEnvironment(clientId, clientSecret)
    : new paypal.core.SandboxEnvironment(clientId, clientSecret);
  return new paypal.core.PayPalHttpClient(environment);
}

export async function createPayPalOrder({ userId, productId, withdrawalConsent, siteUrl }) {
  if (withdrawalConsent !== true) throw new Error("withdrawal consent is required before checkout");
  const product = getProduct(productId);
  if (!product) throw new Error("invalid product");
  const checkout = await beginGameCheckout(userId, "paypal", stripe);
  if (checkout.checkout_url) return { id: checkout.provider_ref, url: checkout.checkout_url };
  const request = new paypal.orders.OrdersCreateRequest();
  request.headers["PayPal-Request-Id"] = checkout.checkout_key;
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [{ description: "Breluce — Full game", amount: { currency_code: product.currency, value: product.amount } }],
    application_context: {
      return_url: `${siteUrl}/purchase.html?provider=paypal&status=return`,
      cancel_url: `${siteUrl}/purchase.html?provider=paypal&status=cancelled&checkout_key=${checkout.checkout_key}`
    }
  });
  const result = await getPayPalClient().execute(request);
  const orderId = result.result.id;
  db.prepare(`INSERT OR IGNORE INTO pending_orders (order_id,provider,user_id,product_id,minutes,amount,currency,withdrawal_consent,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(orderId, "paypal", userId, product.id, product.minutes, product.amount, product.currency, 1, Date.now());
  const approval = result.result.links?.find(x => x.rel === "approve")?.href;
  rememberGameCheckout(checkout, orderId, approval);
  return { id: orderId, url: approval };
}

export async function capturePayPalOrder({ userId, orderId }, client = getPayPalClient()) {
  const pending = db.prepare(`SELECT * FROM pending_orders WHERE order_id=? AND provider='paypal' AND user_id=?`).get(orderId, userId);
  if (!pending) throw new Error("unknown order");
  if (pending.consumed) return { ok: true, duplicate: true };
  const request = new paypal.orders.OrdersCaptureRequest(orderId);
  if (pending.product_id === FULL_GAME_ID) {
    claimPayPalCapture(userId, orderId);
    request.headers["PayPal-Request-Id"] = crypto.createHash("sha256").update("breluce-capture:" + orderId).digest("hex").slice(0, 32);
  }
  request.requestBody({});
  let result;
  try {
    result = await client.execute(request);
  } catch (captureError) {
    // Capture may have succeeded before the connection or local credit failed.
    // Retrieve its authoritative result instead of trying to charge again.
    try {
      result = await client.execute(new paypal.orders.OrdersGetRequest(orderId));
      if (result.result?.status !== "COMPLETED") throw captureError;
    } catch { throw captureError; }
  }
  const capture = result.result;
  const units = capture?.purchase_units;
  const captures = units?.[0]?.payments?.captures;
  if (capture?.id !== orderId || capture?.status !== "COMPLETED" || units?.length !== 1 || captures?.length !== 1 || captures[0]?.status !== "COMPLETED") {
    throw new Error("payment not completed");
  }
  return creditPayPalCapture(pending, captures[0]);
}

function creditPayPalCapture(pending, capture) {
  if (!capture || typeof capture.id !== "string" || !capture.id || capture.status !== "COMPLETED") throw new Error("invalid PayPal capture");
  if (pending.consumed) return { credited: false, duplicate: true };
  try {
    return creditPayment({ pending, eventId: `paypal:${capture.id}`, capturedAmount: capture.amount?.value, capturedCurrency: capture.amount?.currency_code });
  } catch (error) {
    if (!db.prepare('SELECT consumed FROM pending_orders WHERE order_id=?').get(pending.order_id)?.consumed) {
      recordAuditEvent({ userId: pending.user_id, eventType: 'payment_captured_not_credited',
        metadata: { orderId: pending.order_id, captureId: capture.id, reason: error.message } });
    }
    throw error;
  }
}

// Call only after PayPal has verified the webhook signature. Match captures to
// our stored order; never accept a user, price or duration from the event.
export function handlePayPalWebhookEvent(event) {
  if (event?.event_type === "PAYMENT.CAPTURE.REVERSED") {
    return reverseGamePayment("paypal", event.resource?.id, "capture reversed");
  }
  if (event?.event_type === "PAYMENT.CAPTURE.REFUNDED") return reconcilePayPalRefund(event.resource);
  if (event?.event_type !== "PAYMENT.CAPTURE.COMPLETED") return { ignored: true };
  const capture = event.resource;
  const orderId = capture?.supplementary_data?.related_ids?.order_id;
  if (typeof orderId !== "string" || !orderId) return { ignored: true, reason: "no order" };
  const pending = db.prepare("SELECT * FROM pending_orders WHERE order_id=? AND provider='paypal'").get(orderId);
  if (!pending) return { ignored: true, reason: "unknown order" };
  return creditPayPalCapture(pending, capture);
}

export async function createStripeCheckout({ userId, productId, withdrawalConsent, siteUrl }) {
  if (withdrawalConsent !== true) throw new Error("withdrawal consent is required before checkout");
  if (!stripe) throw new Error("Stripe is not configured");
  const product = getProduct(productId);
  if (!product) throw new Error("invalid product");
  const checkout = await beginGameCheckout(userId, "stripe", stripe);
  if (checkout.checkout_url) return { url: checkout.checkout_url };
  const customerId = await getStripeCustomer(userId);
  if (checkout.expires_at <= Date.now() + 30 * 60 * 1000) throw new Error("The previous checkout is still being reconciled.");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    expires_at: Math.floor(checkout.expires_at / 1000),
    managed_payments: { enabled: false },
    customer: customerId,
    line_items: [{ price_data: {
      currency: product.currency.toLowerCase(),
      product_data: { name: `Breluce — ${product.label}` },
      unit_amount: Math.round(Number(product.amount) * 100)
    }, quantity: 1 }],
    success_url: `${siteUrl}/purchase.html?provider=stripe&status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/purchase.html?provider=stripe&status=cancelled&checkout_key=${checkout.checkout_key}`,
    metadata: { userId: String(userId), productId: product.id, withdrawalConsent: "1", amount: product.amount, currency: product.currency, checkoutKey: checkout.checkout_key }
  }, { idempotencyKey: checkout.checkout_key });
  rememberGameCheckout(checkout, session.id, session.url, session.expires_at * 1000);
  return { url: session.url };
}

export async function cancelCheckout({ userId, checkoutKey }) {
  return cancelGameCheckout(userId, checkoutKey, stripe);
}

export async function confirmStripeCheckout({ userId, sessionId }) {
  if (!stripe) throw new Error("Stripe is not configured");
  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error("invalid Stripe session");
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid") throw new Error("payment is not complete");
  const sessionUserId = Number(session.metadata?.userId);
  const product = getPurchasedProduct(session.metadata?.productId);
  if (sessionUserId !== userId || !product) throw new Error("invalid Stripe metadata");
  const originalCurrency = product.id === FULL_GAME_ID ? product.currency : session.metadata?.currency || "USD";
  const originalAmount = product.id === FULL_GAME_ID ? product.amount : session.metadata?.amount || product.amount;
  return creditPayment({
    pending: {
      order_id: session.id,
      checkout_key: session.metadata?.checkoutKey,
      provider: "stripe",
      user_id: userId,
      product_id: product.id,
      minutes: product.minutes,
      amount: originalAmount,
      currency: originalCurrency,
      withdrawal_consent: session.metadata?.withdrawalConsent === "1" ? 1 : 0,
      consumed: 0,
      customer_id: session.customer,
      checkout_session_id: session.id,
      payment_intent_id: session.payment_intent
    },
    eventId: session.id,
    capturedAmount: Number(session.amount_total / 100).toFixed(2),
    capturedCurrency: session.currency,
    customerId: session.customer,
    checkoutSessionId: session.id,
    paymentIntentId: session.payment_intent
  });
}

export async function handleStripeWebhook(rawBody, signature) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe webhook is not configured");
  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const session = event.data.object;
  if (event.type === "charge.refunded" && session.refunded === true && session.payment_intent) {
    return reverseGamePayment("stripe", session.payment_intent, "full refund");
  }
  if (event.type === "charge.dispute.closed" && session.status === "lost" && session.payment_intent) {
    return reverseGamePayment("stripe", session.payment_intent, "lost dispute");
  }
  if (event.type === "checkout.session.expired" && session.payment_status === "unpaid") {
    if (session.metadata?.checkoutKey) finishGameCheckout(Number(session.metadata.userId), "stripe", session.id, session.metadata.checkoutKey);
    return { expired: true };
  }
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return { ignored: true };
  if (session.payment_status !== "paid") return { ignored: true };
  const userId = Number(session.metadata?.userId);
  const product = getPurchasedProduct(session.metadata?.productId);
  if (!userId || !product) throw new Error("invalid Stripe metadata");
  const originalCurrency = product.id === FULL_GAME_ID ? product.currency : session.metadata?.currency || "USD";
  const originalAmount = product.id === FULL_GAME_ID ? product.amount : session.metadata?.amount || product.amount;
  return creditPayment({
    pending: {
      order_id: session.id,
      checkout_key: session.metadata?.checkoutKey,
      provider: "stripe",
      user_id: userId,
      product_id: product.id,
      minutes: product.minutes,
      amount: originalAmount,
      currency: originalCurrency,
      withdrawal_consent: session.metadata?.withdrawalConsent === "1" ? 1 : 0,
      consumed: 0,
      customer_id: session.customer,
      checkout_session_id: session.id,
      payment_intent_id: session.payment_intent
    },
    eventId: session.id,
    capturedAmount: Number(session.amount_total / 100).toFixed(2),
    capturedCurrency: session.currency,
    customerId: session.customer,
    checkoutSessionId: session.id,
    paymentIntentId: session.payment_intent
  });
}

export function creditPayment({ pending, eventId, capturedAmount, capturedCurrency, customerId, checkoutSessionId, paymentIntentId }) {
  const expected = Number(pending.amount).toFixed(2);
  if (Number(capturedAmount).toFixed(2) !== expected) throw new Error("payment amount mismatch");
  const expectedCurrency = String(pending.currency || "").trim().toUpperCase();
  const actualCurrency = String(capturedCurrency || "").trim().toUpperCase();
  if (!expectedCurrency || actualCurrency !== expectedCurrency) throw new Error("payment currency mismatch");
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT 1 FROM processed_payment_events WHERE id=?").get(eventId);
    if (existing) return { credited: false, duplicate: true };
    const claim = pending.provider === "paypal"
      ? db.prepare(`UPDATE pending_orders SET consumed=1 WHERE order_id=? AND consumed=0`).run(pending.order_id)
      : { changes: 1 };
    if (pending.provider === "paypal" && claim.changes === 0) return { credited: false, duplicate: true };
    db.prepare(`INSERT INTO processed_payment_events (id,created_at) VALUES (?,?)`).run(eventId, Date.now());
    db.prepare(`INSERT INTO purchases (id,user_id,provider,product_id,minutes,amount,currency,customer_id,checkout_session_id,payment_intent_id,withdrawal_consent,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(eventId, pending.user_id, pending.provider, pending.product_id, pending.minutes, pending.amount, pending.currency, customerId || pending.customer_id || null, checkoutSessionId || pending.checkout_session_id || null, paymentIntentId || pending.payment_intent_id || null, pending.withdrawal_consent ? 1 : 0, Date.now());
    if (pending.product_id === FULL_GAME_ID) {
      finishGameCheckout(pending.user_id, pending.provider, pending.order_id, pending.checkout_key);
      return { credited: true };
    }
    const row = db.prepare(`SELECT remaining_seconds FROM time_tracking WHERE user_id=?`).get(pending.user_id);
    if (row) db.prepare(`UPDATE time_tracking SET remaining_seconds=remaining_seconds+?,updated_at=?,last_active_at=NULL WHERE user_id=?`).run(pending.minutes*60, Date.now(), pending.user_id);
    else db.prepare(`INSERT INTO time_tracking (user_id,remaining_seconds,last_active_at,updated_at) VALUES (?,?,NULL,?)`).run(pending.user_id, pending.minutes*60, Date.now());
    return { credited: true };
  });
  const result = tx.immediate();
  if (result.credited) {
    recordAuditEvent({
      userId: pending.user_id,
      eventType: "payment_credited",
      metadata: {
        provider: pending.provider,
        productId: pending.product_id,
        minutes: pending.minutes,
        eventId
      }
    });
  }
  return result;
}

async function paypalAccessToken() {
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_CLIENT_SECRET).toString("base64");
  const response = await fetch(PAYPAL_API_BASE + "/v1/oauth2/token", {
    method: "POST", headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error("PayPal token request failed");
  return (await response.json()).access_token;
}

async function reconcilePayPalRefund(resource) {
  const captureLink = resource?.links?.find(link => link.rel === "up" && typeof link.href === "string");
  const captureId = resource?.supplementary_data?.related_ids?.capture_id ||
    captureLink?.href.match(/\/v2\/payments\/captures\/([A-Za-z0-9-]+)(?:\?|$)/)?.[1];
  if (typeof captureId !== "string" || !/^[A-Za-z0-9-]+$/.test(captureId)) throw new Error("PayPal refund is missing its capture reference");
  const token = await paypalAccessToken();
  const response = await fetch(PAYPAL_API_BASE + "/v2/payments/captures/" + captureId, {
    headers: { Authorization: "Bearer " + token }
  });
  if (!response.ok) throw new Error("PayPal capture lookup failed");
  const capture = await response.json();
  if (capture.id !== captureId) throw new Error("PayPal capture reference mismatch");
  return capture.status === "REFUNDED" ? reverseGamePayment("paypal", captureId, "full refund") : { ignored: true };
}

export async function verifyPayPalWebhookSignature(headers, body) {
  if (!process.env.PAYPAL_WEBHOOK_ID || typeof body !== "string" || !body) return false;
  // Embed the original JSON without changing whitespace, escapes or numbers.
  // It has already passed Express's JSON parser; never interpolate arbitrary text.
  JSON.parse(body);
  const access_token = await paypalAccessToken();
  const resp = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method:"POST", headers:{ Authorization:`Bearer ${access_token}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      transmission_id: headers["paypal-transmission-id"], transmission_time: headers["paypal-transmission-time"],
      cert_url: headers["paypal-cert-url"], auth_algo: headers["paypal-auth-algo"], transmission_sig: headers["paypal-transmission-sig"],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID
    }).slice(0, -1) + ',"webhook_event":' + body + '}'
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.verification_status === "SUCCESS";
}
