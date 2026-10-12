-- PITLANE Garage — normalized Supabase/PostgreSQL schema
-- Run this script in Supabase SQL Editor. Safe to rerun for upgrades.
create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  plate_number text not null unique,
  make text not null,
  model text not null,
  vehicle_type text not null default 'Motor',
  year integer,
  created_at timestamptz not null default now()
);

create table if not exists public.parts (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  category text not null default 'Umum',
  stock integer not null default 0 check (stock >= 0),
  min_stock integer not null default 3 check (min_stock >= 0),
  unit_cost numeric(14,2) not null default 0 check (unit_cost >= 0),
  selling_price numeric(14,2) not null default 0 check (selling_price >= 0),
  -- Legacy column retained only to safely upgrade an older starter database.
  inventory_history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  job_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  complaint text not null,
  diagnosis text,
  mechanic text,
  status text not null default 'Masuk' check (status in ('Masuk','Dikerjakan','Menunggu Part','Selesai','Diambil')),
  -- Legacy JSONB retained for migration compatibility; application now uses work_order_parts.
  parts_used jsonb not null default '[]'::jsonb,
  labor_hours numeric(8,2) not null default 0 check (labor_hours >= 0),
  labor_rate numeric(14,2) not null default 0 check (labor_rate >= 0),
  overhead numeric(14,2) not null default 0 check (overhead >= 0),
  service_charge numeric(14,2) not null default 0 check (service_charge >= 0),
  parts_revenue numeric(14,2) not null default 0,
  total_cost numeric(14,2) not null default 0,
  total_revenue numeric(14,2) not null default 0,
  gross_profit numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Normalized detail rows: the M:N relationship between work orders and parts.
create table if not exists public.work_order_parts (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  part_id uuid not null references public.parts(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  subtotal_cost numeric(14,2) generated always as (quantity * unit_cost) stored,
  subtotal_price numeric(14,2) generated always as (quantity * unit_price) stored,
  created_at timestamptz not null default now(),
  unique(work_order_id, part_id)
);

-- Permanent, normalized inventory card ledger.
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.parts(id) on delete restrict,
  movement_date date not null default current_date,
  movement_type text not null check (movement_type in ('opening','purchase','sale','adjustment','work_order_issue','work_order_return')),
  reference text,
  qty_in integer not null default 0 check (qty_in >= 0),
  qty_out integer not null default 0 check (qty_out >= 0),
  balance_after integer not null check (balance_after >= 0),
  unit_cost numeric(14,2) not null default 0 check (unit_cost >= 0),
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  notes text,
  work_order_id uuid references public.work_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  check (not (qty_in > 0 and qty_out > 0))
);

create index if not exists idx_vehicles_customer on public.vehicles(customer_id);
create index if not exists idx_work_orders_customer on public.work_orders(customer_id);
create index if not exists idx_work_orders_vehicle on public.work_orders(vehicle_id);
create index if not exists idx_work_orders_status on public.work_orders(status);
create index if not exists idx_parts_name on public.parts(name);
create index if not exists idx_wop_job on public.work_order_parts(work_order_id);
create index if not exists idx_wop_part on public.work_order_parts(part_id);
create index if not exists idx_movements_part_date on public.inventory_movements(part_id, movement_date, created_at);

-- Upgrade old installations with address and legacy columns if necessary.
alter table public.customers add column if not exists address text;
alter table public.parts add column if not exists inventory_history jsonb not null default '[]'::jsonb;
alter table public.work_orders add column if not exists parts_used jsonb not null default '[]'::jsonb;

-- Migrate old JSONB inventory histories only when no normalized ledger exists for that part.
do $$
declare p record; m jsonb; typ text; qin integer; qout integer; bal integer;
begin
  for p in select id, inventory_history, stock, unit_cost, selling_price from public.parts loop
    if jsonb_typeof(coalesce(p.inventory_history, '[]'::jsonb)) = 'array'
       and jsonb_array_length(coalesce(p.inventory_history, '[]'::jsonb)) > 0
       and not exists (select 1 from public.inventory_movements im where im.part_id = p.id) then
      for m in select value from jsonb_array_elements(p.inventory_history) loop
        typ := case coalesce(m->>'type','adjustment')
          when 'opening' then 'opening' when 'purchase' then 'purchase' when 'sale' then 'sale'
          when 'work_order_issue' then 'work_order_issue' when 'work_order_return' then 'work_order_return'
          else 'adjustment' end;
        qin := greatest(0, coalesce((m->>'qty_in')::integer,0));
        qout := greatest(0, coalesce((m->>'qty_out')::integer,0));
        bal := greatest(0, coalesce((m->>'balance')::integer,p.stock));
        insert into public.inventory_movements(part_id,movement_date,movement_type,reference,qty_in,qty_out,balance_after,unit_cost,unit_price,notes)
        values(p.id,coalesce(nullif(m->>'date','')::date,current_date),typ,nullif(m->>'reference',''),qin,qout,bal,
          greatest(0,coalesce((m->>'unit_cost')::numeric,p.unit_cost)),greatest(0,coalesce((m->>'unit_price')::numeric,p.selling_price)),nullif(m->>'notes',''));
      end loop;
    elsif p.stock > 0 and not exists (select 1 from public.inventory_movements im where im.part_id = p.id) then
      insert into public.inventory_movements(part_id,movement_type,reference,qty_in,qty_out,balance_after,unit_cost,unit_price,notes)
      values(p.id,'opening','MIGRATED-OPENING',p.stock,0,p.stock,p.unit_cost,p.selling_price,'Saldo saat migrasi; riwayat transaksi lama tidak tersedia');
    end if;
  end loop;
end $$;

-- Migrate old work_orders.parts_used into relational detail rows without changing stock again.
do $$
declare w record; p jsonb; pid uuid; qty integer; cost numeric; price numeric;
begin
  for w in select id, parts_used from public.work_orders loop
    if jsonb_typeof(coalesce(w.parts_used,'[]'::jsonb)) = 'array' then
      for p in select value from jsonb_array_elements(w.parts_used) loop
        begin pid := nullif(p->>'part_id','')::uuid; exception when others then pid := null; end;
        qty := greatest(0,coalesce((p->>'qty')::integer,0));
        if pid is not null and qty > 0 and exists(select 1 from public.parts where id=pid)
          and not exists(select 1 from public.work_order_parts where work_order_id=w.id and part_id=pid) then
          select unit_cost,selling_price into cost,price from public.parts where id=pid;
          insert into public.work_order_parts(work_order_id,part_id,quantity,unit_cost,unit_price)
          values(w.id,pid,qty,greatest(0,coalesce((p->>'unit_cost')::numeric,cost)),greatest(0,coalesce((p->>'selling_price')::numeric,price)))
          on conflict(work_order_id,part_id) do nothing;
        end if;
      end loop;
    end if;
  end loop;
end $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_parts_updated_at on public.parts;
create trigger trg_parts_updated_at before update on public.parts for each row execute function public.set_updated_at();
drop trigger if exists trg_work_orders_updated_at on public.work_orders;
create trigger trg_work_orders_updated_at before update on public.work_orders for each row execute function public.set_updated_at();

-- Atomic single-item stock movement: row lock prevents two concurrent requests from overselling the same part.
create or replace function public.record_inventory_movement(
  p_part_id uuid, p_movement_type text, p_quantity integer, p_movement_date date default current_date,
  p_unit_cost numeric default null, p_unit_price numeric default null, p_reference text default null,
  p_notes text default null, p_target_stock integer default null, p_work_order_id uuid default null
) returns public.inventory_movements
language plpgsql security definer set search_path = public as $$
declare p public.parts%rowtype; new_stock integer; qin integer := 0; qout integer := 0; result public.inventory_movements%rowtype;
begin
  select * into p from public.parts where id=p_part_id for update;
  if not found then raise exception 'Suku cadang tidak ditemukan.'; end if;
  if p_movement_type not in ('opening','purchase','sale','adjustment','work_order_issue','work_order_return') then raise exception 'Jenis pergerakan stok tidak valid.'; end if;
  if p_movement_type = 'adjustment' then
    if p_target_stock is null or p_target_stock < 0 then raise exception 'Target stok penyesuaian tidak valid.'; end if;
    new_stock := p_target_stock; qin := greatest(0,new_stock-p.stock); qout := greatest(0,p.stock-new_stock);
  else
    if p_quantity is null or p_quantity <= 0 then raise exception 'Jumlah transaksi harus bilangan bulat minimal 1.'; end if;
    if p_movement_type in ('purchase','opening','work_order_return') then qin := p_quantity; new_stock := p.stock + p_quantity;
    else qout := p_quantity; new_stock := p.stock - p_quantity; end if;
  end if;
  if new_stock < 0 then raise exception 'Stok % tidak cukup. Saldo tersedia % unit.', p.name, p.stock; end if;
  update public.parts set stock=new_stock,
    unit_cost=coalesce(p_unit_cost,unit_cost), selling_price=coalesce(p_unit_price,selling_price)
    where id=p_part_id;
  insert into public.inventory_movements(part_id,movement_date,movement_type,reference,qty_in,qty_out,balance_after,unit_cost,unit_price,notes,work_order_id)
  values(p_part_id,coalesce(p_movement_date,current_date),p_movement_type,p_reference,qin,qout,new_stock,
    greatest(0,coalesce(p_unit_cost,p.unit_cost)),greatest(0,coalesce(p_unit_price,p.selling_price)),p_notes,p_work_order_id)
  returning * into result;
  return result;
end; $$;

-- Backend uses the service-role key. Never put that key in browser code.
alter table public.customers enable row level security;
alter table public.vehicles enable row level security;
alter table public.parts enable row level security;
alter table public.work_orders enable row level security;
alter table public.work_order_parts enable row level security;
alter table public.inventory_movements enable row level security;
revoke all on function public.record_inventory_movement(uuid,text,integer,date,numeric,numeric,text,text,integer,uuid) from public, anon, authenticated;
grant execute on function public.record_inventory_movement(uuid,text,integer,date,numeric,numeric,text,text,integer,uuid) to service_role;
-- Intentionally no anon policies; all access goes through the backend API.


-- Accounts receivable: one invoice per work order and multiple payments per invoice.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  work_order_id uuid not null unique references public.work_orders(id) on delete cascade,
  invoice_date date not null default current_date,
  due_date date not null default (current_date + 7),
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),
  status text not null default 'Belum Dibayar' check (status in ('Belum Dibayar','Dibayar Sebagian','Lunas')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (paid_amount <= total_amount)
);
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  payment_number text not null unique,
  payment_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'Tunai' check (method in ('Tunai','Transfer Bank','QRIS','Kartu Debit/Kredit','Lainnya')),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_invoices_status on public.invoices(status);
