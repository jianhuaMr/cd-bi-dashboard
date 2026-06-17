-- CD-BI Supabase cloud sync schema
-- Safe mode: only authenticated Supabase users can read/write.

create table if not exists public.cdbi_records (
  store_name text not null,
  record_key text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (store_name, record_key)
);

create index if not exists cdbi_records_store_updated_idx
  on public.cdbi_records (store_name, updated_at desc);

create or replace function public.cdbi_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cdbi_records_touch_updated_at on public.cdbi_records;
create trigger cdbi_records_touch_updated_at
before update on public.cdbi_records
for each row execute function public.cdbi_touch_updated_at();

alter table public.cdbi_records enable row level security;

drop policy if exists "CD-BI team read" on public.cdbi_records;
drop policy if exists "CD-BI team insert" on public.cdbi_records;
drop policy if exists "CD-BI team update" on public.cdbi_records;
drop policy if exists "CD-BI team delete" on public.cdbi_records;

drop policy if exists "CD-BI anon read" on public.cdbi_records;
drop policy if exists "CD-BI anon write" on public.cdbi_records;
drop policy if exists "CD-BI anon update" on public.cdbi_records;
drop policy if exists "CD-BI anon delete" on public.cdbi_records;

create policy "CD-BI team read"
on public.cdbi_records for select
to authenticated
using (true);

create policy "CD-BI team insert"
on public.cdbi_records for insert
to authenticated
with check (store_name in (
  'summary',
  'detail',
  'kuaishou',
  'exchangeRates',
  'inventoryMonthly',
  'inventoryMovementMonthly',
  'monthlyCostAnalysis',
  'productMaster',
  'uploadRecords'
));

create policy "CD-BI team update"
on public.cdbi_records for update
to authenticated
using (true)
with check (store_name in (
  'summary',
  'detail',
  'kuaishou',
  'exchangeRates',
  'inventoryMonthly',
  'inventoryMovementMonthly',
  'monthlyCostAnalysis',
  'productMaster',
  'uploadRecords'
));

create policy "CD-BI team delete"
on public.cdbi_records for delete
to authenticated
using (true);
