import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info, x-paystack-signature","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{...cors,"Content-Type":"application/json"}});
const hex=(b:ArrayBuffer)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const url=Deno.env.get("SUPABASE_URL"), pub=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")??"{}").default, sec=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")??"{}").default, key=Deno.env.get("PAYSTACK_SECRET_KEY");
  if(!url||!pub||!sec||!key)return reply({error:"International trade payments are not configured"},503);
  const raw=await req.text(),body=raw?JSON.parse(raw):{},sig=req.headers.get("x-paystack-signature");
  if(sig){
   const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(key),{name:"HMAC",hash:"SHA-512"},false,["sign"]);
   const expected=hex(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(raw)));
   if(sig.length!==expected.length)return reply({error:"Invalid signature"},401);
   let diff=0;for(let i=0;i<sig.length;i++)diff|=sig.charCodeAt(i)^expected.charCodeAt(i);if(diff)return reply({error:"Invalid signature"},401);
   const event=JSON.parse(raw);if(event.event!=="charge.success"||!event.data?.reference)return reply({received:true});
   const q=await fetch(`${url}/rest/v1/global_trade_payment_intents?provider_reference=eq.${encodeURIComponent(event.data.reference)}&select=id,quote_id,amount,currency,status`,{headers:{apikey:sec,Authorization:`Bearer ${sec}`}});const rows=await q.json(),p=rows?.[0];
   if(!p)return reply({error:"Trade payment reference not found"},404);
   if(p.provider!=="paystack")return reply({error:"Payment provider mismatch"},400);
   if(event.data.status!=="success"||Math.round(Number(p.amount)*100)!==Number(event.data.amount)||p.currency!==event.data.currency)return reply({error:"Payment details do not match"},400);
   const quoteCheck=await fetch(`${url}/rest/v1/global_trade_quotes?id=eq.${p.quote_id}&select=id,user_id,amount,currency,status`,{headers:{apikey:sec,Authorization:`Bearer ${sec}`}});
   if(!quoteCheck.ok)return reply({error:"Could not validate trade quote before payment reconciliation"},502);
   const linkedQuotes=await quoteCheck.json(),linkedQuote=linkedQuotes?.[0];
   if(!linkedQuote||linkedQuote.user_id!==p.user_id||Math.round(Number(linkedQuote.amount)*100)!==Math.round(Number(p.amount)*100)||linkedQuote.currency!==p.currency)return reply({error:"Payment does not match the linked trade quote"},400);
   if(!["issued","accepted","payment_pending","paid"].includes(linkedQuote.status))return reply({error:"Trade quote is not in a payable state"},409);
   if(p.status!=="success"){const u=await fetch(`${url}/rest/v1/global_trade_payment_intents?id=eq.${p.id}`,{method:"PATCH",headers:{apikey:sec,Authorization:`Bearer ${sec}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify({status:"success",paid_at:new Date().toISOString(),provider_response:event.data})});if(!u.ok)return reply({error:"Could not update payment"},500);}
   const q2=await fetch(`${url}/rest/v1/global_trade_quotes?id=eq.${p.quote_id}&status=in.(issued,accepted,payment_pending)`,{method:"PATCH",headers:{apikey:sec,Authorization:`Bearer ${sec}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify({status:"paid",updated_at:new Date().toISOString()})});if(!q2.ok)return reply({error:"Payment received; quote reconciliation pending"},500);
   return reply({received:true});
  }
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return reply({error:"Sign in required"},401);
  const au=await fetch(`${url}/auth/v1/user`,{headers:{apikey:pub,Authorization:auth}});if(!au.ok)return reply({error:"Session invalid"},401);const user=await au.json();
  if(body.action!=="initialize")return reply({error:"Unsupported action"},400);
  const id=String(body.quote_id??"");if(!/^[0-9a-f-]{36}$/i.test(id))return reply({error:"Valid quote required"},400);
  const qr=await fetch(`${url}/rest/v1/global_trade_quotes?id=eq.${id}&user_id=eq.${user.id}&select=id,reference,amount,currency,status,valid_until`,{headers:{apikey:sec,Authorization:`Bearer ${sec}`}});const quotes=await qr.json(),quote=quotes?.[0];
  if(!quote)return reply({error:"Quote not found"},404);
  if(!["issued","accepted","payment_pending"].includes(quote.status))return reply({error:"Quote is not payable"},409);
  if(quote.valid_until&&new Date(quote.valid_until)<new Date())return reply({error:"Quote has expired"},409);
  if(quote.currency==="USD"&&Number(quote.amount)<2)return reply({error:"Paystack USD payments have a minimum amount. Contact Iyanda for another arrangement."},400);
  const old=await fetch(`${url}/rest/v1/global_trade_payment_intents?quote_id=eq.${id}&status=eq.pending&select=provider_reference,authorization_url&order=created_at.desc&limit=1`,{headers:{apikey:sec,Authorization:`Bearer ${sec}`}});const prev=(await old.json())?.[0];if(prev?.authorization_url)return reply({success:true,reference:prev.provider_reference,authorization_url:prev.authorization_url,reused:true});
  const reference="IYGT-"+crypto.randomUUID().replaceAll("-","").slice(0,20);
  const init=await fetch("https://api.paystack.co/transaction/initialize",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({email:user.email,amount:Math.round(Number(quote.amount)*100),currency:quote.currency,reference,callback_url:"https://iyanda-unified.vercel.app/",metadata:{trade_quote_id:quote.id,quote_reference:quote.reference,user_id:user.id}})});
  const data=await init.json();if(!init.ok||!data.status||!data.data?.authorization_url)return reply({error:data.message||"Payment provider could not start checkout"},502);
  const saved=await fetch(`${url}/rest/v1/global_trade_payment_intents`,{method:"POST",headers:{apikey:sec,Authorization:`Bearer ${sec}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify({quote_id:quote.id,user_id:user.id,provider:"paystack",provider_reference:reference,amount:quote.amount,currency:quote.currency,status:"pending",authorization_url:data.data.authorization_url,provider_response:{message:data.message}})});
  if(!saved.ok)return reply({error:"Checkout created but payment reference could not be saved; contact support"},500);
  await fetch(`${url}/rest/v1/global_trade_quotes?id=eq.${id}`,{method:"PATCH",headers:{apikey:sec,Authorization:`Bearer ${sec}`,"Content-Type":"application/json"},body:JSON.stringify({status:"payment_pending"})});
  return reply({success:true,reference,authorization_url:data.data.authorization_url});
 }catch(_){return reply({error:"Unexpected trade payment service error"},500);}
});