create index if not exists idx_payments_invoice on public.payments(invoice_id, payment_date);
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at before update on public.invoices for each row execute function public.set_updated_at();

-- Backfill an invoice for every existing work order that does not have one yet.
insert into public.invoices(invoice_number,work_order_id,invoice_date,due_date,total_amount,paid_amount,status,notes)
select 'INV-' || w.job_number, w.id, coalesce(w.created_at::date,current_date), coalesce(w.created_at::date,current_date)+7,
       greatest(0,w.total_revenue), 0, 'Belum Dibayar', 'Invoice otomatis dari work order'
from public.work_orders w
where not exists (select 1 from public.invoices i where i.work_order_id=w.id)
on conflict (work_order_id) do nothing;
revoke all on public.invoices, public.payments from anon, authenticated;


-- Atomic AR payment: lock invoice, validate outstanding, record payment and update status together.
create or replace function public.record_invoice_payment(
  p_invoice_id uuid, p_amount numeric, p_payment_date date default current_date,
  p_method text default 'Tunai', p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices%rowtype; pay public.payments%rowtype; new_paid numeric(14,2); new_status text; outstanding numeric(14,2); pay_no text;
begin
  select * into inv from public.invoices where id=p_invoice_id for update;
  if not found then raise exception 'Invoice tidak ditemukan.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Jumlah pembayaran harus lebih besar dari nol.'; end if;
  outstanding := round(inv.total_amount - inv.paid_amount,2);
  if p_amount > outstanding then raise exception 'Pembayaran melebihi sisa tagihan %.', outstanding; end if;
  pay_no := 'PAY-' || to_char(coalesce(p_payment_date,current_date),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.payments(invoice_id,payment_number,payment_date,amount,method,notes)
  values(inv.id,pay_no,coalesce(p_payment_date,current_date),p_amount,coalesce(p_method,'Tunai'),p_notes) returning * into pay;
  new_paid := round(inv.paid_amount + p_amount,2);
  new_status := case when new_paid >= inv.total_amount then 'Lunas' when new_paid > 0 then 'Dibayar Sebagian' else 'Belum Dibayar' end;
  update public.invoices set paid_amount=new_paid,status=new_status where id=inv.id;
  return jsonb_build_object('payment',to_jsonb(pay),'paid_amount',new_paid,'outstanding',round(inv.total_amount-new_paid,2),'status',new_status);
end; $$;
revoke all on function public.record_invoice_payment(uuid,numeric,date,text,text) from public, anon, authenticated;
grant execute on function public.record_invoice_payment(uuid,numeric,date,text,text) to service_role;
