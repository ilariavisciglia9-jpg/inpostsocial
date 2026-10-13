-- =====================================================================
-- INPOSTSOCIAL.AI — Tabelle dell'Agente AI
-- Incolla tutto in Supabase → SQL Editor → Run. Si può rieseguire senza danni.
-- =====================================================================

-- Profilo del brand: è il "brief" che l'agente usa per lavorare
create table if not exists public.brand_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  brand text,
  sector text,
  description text,
  target text,
  tone text,
  visual_style text,
  city text,
  goal text,
  faq text,
  socials text[] default '{instagram}',
  posting_days int[] default '{0,1,2,3,4,5,6}',
  posting_times text[] default '{18:30}',
  autopilot boolean default false,
  auto_reply boolean default false,
  active boolean default true,
  last_reply_check timestamptz,
  last_manual_plan timestamptz,
  last_manual_report timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Post creati dall'agente (separati dalla tabella "posts" del generatore manuale)
create table if not exists public.agent_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text default 'image',              -- image | carousel | reel
  socials text[] default '{instagram}',
  caption text,
  hashtags text[],
  image_prompt text,
  carousel_prompts text[],
  video_prompt text,
  image_url text,
  carousel_images text[],
  video_url text,
  video_task_id text,
  media_status text default 'pending',    -- pending | video_processing | ready | failed
  media_attempts int default 0,
  status text default 'pending_approval', -- pending_approval | scheduled | publishing | published | failed | rejected | expired
  scheduled_at timestamptz,
  published_at timestamptz,
  ig_media_id text,
  fb_post_id text,
  permalink text,
  error text,
  created_at timestamptz default now()
);
create index if not exists agent_posts_status_idx on public.agent_posts (status, scheduled_at);
create index if not exists agent_posts_user_idx on public.agent_posts (user_id, scheduled_at);
create index if not exists agent_posts_media_idx on public.agent_posts (media_status);

-- Consumi del mese (per i limiti dei piani)
create table if not exists public.agent_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,                    -- formato YYYY-MM
  posts int default 0,
  videos int default 0,
  replies int default 0,
  primary key (user_id, month)
);

-- Commenti Instagram gestiti
create table if not exists public.agent_replies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  comment_id text unique not null,
  media_id text,
  username text,
  comment_text text,
  reply_text text,
  status text,                            -- replied | flagged | skipped | resolved
  created_at timestamptz default now()
);
create index if not exists agent_replies_user_idx on public.agent_replies (user_id, created_at desc);

-- Report periodici
create table if not exists public.agent_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period text,
  data jsonb,
  created_at timestamptz default now()
);

-- Diario di quello che fa l'agente
create table if not exists public.agent_activity (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text,
  message text,
  created_at timestamptz default now()
);
create index if not exists agent_activity_user_idx on public.agent_activity (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- SICUREZZA: le tabelle dell'agente sono accessibili solo dal backend
-- (chiave service). Nessuna policy = nessun accesso dal browser.
-- ---------------------------------------------------------------------
alter table public.brand_profiles enable row level security;
alter table public.agent_posts enable row level security;
alter table public.agent_usage enable row level security;
alter table public.agent_replies enable row level security;
alter table public.agent_reports enable row level security;
alter table public.agent_activity enable row level security;

-- La dashboard legge "strategies" e "posts" direttamente dal browser:
-- con la chiave anon (pubblica) ogni utente vede SOLO i propri dati.
alter table public.strategies enable row level security;
alter table public.posts enable row level security;
alter table public.users enable row level security;
alter table public.social_connections enable row level security;

drop policy if exists "strategies_own_read" on public.strategies;
create policy "strategies_own_read" on public.strategies for select using (auth.uid() = user_id);

drop policy if exists "posts_own_read" on public.posts;
create policy "posts_own_read" on public.posts for select using (auth.uid() = user_id);
