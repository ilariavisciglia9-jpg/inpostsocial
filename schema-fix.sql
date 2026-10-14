-- =====================================================================
-- INPOSTSOCIAL — allineamento tabelle con il codice del server
-- Da eseguire UNA volta in Supabase → SQL Editor → New query → Run.
-- Aggiunge solo le colonne mancanti: non cancella e non modifica dati.
-- =====================================================================

-- POST GENERATI / APPROVATI
alter table public.posts add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.posts add column if not exists platform text;
alter table public.posts add column if not exists text text;
alter table public.posts add column if not exists hashtags jsonb;
alter table public.posts add column if not exists image_url text;
alter table public.posts add column if not exists carousel_images jsonb;
alter table public.posts add column if not exists video_url text;
alter table public.posts add column if not exists video_task_id text;
alter table public.posts add column if not exists status text default 'approved';
alter table public.posts add column if not exists scheduled_at timestamptz;
alter table public.posts add column if not exists day text;
alter table public.posts add column if not exists type text default 'image';
alter table public.posts add column if not exists brand text;
alter table public.posts add column if not exists created_at timestamptz default now();
alter table public.posts add column if not exists published_at timestamptz;
alter table public.posts add column if not exists ig_media_id text;
alter table public.posts add column if not exists error text;

-- SOCIAL COLLEGATI (Facebook / Instagram)
alter table public.social_connections add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.social_connections add column if not exists platform text;
alter table public.social_connections add column if not exists access_token text;
alter table public.social_connections add column if not exists pages jsonb;
alter table public.social_connections add column if not exists ig_account_id text;
alter table public.social_connections add column if not exists page_id text;
alter table public.social_connections add column if not exists page_name text;
alter table public.social_connections add column if not exists page_access_token text;
alter table public.social_connections add column if not exists connected_at timestamptz default now();

-- UTENTI
alter table public.users add column if not exists email text;
alter table public.users add column if not exists name text;
alter table public.users add column if not exists plan text default 'free';
alter table public.users add column if not exists brand text;
alter table public.users add column if not exists sector text;
alter table public.users add column if not exists stripe_customer_id text;
alter table public.users add column if not exists subscription_id text;
alter table public.users add column if not exists posts_this_week int default 0;
alter table public.users add column if not exists created_at timestamptz default now();

-- STRATEGIE GENERATE
alter table public.strategies add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.strategies add column if not exists brand text;
alter table public.strategies add column if not exists sector text;
alter table public.strategies add column if not exists strategy jsonb;
alter table public.strategies add column if not exists posts jsonb;
alter table public.strategies add column if not exists created_at timestamptz default now();

-- aggiorna subito la cache dello schema usata dalle API
notify pgrst, 'reload schema';
