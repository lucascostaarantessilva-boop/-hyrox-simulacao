create table public.hyrox_december_settings (
  singleton boolean primary key default true check (singleton),
  starts_at timestamptz not null default '2026-12-05 17:00:00-03',
  price_cents integer not null default 15000 check (price_cents between 100 and 1000000)
);
insert into public.hyrox_december_settings default values;

create table public.hyrox_december_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  team_name text not null,
  athlete1 text not null,
  whatsapp1 text not null,
  athlete2 text not null,
  whatsapp2 text not null,
  category text not null check (category in ('Open', 'Performance')),
  price_cents integer not null,
  payment_id text unique,
  slot integer unique check (slot between 1 and 60),
  status text not null default 'Pendente'
    check (status in ('Pendente', 'Confirmada', 'Expirada', 'Revisar', 'Estornada'))
);

create schema if not exists hyrox_private;
create table hyrox_private.checkout_key (fingerprint text primary key);

alter table public.hyrox_december_settings enable row level security;
alter table public.hyrox_december_entries enable row level security;
revoke all on public.hyrox_december_settings, public.hyrox_december_entries from anon, authenticated;
grant select on public.hyrox_december_settings, public.hyrox_december_entries to authenticated;
grant update (starts_at, price_cents) on public.hyrox_december_settings to authenticated;

create policy december_admin_settings on public.hyrox_december_settings for all to authenticated
  using (lower(auth.jwt()->>'email') = 'lucas.costa.arantes.silva@gmail.com')
  with check (lower(auth.jwt()->>'email') = 'lucas.costa.arantes.silva@gmail.com');
create policy december_admin_entries on public.hyrox_december_entries for select to authenticated
  using (lower(auth.jwt()->>'email') = 'lucas.costa.arantes.silva@gmail.com');

create function public.hyrox_december_checkout(op text, args jsonb, checkout_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  entry public.hyrox_december_entries;
  settings public.hyrox_december_settings;
  confirmed integer;
  occupied integer;
  next_slot integer;
begin
  if not exists (
    select 1 from hyrox_private.checkout_key
      where fingerprint = encode(sha256(convert_to($3, 'UTF8')), 'hex')
  ) then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;

  if op in ('create', 'payment', 'release') then
    perform pg_advisory_xact_lock(20261205);
  end if;
  select * into settings from public.hyrox_december_settings;

  if op in ('summary', 'create') then
    select count(*) filter (where status = 'Confirmada'),
           count(*) filter (where status = 'Confirmada' or (status = 'Pendente' and expires_at > now()))
      into confirmed, occupied from public.hyrox_december_entries;
    if op = 'summary' then
      return jsonb_build_object('confirmed', confirmed, 'available', 60 - occupied,
        'startsAt', settings.starts_at, 'priceCents', settings.price_cents);
    end if;
    if occupied >= 60 or settings.starts_at <= now() then
      return jsonb_build_object('status', 'closed');
    end if;
    insert into public.hyrox_december_entries
      (team_name, athlete1, whatsapp1, athlete2, whatsapp2, category, price_cents)
      values (args->>'team', args->>'athlete1', args->>'whatsapp1', args->>'athlete2',
        args->>'whatsapp2', args->>'category', settings.price_cents)
      returning * into entry;
    return jsonb_build_object('id', entry.id, 'priceCents', entry.price_cents);
  end if;

  select * into entry from public.hyrox_december_entries where id = (args->>'id')::uuid;
  if not found then return null; end if;
  if op = 'release' and entry.status = 'Pendente' then
    update public.hyrox_december_entries set status = 'Expirada' where id = entry.id;
    return null;
  end if;

  if op = 'payment' and (args->>'priceCents')::integer = entry.price_cents then
    if args->>'status' in ('refunded', 'charged_back') and entry.payment_id = args->>'paymentId' then
      update public.hyrox_december_entries set status = 'Estornada', slot = null
        where id = entry.id returning * into entry;
    elsif args->>'status' = 'approved' and entry.payment_id is null then
      if entry.status = 'Pendente' and entry.expires_at > now() then
        select n into next_slot from generate_series(1, 60) as n
          where not exists (select 1 from public.hyrox_december_entries where slot = n)
          order by n limit 1;
      end if;
      update public.hyrox_december_entries
        set payment_id = args->>'paymentId', slot = next_slot,
          status = case when next_slot is null then 'Revisar' else 'Confirmada' end
        where id = entry.id returning * into entry;
    end if;
  end if;
  return jsonb_build_object(
    'status', case when entry.status = 'Pendente' and entry.expires_at <= now()
      then 'Expirada' else entry.status end,
    'heat', (entry.slot - 1) / 4 + 1,
    'startsAt', settings.starts_at + ((entry.slot - 1) / 4) * interval '15 minutes'
  );
end;
$$;
revoke all on function public.hyrox_december_checkout(text, jsonb, text) from public;
grant execute on function public.hyrox_december_checkout(text, jsonb, text) to anon;
