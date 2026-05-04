-- ================================
-- INPOSTSOCIAL — Database Schema
-- Esegui questo su Supabase → SQL Editor
-- ================================

-- TABELLA UTENTI
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
  posts_this_week INTEGER DEFAULT 0,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  plan_activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABELLA STRATEGIE
CREATE TABLE IF NOT EXISTS strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  sector TEXT,
  strategy JSONB,
  posts JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABELLA POST
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  strategy_id UUID REFERENCES strategies(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  text TEXT NOT NULL,
  hashtags TEXT[],
  image_url TEXT,
  scheduled_at TIMESTAMPTZ,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'publishing', 'published', 'failed')),
  platform_post_id TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABELLA CONNESSIONI SOCIAL
CREATE TABLE IF NOT EXISTS social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  access_token TEXT,
  page_access_token TEXT,
  ig_account_id TEXT,
  page_id TEXT,
  pages JSONB,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

-- RESET CONTATORE POST SETTIMANALE (ogni lunedì a mezzanotte)
-- Puoi configurarlo come Supabase Cron Job (Edge Functions)

-- RLS POLICIES (sicurezza)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;

-- Gli utenti vedono solo i propri dati
CREATE POLICY "Users see own data" ON users FOR ALL USING (auth.uid() = id);
CREATE POLICY "Users see own strategies" ON strategies FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users see own posts" ON posts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users see own connections" ON social_connections FOR ALL USING (auth.uid() = user_id);

-- Index per performance
CREATE INDEX IF NOT EXISTS idx_posts_user_status ON posts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies(user_id);
