-- Secure, transactional loyalty redemption at checkout.
drop function public.create_order_secure(uuid,text,text,text,text,text,jsonb,text,text,text,text,text);
CREATE OR REPLACE FUNCTION public.create_order_secure(p_user_id uuid, p_customer_name text, p_phone text, p_email text, p_delivery_address text, p_notes text, p_items jsonb, p_fulfilment_method text DEFAULT 'delivery'::text, p_delivery_country_code text DEFAULT NULL::text, p_delivery_region text DEFAULT NULL::text, p_delivery_city text DEFAULT NULL::text, p_delivery_postal_code text DEFAULT NULL::text, p_redeem_points integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
 v_order_id uuid; v_order_number text;
 v_subtotal numeric(12,2):=0; v_delivery_fee numeric(12,2):=0;
 v_item jsonb; v_product public.products%rowtype;
 v_quantity integer; v_line_total numeric(12,2);
 v_currency text:=null; v_zone public.delivery_zones%rowtype;
 v_has_zone boolean:=false; v_eta date:=null;
 v_balance integer:=0; v_reward_balance integer:=0; v_redeem_amount numeric(12,2):=0;
begin
 if auth.uid() is null or auth.uid() <> p_user_id then
   raise exception 'You may only create orders for your own account';
 end if;
 if coalesce(trim(p_customer_name),'')='' or coalesce(trim(p_phone),'')='' then
  raise exception 'Customer name and phone are required';
 end if;
 if coalesce(p_redeem_points,0)<0 then raise exception 'Invalid reward points amount'; end if;
 if coalesce(p_fulfilment_method,'delivery') not in ('delivery','collection') then
  raise exception 'Invalid fulfilment method';
 end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 or jsonb_array_length(p_items)>50 then
  raise exception 'Add between 1 and 50 order items';
 end if;

 if coalesce(p_fulfilment_method,'delivery')='delivery' then
  if coalesce(trim(p_delivery_country_code),'')='' or coalesce(trim(p_delivery_city),'')='' then
   raise exception 'Country and city are required for delivery. Choose a saved address or enter your delivery location.';
  end if;
  select dz.* into v_zone
  from public.delivery_zones dz
  where dz.is_active=true
   and upper(dz.country_code)=upper(trim(p_delivery_country_code))
   and (dz.region is null or lower(trim(dz.region))=lower(trim(coalesce(p_delivery_region,''))))
   and (dz.city is null or lower(trim(dz.city))=lower(trim(coalesce(p_delivery_city,''))))
   and (dz.postal_code_prefix is null or
    left(upper(regexp_replace(coalesce(p_delivery_postal_code,''),'[[:space:]]','','g')),
         length(regexp_replace(dz.postal_code_prefix,'[[:space:]]','','g')))
      =upper(regexp_replace(dz.postal_code_prefix,'[[:space:]]','','g')))
  order by length(dz.postal_code_prefix) desc nulls last,(dz.city is not null) desc,(dz.region is not null) desc
  limit 1 for share;
  v_has_zone:=found;
  if v_has_zone then
   if v_zone.service_status='temporarily_unavailable' then
    raise exception 'Delivery is temporarily unavailable in this area. Please contact Iyanda before placing this order.';
   end if;
   if v_zone.service_status='available' then
    v_delivery_fee:=coalesce(v_zone.delivery_fee,0);
    if v_zone.estimated_max_days is not null then v_eta:=current_date+v_zone.estimated_max_days; end if;
   end if;
  end if;
 end if;

 insert into public.orders(
  user_id,customer_name,phone,email,delivery_address,notes,status,payment_status,
  subtotal,delivery_fee,total,currency,fulfilment_method,delivery_country_code,
  delivery_region,delivery_city,delivery_postal_code,delivery_zone_id,
  delivery_status,estimated_delivery_date
 ) values(
  p_user_id,trim(p_customer_name),trim(p_phone),nullif(trim(coalesce(p_email,'')),''),
  nullif(trim(coalesce(p_delivery_address,'')),''),nullif(trim(coalesce(p_notes,'')),''),
  'pending','unpaid',0,0,0,'NGN',coalesce(p_fulfilment_method,'delivery'),
  upper(nullif(trim(coalesce(p_delivery_country_code,'')),'')),
  nullif(trim(coalesce(p_delivery_region,'')),''),nullif(trim(coalesce(p_delivery_city,'')),''),nullif(trim(coalesce(p_delivery_postal_code,'')),''),
  case when v_has_zone and p_fulfilment_method='delivery' then v_zone.id else null end,
  'pending_confirmation',v_eta
 ) returning id,order_number into v_order_id,v_order_number;

 perform set_config('iyanda.current_order_id',v_order_id::text,true);
 for v_item in select value from jsonb_array_elements(p_items) loop
  if coalesce(v_item->>'product_id','')='' then raise exception 'Each item must include a product_id'; end if;
  v_quantity:=(v_item->>'quantity')::integer;
  if v_quantity is null or v_quantity<1 or v_quantity>10000 then raise exception 'Invalid item quantity'; end if;
  select * into v_product from public.products where id=(v_item->>'product_id')::uuid and is_active=true for update;
  if not found then raise exception 'A selected product is unavailable'; end if;
  if v_product.price is null then raise exception 'A selected product requires a confirmed price before checkout'; end if;
  if v_product.stock_quantity<v_quantity then raise exception 'Insufficient stock for product: %',v_product.name; end if;
  if v_currency is null then v_currency:=v_product.currency;
  elsif v_currency<>v_product.currency then raise exception 'An order can contain products in one currency only. Please place separate orders for different currencies.'; end if;
  v_line_total:=v_product.price*v_quantity; v_subtotal:=v_subtotal+v_line_total;
  insert into public.order_items(order_id,product_id,product_name,unit_price,quantity,line_total,currency)
   values(v_order_id,v_product.id,v_product.name,v_product.price,v_quantity,v_line_total,v_product.currency);
  update public.products set stock_quantity=stock_quantity-v_quantity,updated_at=now() where id=v_product.id;
 end loop;

 if v_has_zone and v_zone.service_status='available' and v_delivery_fee>0 and v_zone.currency<>coalesce(v_currency,'NGN') then
  raise exception 'Delivery fee currency (%) does not match order currency (%). Contact Iyanda for a confirmed quote.',v_zone.currency,coalesce(v_currency,'NGN');
 end if;
 if coalesce(p_redeem_points,0)>0 then
  if p_redeem_points<500 then raise exception 'At least 500 points (₦500) are required to redeem rewards'; end if;
  if upper(coalesce(v_currency,'NGN'))<>'NGN' then raise exception 'Rewards redemption is currently available for NGN orders only'; end if;
  perform 1 from auth.users where id=p_user_id for update;
  select coalesce(sum(points),0)::integer into v_balance
    from public.reward_transactions where user_id=p_user_id;
  if p_redeem_points>v_balance then raise exception 'Insufficient reward points. Available balance: %',v_balance; end if;
  if p_redeem_points>floor(v_subtotal)::integer then raise exception 'Reward redemption cannot exceed the product subtotal'; end if;
  v_redeem_amount:=p_redeem_points::numeric;
  insert into public.reward_transactions(user_id,points,reason,order_id,transaction_type)
   values(p_user_id,-p_redeem_points,'Rewards redeemed at checkout for order '||v_order_number,v_order_id,'redemption');
 end if;
 update public.orders set subtotal=v_subtotal,delivery_fee=v_delivery_fee,total=v_subtotal+v_delivery_fee-v_redeem_amount,
  currency=coalesce(v_currency,'NGN'),updated_at=now() where id=v_order_id;
 select coalesce(sum(points),0)::integer into v_reward_balance
  from public.reward_transactions where user_id=p_user_id;

 return jsonb_build_object('order_id',v_order_id,'order_number',v_order_number,
  'subtotal',v_subtotal,'delivery_fee',v_delivery_fee,'redeemed_points',coalesce(p_redeem_points,0),'total',v_subtotal+v_delivery_fee-v_redeem_amount,'reward_balance',v_reward_balance,
  'currency',coalesce(v_currency,'NGN'),'status','pending','delivery_status','pending_confirmation',
  'fulfilment_method',coalesce(p_fulfilment_method,'delivery'),'delivery_zone',case when v_has_zone then v_zone.zone_name else null end,
  'delivery_quote_required',not v_has_zone or (v_has_zone and v_zone.service_status='quote_required'));
end;
$function$
;
revoke all on function public.create_order_secure(uuid,text,text,text,text,text,jsonb,text,text,text,text,text,integer) from public, anon;
grant execute on function public.create_order_secure(uuid,text,text,text,text,text,jsonb,text,text,text,text,text,integer) to authenticated;
