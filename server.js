require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'placeholder');

app.use(cors({
  origin: [process.env.FRONTEND_URL, 'http://localhost:3000'],
  credentials: true
}));
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhook')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'InPostSocial Backend' });
});

app.post('/api/generate', async (req, res) => {
  try {
    const { brand, description, sector, city, usp, goal, socials, frequency, tone, userId } = req.body;
    if (!brand || !description) return res.status(400).json({ error: 'Brand e descrizione obbligatori' });

    if (userId) {
      const { data: user } = await supabase.from('users').select('plan, posts_this_week').eq('id', userId).single();
      if (user && user.plan === 'free' && user.posts_this_week >= 2) {
        return res.status(403).json({ error: 'Limite piano gratuito raggiunto', upgrade: true });
      }
    }

    const socialsList = Array.isArray(socials) ? socials.join(', ') : (socials || 'Instagram');
    const prompt = `Sei un esperto social media manager italiano. Crea strategia e post per questo business.
BRAND: ${brand}
SETTORE: ${sector || 'Non specificato'}
DESCRIZIONE: ${description}
SOCIAL: ${socialsList}
TONO: ${tone || 'professionale'}
Rispondi SOLO con JSON valido:
{"strategy":{"summary":"sintesi","target":"target","content_pillars":["p1","p2","p3"],"best_times":"orari","tips":["t1","t2"]},"posts":[{"social":"Instagram","day":"Lunedi","scheduled_time":"11:00","text":"testo post","hashtags":["h1","h2","h3"]},{"social":"Facebook","day":"Mercoledi","scheduled_time":"12:00","text":"testo post","hashtags":["h1","h2"]},{"social":"Instagram","day":"Venerdi","scheduled_time":"19:00","text":"testo post","hashtags":["h1","h2","h3"]}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = response.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);

    if (userId) {
      await supabase.from('strategies').insert({ user_id: userId, brand, sector, strategy: data.strategy, posts: data.posts, created_at: new Date().toISOString() });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: 'Errore generazione', details: error.message });
  }
});

app.get('/auth/meta', (req, res) => {
  const { userId } = req.query;
  const scope = 'instagram_basic,instagram_business_content_publish,pages_manage_posts,pages_show_list,pages_read_engagement';
  const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.FRONTEND_URL + '/auth/callback')}&scope=${scope}&state=${state}&response_type=code`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=auth_denied`);
    const { userId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: process.env.FRONTEND_URL + '/auth/callback', code }
    });
    const longTokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: tokenRes.data.access_token }
    });
    const longToken = longTokenRes.data.access_token;
    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', { params: { access_token: longToken } });
    if (userId) {
      await supabase.from('social_connections').upsert({ user_id: userId, platform: 'facebook', access_token: longToken, pages: pagesRes.data.data, connected_at: new Date().toISOString() });
    }
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?connected=true`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=auth_failed`);
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, userId, email } = req.body;
    const prices = { pro: process.env.STRIPE_PRICE_PRO, business: process.env.STRIPE_PRICE_BUSINESS };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: prices[plan], quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/dashboard?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL}/#prezzi`,
      metadata: { userId, plan }
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: 'Errore checkout' });
  }
});

app.post('/webhook/stripe', async (req, res) => {
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const { userId, plan } = event.data.object.metadata;
      await supabase.from('users').update({ plan, stripe_customer_id: event.data.object.customer }).eq('id', userId);
    }
    if (event.type === 'customer.subscription.deleted') {
      const { data: user } = await supabase.from('users').select('id').eq('subscription_id', event.data.object.id).single();
      if (user) await supabase.from('users').update({ plan: 'free' }).eq('id', user.id);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: 'Webhook error' });
  }
});

app.post('/api/user/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (error) throw error;
    await supabase.from('users').insert({ id: data.user.id, email, name, plan: 'free', posts_this_week: 0, created_at: new Date().toISOString() });
    res.json({ success: true, userId: data.user.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(404).json({ error: 'Utente non trovato' });
  }
});

cron.schedule('*/15 * * * *', async () => {
  try {
    const { data: posts } = await supabase.from('posts').select('*').eq('status', 'approved').lte('scheduled_at', new Date().toISOString());
    for (const post of posts || []) {
      await supabase.from('posts').update({ status: 'publishing' }).eq('id', post.id);
      console.log('Publishing post:', post.id);
    }
  } catch (e) { console.error('Scheduler error:', e); }
});

app.listen(PORT, () => {
  console.log('InPostSocial Backend running on port', PORT);
  console.log('Anthropic:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING');
  console.log('Supabase:', process.env.SUPABASE_URL ? 'OK' : 'MISSING');
  console.log('Stripe:', process.env.STRIPE_SECRET_KEY ? 'OK' : 'MISSING');
});
