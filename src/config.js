import { demoClient, paypalClient } from "./paypal.js";

// PayPal sandbox when credentials are set, demo mode otherwise
export function paypalFromEnv(env = process.env, { site = "" } = {}) {
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return paypalClient({
      clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, live: env.PAYPAL_ENV === "live",
      invoicer: { ...(env.BUSINESS_NAME ? { business_name: env.BUSINESS_NAME } : {}) },
    });
  }
  return demoClient({ site });
}
