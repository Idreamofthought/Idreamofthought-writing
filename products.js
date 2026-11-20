// Only the full game is available for new checkout sessions.
export const FULL_GAME_ID = "full_game";
export const PRODUCTS = Object.freeze({
  [FULL_GAME_ID]: Object.freeze({ id: FULL_GAME_ID, label: "Full game", minutes: 0, amount: "4.99", currency: "USD" })
});

// Retain the original terms for Stripe sessions created before the change.
const LEGACY_PRODUCTS = Object.freeze({
  hour: { id: "hour", label: "1 hour", minutes: 60, amount: "2.00", currency: "EUR" },
  three_hours: { id: "three_hours", label: "3 hours", minutes: 180, amount: "5.00", currency: "EUR" },
  day: { id: "day", label: "24 hours", minutes: 1440, amount: "20.00", currency: "EUR" }
});

export function getProduct(id) {
  return Object.hasOwn(PRODUCTS, id) ? PRODUCTS[id] : null;
}

export function getPurchasedProduct(id) {
  return getProduct(id) || (Object.hasOwn(LEGACY_PRODUCTS, id) ? LEGACY_PRODUCTS[id] : null);
}

export function hasGamePurchase(db, userId) {
  return Boolean(db.prepare(
    "SELECT 1 FROM purchases p WHERE p.user_id=? AND p.product_id=? AND NOT EXISTS (" +
    "SELECT 1 FROM game_payment_reversals r WHERE r.provider=p.provider AND r.payment_id=CASE p.provider " +
    "WHEN 'stripe' THEN p.payment_intent_id WHEN 'paypal' THEN substr(p.id,8) END) LIMIT 1"
  ).get(userId, FULL_GAME_ID));
}
