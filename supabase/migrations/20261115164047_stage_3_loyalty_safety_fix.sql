-- Stage 3 loyalty safety hardening: retain idempotency and handle nullable order owners.
alter table public.reward_transactions
  drop constraint if exists reward_transactions_order_id_fkey;
alter table public.reward_transactions
  add constraint reward_transactions_order_id_fkey
  foreign key (order_id) references public.orders(id) on delete restrict;

create or replace function private.award_iyanda_loyalty_points()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_points integer;
  v_earned_points integer;
  v_earned_user_id uuid;
begin
  if lower(coalesce(new.payment_status, '')) in ('refunded', 'chargeback')
     or lower(coalesce(new.status, '')) in ('cancelled', 'refunded', 'chargeback')
     or lower(coalesce(new.delivery_status, '')) in ('cancelled', 'refunded') then
    select points, user_id into v_earned_points, v_earned_user_id
      from public.reward_transactions
     where order_id = new.id and transaction_type = 'earn'
     limit 1;

    if found and v_earned_user_id is not null and not exists (
      select 1 from public.reward_transactions
       where order_id = new.id and transaction_type = 'reversal'
    ) then
      insert into public.reward_transactions
        (user_id, points, reason, order_id, transaction_type)
      values
        (v_earned_user_id, -abs(v_earned_points),
         'Reversal of loyalty points for cancelled/refunded order ' || new.order_number,
         new.id, 'reversal')
      on conflict (order_id, transaction_type)
        where order_id is not null do nothing;
    end if;
    return new;
  end if;

  if new.user_id is not null
     and upper(coalesce(new.currency, '')) = 'NGN'
     and lower(coalesce(new.payment_status, '')) = 'paid'
     and (
       lower(coalesce(new.status, '')) = 'delivered'
       or lower(coalesce(new.delivery_status, '')) in ('delivered', 'collected')
     ) then
    v_points := floor(greatest(coalesce(new.subtotal, 0), 0) / 200)::integer;

    if v_points > 0 and not exists (
      select 1 from public.reward_transactions
       where order_id = new.id and transaction_type = 'reversal'
    ) then
      insert into public.reward_transactions
        (user_id, points, reason, order_id, transaction_type)
      values
        (new.user_id, v_points,
         '0.5% loyalty reward for completed order ' || new.order_number,
         new.id, 'earn')
      on conflict (order_id, transaction_type)
        where order_id is not null
      do update set
        user_id = excluded.user_id,
        points = excluded.points,
        reason = excluded.reason;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.award_iyanda_loyalty_points() from public, anon, authenticated;
