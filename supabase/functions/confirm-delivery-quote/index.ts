import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const publishable = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default;
    const serviceKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
    if (!url || !publishable || !serviceKey) return json({ error: "Delivery quote service is not configured" }, 503);
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Administrator sign-in is required" }, 401);
    const auth = await fetch(`${url}/auth/v1/user`, { headers: { apikey: publishable, Authorization: authorization } });
    if (!auth.ok) return json({ error: "Your session is invalid or expired" }, 401);
    const user = await auth.json();
    if (!user?.id || user.app_metadata?.role !== "admin") return json({ error: "Administrator access is required" }, 403);
    const body = await req.json();
    const orderId = String(body.order_id ?? "");
    const action = String(body.action ?? "confirm");
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "A valid order is required" }, 400);
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const lookup = await fetch(`${url}/rest/v1/orders?id=eq.${orderId}&select=id,order_number,subtotal,total,delivery_fee,currency,payment_status,fulfilment_method,delivery_quote_confirmed_at`, { headers });
    if (!lookup.ok) return json({ error: "Could not retrieve the order" }, 502);
    const order = (await lookup.json())?.[0];
    if (!order) return json({ error: "Order not found" }, 404);
    if (order.fulfilment_method !== "delivery") return json({ error: "Only delivery orders require a delivery quote" }, 409);
    if (order.payment_status === "paid") return json({ error: "A paid order cannot have its delivery fee changed" }, 409);
    if (action === "unavailable") {
      const update = await fetch(`${url}/rest/v1/orders?id=eq.${orderId}&payment_status=neq.paid`, {
        method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ delivery_status: "zone_unavailable", delivery_quote_confirmed_at: null, delivery_quote_confirmed_by: null, updated_at: new Date().toISOString() }),
      });
      if (!update.ok) return json({ error: "Could not update delivery availability" }, 502);
      return json({ success: true, order_number: order.order_number, delivery_status: "zone_unavailable" });
    }
    const fee = Number(body.delivery_fee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 100000000) return json({ error: "Enter a valid non-negative delivery fee" }, 400);
    if (String(order.currency).toUpperCase() !== "NGN") return json({ error: "This quote flow currently supports NGN orders only" }, 409);
    const nextTotal = Math.round((Number(order.total) - Number(order.delivery_fee ?? 0) + fee) * 100) / 100;
    if (!Number.isFinite(nextTotal) || nextTotal < 0) return json({ error: "The resulting order total is invalid" }, 409);
    const confirmedAt = new Date().toISOString();
    const update = await fetch(`${url}/rest/v1/orders?id=eq.${orderId}&payment_status=neq.paid&fulfilment_method=eq.delivery`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ delivery_fee: fee, total: nextTotal, delivery_quote_confirmed_at: confirmedAt, delivery_quote_confirmed_by: user.id, delivery_status: "pending_confirmation", updated_at: confirmedAt }),
    });
    if (!update.ok) return json({ error: "Could not save the confirmed delivery fee" }, 502);
    return json({ success: true, order_number: order.order_number, delivery_fee: fee, total: nextTotal, currency: order.currency, delivery_quote_confirmed_at: confirmedAt });
  } catch (_error) {
    return json({ error: "Unexpected delivery quote service error" }, 500);
  }
});