-- Restore spent loyalty points when an order is cancelled, refunded, or payment fails.
alter table public.reward_transactions
  drop constraint if exists reward_transactions_transaction_type_check;
alter table public.reward_transactions
  add constraint reward_transactions_transaction_type_check
  check (transaction_type in ('manual', 'earn', 'reversal', 'redemption', 'redemption_reversal'));

create or replace function private.award_iyanda_loyalty_points()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_earned_points integer;
  v_earned_user_id uuid;
  v_redeemed_points integer;
  v_redeemed_user_id uuid;
  v_points integer;
begin
  if lower(coalesce(new.payment_status, '')) in ('refunded', 'chargeback', 'failed')
     or lower(coalesce(new.status, '')) in ('cancelled', 'canceled', 'refunded', 'chargeback')
     or lower(coalesce(new.delivery_status, '')) in ('cancelled', 'canceled', 'refunded') then

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

    select points, user_id into v_redeemed_points, v_redeemed_user_id
      from public.reward_transactions
     where order_id = new.id and transaction_type = 'redemption'
     limit 1;

    if found and v_redeemed_user_id is not null and not exists (
      select 1 from public.reward_transactions
       where order_id = new.id and transaction_type = 'redemption_reversal'
    ) then
      insert into public.reward_transactions
        (user_id, points, reason, order_id, transaction_type)
      values
        (v_redeemed_user_id, abs(v_redeemed_points),
         'Refund of loyalty points used on cancelled/failed order ' || new.order_number,
         new.id, 'redemption_reversal')
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
