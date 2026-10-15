-- =====================================================================
-- INPOSTSOCIAL — CREDITI
-- Da eseguire UNA volta in Supabase → SQL Editor → New query → Run.
-- Non cancella dati: aggiunge il saldo crediti e lo storico dei movimenti.
-- =====================================================================

-- saldo crediti di ogni account
alter table public.users add column if not exists credits integer not null default 0;

-- storico movimenti (acquisti, crediti del piano, consumi)
create table if not exists public.credit_ledger (
  id bigserial primary key,
  user_id uuid not null,
  delta integer not null,
  reason text,
  ref text unique,              -- id del pagamento Stripe: lo stesso pagamento non accredita due volte
  balance_after integer,
  created_at timestamptz default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);
alter table public.credit_ledger enable row level security;

-- scala crediti solo se bastano (restituisce il nuovo saldo, oppure -1 se non bastano)
create or replace function public.spend_credits(p_user uuid, p_amount integer, p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare new_balance integer;
begin
  if p_amount <= 0 then
    select credits into new_balance from users where id = p_user;
    return coalesce(new_balance, 0);
  end if;
  update users set credits = credits - p_amount
    where id = p_user and credits >= p_amount
    returning credits into new_balance;
  if new_balance is null then return -1; end if;
  insert into credit_ledger (user_id, delta, reason, balance_after) values (p_user, -p_amount, p_reason, new_balance);
  return new_balance;
end $$;

-- aggiunge crediti (con ref: se il pagamento è già stato accreditato non fa nulla)
create or replace function public.add_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns integer language plpgsql security definer set search_path = public as $$
declare new_balance integer;
begin
  if p_ref is not null and exists (select 1 from credit_ledger where ref = p_ref) then
    select credits into new_balance from users where id = p_user;
    return coalesce(new_balance, 0);
  end if;
  update users set credits = credits + p_amount where id = p_user returning credits into new_balance;
  if new_balance is null then return -1; end if;
  insert into credit_ledger (user_id, delta, reason, ref, balance_after) values (p_user, p_amount, p_reason, p_ref, new_balance);
  return new_balance;
end $$;

-- solo il server (chiave service_role) può usarle
revoke all on function public.spend_credits(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
