import { apiGet, apiPost } from "./app.js";

const consent = document.getElementById("withdrawal-consent");
const card = document.getElementById("card");
const paypal = document.getElementById("paypal");
const message = document.getElementById("msg");
let product;
let canBuy = false;
let busy = false;

function updateButtons() {
  card.disabled = paypal.disabled = !product || !canBuy || !consent.checked || busy;
}

async function checkout(provider) {
  if (card.disabled) return;
  busy = true;
  updateButtons();
  message.textContent = "Opening secure payment…";
  try {
    const result = await apiPost("/api/checkout/" + provider, {
      productId: product.id,
      withdrawalConsent: true
    });
    if (result.ok && result.url) {
      location.assign(result.url);
      return;
    }
    message.textContent = result.error || "Payment could not be started.";
  } catch {
    message.textContent = "Payment could not be started. Please try again.";
  }
  busy = false;
  updateButtons();
}

async function init() {
  try {
    const params = new URLSearchParams(location.search);
    const provider = params.get("provider");
    const status = params.get("status");
    let result;
    if (provider === "paypal" && status === "return" && params.get("token")) {
      result = await apiPost("/api/checkout/paypal/capture", { orderId: params.get("token") });
    } else if (provider === "stripe" && status === "success" && params.get("session_id")) {
      result = await apiPost("/api/checkout/stripe/confirm", { sessionId: params.get("session_id") });
    } else if (status === "cancelled") {
      message.textContent = "Payment cancelled.";
    }
    if (result) message.textContent = result.ok ? "Payment confirmed." : result.error || "Payment could not be confirmed.";

    const [catalogue, access] = await Promise.all([apiGet("/api/products"), apiGet("/api/access")]);
    product = catalogue.products?.find(item => item.id === "full_game");
    if (!product) {
      message.textContent ||= "Price unavailable. Please try again.";
      return;
    }
    const price = document.getElementById("price");
    price.textContent = new Intl.NumberFormat("en-US", {
      style: "currency", currency: product.currency, currencyDisplay: "code"
    }).format(Number(product.amount));
    price.hidden = false;
    if (access.ownsGame || access.freeAccess) {
      message.textContent ||= "This account already has full access to Breluce.";
      return;
    }
    if (!access.ok) {
      message.textContent ||= access.status === 401 ? "Sign in before buying Breluce." : "Could not check your account access.";
      return;
    }
    canBuy = true;
    updateButtons();
  } catch {
    message.textContent = "Could not load checkout. Please try again.";
  }
}

consent.addEventListener("change", updateButtons);
card.addEventListener("click", () => checkout("stripe"));
paypal.addEventListener("click", () => checkout("paypal"));
init();
