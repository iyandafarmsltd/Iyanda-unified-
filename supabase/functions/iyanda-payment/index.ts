import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-paystack-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const publishable = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default;
    const secrets = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const serviceKey = secrets.default;
    const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!url || !publishable || !serviceKey) return json({ error: "Payment service is not configured" }, 503);
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = req.headers.get("x-paystack-signature") ? "webhook" : body.action;
    if (action === "webhook") {
      if (!paystackKey) return json({ error: "Payment provider is not configured" }, 503);
      const signature = req.headers.get("x-paystack-signature") ?? "";
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(paystackKey), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
      const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
      if (!signature || signature.length !== expected.length) return json({ error: "Invalid webhook signature" }, 401);
      let diff = 0;
      for (let i = 0; i < signature.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
      if (diff !== 0) return json({ error: "Invalid webhook signature" }, 401);
      const event = JSON.parse(raw || "{}");
      if (event.event !== "charge.success" || !event.data?.reference) return json({ received: true });
      const ref = encodeURIComponent(String(event.data.reference));
      const p = await fetch(`${url}/rest/v1/marketplace_payments?provider_reference=eq.${ref}&select=id,order_id,amount,currency,status,provider`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      const rows = await p.json();
      const payment = rows?.[0];
      if (!payment) return json({ error: "Payment reference not found" }, 404);
      if (payment.provider !== "paystack") return json({ error: "Payment provider mismatch" }, 400);
      if (!["pending", "initiated", "success"].includes(payment.status)) return json({ error: "Payment is not in a verifiable state" }, 409);
      if (event.data.status !== "success") return json({ error: "Payment is not successful" }, 400);
      if (Math.round(Number(payment.amount) * 100) !== Number(event.data.amount) || payment.currency !== event.data.currency) return json({ error: "Payment amount or currency mismatch" }, 400);
      const orderCheck = await fetch(`${url}/rest/v1/orders?id=eq.${payment.order_id}&select=id,total,currency`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!orderCheck.ok) return json({ error: "Could not validate the order before payment reconciliation" }, 502);
      const orderRows = await orderCheck.json();
      const linkedOrder = orderRows?.[0];
      if (!linkedOrder || Math.round(Number(linkedOrder.total) * 100) !== Number(event.data.amount) || linkedOrder.currency !== event.data.currency) return json({ error: "Payment does not match the linked order total or currency" }, 400);
      // Always reconcile the order, even on a duplicate webhook delivery.
      // This safely repairs a previous partial update where the payment row succeeded but the order update failed.
      if (payment.status !== "success") {
        const paymentUpdate = await fetch(`${url}/rest/v1/marketplace_payments?id=eq.${payment.id}&status=in.(pending,initiated)`, { method: "PATCH", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status: "success", paid_at: new Date().toISOString(), provider_response: event.data }) });
        if (!paymentUpdate.ok) return json({ error: "Payment record update failed; webhook will retry" }, 500);
      }
      const orderUpdate = await fetch(`${url}/rest/v1/orders?id=eq.${payment.order_id}&payment_status=neq.paid`, { method: "PATCH", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ payment_status: "paid", updated_at: new Date().toISOString() }) });
      if (!orderUpdate.ok) return json({ error: "Order update failed; webhook will retry" }, 500);
      return json({ received: true });
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Sign in is required" }, 401);
    const auth = await fetch(`${url}/auth/v1/user`, { headers: { apikey: publishable, Authorization: authorization } });
    if (!auth.ok) return json({ error: "Your session is invalid or expired" }, 401);
    const user = await auth.json();
    if (!user?.id) return json({ error: "Unable to verify your account" }, 401);
    if (!paystackKey) return json({ error: "Online payments are not activated yet. Please choose another payment option or contact Iyanda." }, 503);

    if (action === "initialize") {
      const orderId = String(body.order_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "A valid order is required" }, 400);
      const orderResponse = await fetch(`${url}/rest/v1/orders?id=eq.${orderId}&user_id=eq.${user.id}&select=id,order_number,total,currency,payment_status,email,customer_name,fulfilment_method,delivery_fee,delivery_zone_id`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!orderResponse.ok) return json({ error: "Could not retrieve the order" }, 502);
      const orders = await orderResponse.json();
      const order = orders?.[0];
      if (!order) return json({ error: "Order not found" }, 404);
      // Only genuine, active catalogue products may enter online checkout.
      const itemResponse = await fetch(`${url}/rest/v1/order_items?order_id=eq.${order.id}&select=product_id,product_name`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!itemResponse.ok) return json({ error: "Could not validate order items before payment" }, 502);
      const orderItems = await itemResponse.json();
      if (!Array.isArray(orderItems) || orderItems.length === 0) return json({ error: "This order has no valid items" }, 400);
      if (orderItems.some((item: any) => !item.product_id || /test\s*only/i.test(String(item.product_name ?? "")))) return json({ error: "Demo/test or unlinked products cannot be paid online." }, 400);
      const productIds = [...new Set(orderItems.map((item: any) => String(item.product_id)))];
      const productFilter = productIds.map((id: string) => `"${id}"`).join(",");
      const productResponse = await fetch(`${url}/rest/v1/products?id=in.(${encodeURIComponent(productFilter)})&select=id,sku,is_active`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!productResponse.ok) return json({ error: "Could not validate catalogue products before payment" }, 502);
      const catalogueProducts = await productResponse.json();
      if (!Array.isArray(catalogueProducts) || catalogueProducts.length !== productIds.length || catalogueProducts.some((product: any) => !product.is_active || /^IY-TEST-/i.test(String(product.sku ?? "")))) return json({ error: "Demo, inactive, or test products cannot be paid online." }, 400);
      if (order.payment_status === "paid") return json({ error: "This order has already been paid" }, 409);
      // Delivery charges are payable only after an active zone and final fee are confirmed.
      if (order.fulfilment_method === "delivery") {
        if (!order.delivery_zone_id || order.delivery_fee == null) return json({ error: "Delivery availability and the final delivery fee must be confirmed before online payment." }, 409);
        const zoneResponse = await fetch(`${url}/rest/v1/delivery_zones?id=eq.${order.delivery_zone_id}&is_active=eq.true&select=service_status,currency,delivery_fee`, {
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
        if (!zoneResponse.ok) return json({ error: "Could not validate delivery confirmation" }, 502);
        const zones = await zoneResponse.json();
        const zone = zones?.[0];
        if (!zone || zone.service_status !== "available" || zone.currency !== order.currency || Number(zone.delivery_fee) !== Number(order.delivery_fee)) return json({ error: "Delivery availability and fee must be confirmed before online payment." }, 409);
      }
      // Reuse an existing pending checkout rather than creating duplicate charge attempts.
      const existingResponse = await fetch(`${url}/rest/v1/marketplace_payments?order_id=eq.${order.id}&user_id=eq.${user.id}&select=provider_reference,status,authorization_url&order=created_at.desc&limit=1`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!existingResponse.ok) return json({ error: "Could not check existing payment attempts" }, 502);
      const existingRows = await existingResponse.json();
      const existing = existingRows?.[0];
      if (existing?.status === "success") return json({ error: "This order has already been paid" }, 409);
      if ((existing?.status === "pending" || existing?.status === "initiated") && existing.authorization_url) return json({ success: true, reused: true, reference: existing.provider_reference, authorization_url: existing.authorization_url });
      if (order.currency !== "NGN" || Number(order.total) <= 0) return json({ error: "Online payment is currently available for valid NGN orders only" }, 400);
      const reference = `IY-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const init = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST", headers: { Authorization: `Bearer ${paystackKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: order.email || user.email, amount: Math.round(Number(order.total) * 100), currency: "NGN", reference, callback_url: "https://iyanda-unified.vercel.app/", metadata: { order_id: order.id, order_number: order.order_number, user_id: user.id } }),
      });
      const data = await init.json();
      if (!init.ok || !data.status || !data.data?.authorization_url) return json({ error: data.message || "Could not start payment" }, 502);
      const save = await fetch(`${url}/rest/v1/marketplace_payments`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ order_id: order.id, user_id: user.id, provider: "paystack", provider_reference: reference, amount: Number(order.total), currency: "NGN", status: "pending", authorization_url: data.data.authorization_url, provider_response: { status: data.status, message: data.message } }) });
      if (!save.ok) return json({ error: "Payment started but the payment record could not be saved. Contact support before retrying." }, 500);
      return json({ success: true, reference, authorization_url: data.data.authorization_url });
    }
    if (action === "verify") {
      const reference = String(body.reference ?? "");
      if (!/^IY-[A-Za-z0-9-]{10,64}$/.test(reference)) return json({ error: "Invalid payment reference" }, 400);
      const lookup = await fetch(`${url}/rest/v1/marketplace_payments?provider_reference=eq.${encodeURIComponent(reference)}&user_id=eq.${user.id}&select=id,order_id,amount,currency,status,provider`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!lookup.ok) return json({ error: "Could not retrieve the payment record" }, 502);
      const records = await lookup.json(); const payment = records?.[0];
      if (!payment) return json({ error: "Payment record not found" }, 404);
      if (payment.provider !== "paystack") return json({ error: "Payment provider mismatch" }, 400);
      if (!["pending", "initiated", "success"].includes(payment.status)) return json({ error: "Payment is not in a verifiable state" }, 409);
      const orderLookup = await fetch(`${url}/rest/v1/orders?id=eq.${payment.order_id}&user_id=eq.${user.id}&select=id,total,currency,payment_status`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!orderLookup.ok) return json({ error: "Could not retrieve the order for payment verification" }, 502);
      const ownedOrders = await orderLookup.json();
      const ownedOrder = ownedOrders?.[0];
      if (!ownedOrder) return json({ error: "Order not found for this payment" }, 404);
      if (Math.round(Number(ownedOrder.total) * 100) !== Math.round(Number(payment.amount) * 100) || ownedOrder.currency !== payment.currency) return json({ error: "Payment record does not match the current order total or currency" }, 400);
      const verify = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${paystackKey}` } });
      const result = await verify.json();
      if (!verify.ok || !result.status || result.data?.status !== "success") return json({ success: false, status: result.data?.status || "pending" }, 200);
      if (Math.round(Number(payment.amount) * 100) !== Number(result.data.amount) || payment.currency !== result.data.currency) return json({ error: "Verified amount or currency does not match the order" }, 400);
      if (payment.provider !== "paystack") return json({ error: "Payment provider mismatch" }, 400);
      if (payment.status !== "success") {
        const paymentUpdate = await fetch(`${url}/rest/v1/marketplace_payments?id=eq.${payment.id}&status=in.(pending,initiated)`, { method: "PATCH", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status: "success", paid_at: new Date().toISOString(), provider_response: result.data }) });
        if (!paymentUpdate.ok) return json({ error: "Payment verified but payment record update failed. Please contact support before retrying." }, 500);
      }
      const orderUpdate = await fetch(`${url}/rest/v1/orders?id=eq.${payment.order_id}&payment_status=neq.paid`, { method: "PATCH", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ payment_status: "paid", updated_at: new Date().toISOString() }) });
      if (!orderUpdate.ok) return json({ error: "Payment verified but order update failed. Please contact support." }, 500);
      return json({ success: true, status: "success" });
    }
    return json({ error: "Unsupported payment action" }, 400);
  } catch (_error) {
    return json({ error: "Unexpected payment service error" }, 500);
  }
});