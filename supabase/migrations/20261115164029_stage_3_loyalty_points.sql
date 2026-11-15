-- Iyanda One Stage 3: loyalty earning policy
-- Policy approved: 0.5% back; 1 point = NGN 1; 1 point per NGN 200.
-- Minimum redemption policy: 500 points (NGN 500).
-- Eligible base: NGN product subtotal only; excludes delivery fees and taxes.
-- This migration awards points securely. Checkout redemption is intentionally
-- not enabled by this migration; it must be connected to the order-creation
-- flow transactionally before customers can spend points.

alter table public.reward_transactions
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists transaction_type text not null default 'manual';

alter table public.reward_transactions
  drop constraint if exists reward_transactions_transaction_type_check;
alter table public.reward_transactions
  add constraint reward_transactions_transaction_type_check
  check (transaction_type in ('manual', 'earn', 'reversal', 'redemption'));

create unique index if not exists reward_transactions_order_type_uidx
  on public.reward_transactions(order_id, transaction_type)
  where order_id is not null;

create schema if not exists private;

create or replace function private.award_iyanda_loyalty_points()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_points integer;
  v_earned_points integer;
begin
  if lower(coalesce(new.payment_status, '')) in ('refunded', 'chargeback')
     or lower(coalesce(new.status, '')) in ('cancelled', 'refunded', 'chargeback')
     or lower(coalesce(new.delivery_status, '')) in ('cancelled', 'refunded') then
    select points into v_earned_points
      from public.reward_transactions
     where order_id = new.id and transaction_type = 'earn'
     limit 1;

    if found and not exists (
      select 1 from public.reward_transactions
       where order_id = new.id and transaction_type = 'reversal'
    ) then
      insert into public.reward_transactions
        (user_id, points, reason, order_id, transaction_type)
      values
        (new.user_id, -abs(v_earned_points),
         'Reversal of loyalty points for cancelled/refunded order ' || new.order_number,
         new.id, 'reversal')
      on conflict (order_id, transaction_type)
        where order_id is not null do nothing;
    end if;
    return new;
  end if;

  if upper(coalesce(new.currency, '')) = 'NGN'
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

revoke all on function private.award_iyanda_loyalty_points() from public;
revoke all on function private.award_iyanda_loyalty_points() from anon;
revoke all on function private.award_iyanda_loyalty_points() from authenticated;

drop trigger if exists trg_award_iyanda_loyalty_points on public.orders;
create trigger trg_award_iyanda_loyalty_points
after insert or update of status, payment_status, delivery_status, subtotal, currency, user_id
on public.orders
for each row
execute function private.award_iyanda_loyalty_points();
