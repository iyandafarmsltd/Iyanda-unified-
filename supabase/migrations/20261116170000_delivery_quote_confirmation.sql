alter table public.orders add column if not exists delivery_quote_confirmed_at timestamptz;
alter table public.orders add column if not exists delivery_quote_confirmed_by uuid references auth.users(id) on delete set null;
create index if not exists orders_pending_delivery_quote_idx on public.orders (created_at desc) where fulfilment_method = 'delivery' and payment_status <> 'paid' and delivery_quote_confirmed_at is null;
