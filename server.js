require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'placeholder');

app.use(cors({ origin: [process.env.FRONTEND_URL, 'http://localhost:3000'], credentials: true }));
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhook')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/healthz', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

// ===== GENERATE =====
app.post('/api/generate', async (req, res) => {
  try {
    const { brand, description, sector, city, usp, goal, socials, frequency, tone, userId, generateImages, generateVideo } = req.body;
    if (!brand || !description) return res.status(400).json({ error: 'Brand e descrizione obbligatori' });

    if (userId) {
      const { data: user } = await supabase.from('users').select('plan,posts_this_week').eq('id', userId).single();
      if (user && user.plan === 'free' && user.posts_this_week >= 2) {
        return res.status(403).json({ error: 'Limite piano gratuito raggiunto', upgrade: true });
      }
    }

    const socialsList = Array.isArray(socials) ? socials.join(', ') : (socials || 'Instagram');

    const prompt = `Sei un social media manager italiano. Crea strategia e 5 post per questo brand.
BRAND: ${brand}
SETTORE: ${sector || 'generale'}
DESCRIZIONE: ${description}
SOCIAL: ${socialsList}
TONO: ${tone || 'professionale'}

Rispondi SOLO con JSON valido, niente testo fuori dal JSON:
{"strategy":{"summary":"sintesi strategia in 2 frasi","target":"descrizione pubblico target","content_pillars":["pillar1","pillar2","pillar3"],"best_times":"orari migliori per pubblicare","tips":["consiglio1","consiglio2"]},"posts":[{"social":"Instagram","type":"image","day":"Lunedi","scheduled_time":"11:00","text":"testo completo del post con emoji e call to action","hashtags":["hashtag1","hashtag2","hashtag3","hashtag4","hashtag5"],"image_prompt":"descrizione dettagliata immagine professionale"},{"social":"Instagram","type":"reel","day":"Mercoledi","scheduled_time":"19:00","text":"testo coinvolgente per il reel","hashtags":["hashtag1","hashtag2","hashtag3","hashtag4","hashtag5"],"image_prompt":"scena di apertura del video","video_prompt":"descrizione video breve 5 secondi stile cinematografico"},{"social":"Facebook","type":"image","day":"Venerdi","scheduled_time":"12:00","text":"testo dettagliato per Facebook","hashtags":["hashtag1","hashtag2","hashtag3"],"image_prompt":"immagine professionale per Facebook"},{"social":"Instagram","type":"carousel","day":"Sabato","scheduled_time":"10:00","text":"testo del carosello","hashtags":["hashtag1","hashtag2","hashtag3"],"carousel_slides":[{"title":"Slide 1","image_prompt":"descrizione prima slide"},{"title":"Slide 2","image_prompt":"descrizione seconda slide"},{"title":"Slide 3","image_prompt":"descrizione terza slide"}]},{"social":"Instagram","type":"image","day":"Martedi","scheduled_time":"20:00","text":"testo del quinto post","hashtags":["hashtag1","hashtag2","hashtag3"],"image_prompt":"descrizione immagine"}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = response.content.map(b => b.text || '').join('');
    let data;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      data = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    } catch (parseErr) {
      console.error('JSON parse error, raw:', raw.substring(0, 300));
      return res.status(500).json({ error: 'Errore parsing risposta AI', details: parseErr.message });
    }

    // Genera immagini DALL-E 3
    if (generateImages && process.env.OPENAI_API_KEY) {
      for (let i = 0; i < data.posts.length; i++) {
        const post = data.posts[i];
        try {
          if (post.type === 'carousel' && post.carousel_slides) {
            const imgs = [];
            for (const slide of post.carousel_slides.slice(0, 3)) {
              imgs.push(await generateImage(slide.image_prompt, brand));
            }
            data.posts[i].carousel_images = imgs;
            data.posts[i].image_url = imgs[0];
          } else if (post.image_prompt) {
            data.posts[i].image_url = await generateImage(post.image_prompt, brand);
          }
        } catch (e) { console.error('Image error post', i, ':', e.message); }
      }
    }

    // Genera video Kling
    if (generateVideo && process.env.KLING_ACCESS_KEY) {
      for (let i = 0; i < data.posts.length; i++) {
        const post = data.posts[i];
        if (post.type === 'reel' && post.video_prompt) {
          try {
            const v = await generateKlingVideo(post.video_prompt, post.image_url);
            data.posts[i].video_task_id = v.task_id;
            data.posts[i].video_status = 'processing';
          } catch (e) { console.error('Video error post', i, ':', e.message); }
        }
      }
    }

    if (userId) {
      await supabase.from('strategies').insert({
        user_id: userId, brand, sector,
        strategy: data.strategy, posts: data.posts,
        created_at: new Date().toISOString()
      });
    }

    res.json({ success: true, data });

  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: 'Errore generazione', details: error.message });
  }
});

// ===== DALL-E 3 =====
async function generateImage(prompt, brand) {
  const r = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-3',
      prompt: `Professional social media image for "${brand}": ${prompt}. High quality, photorealistic, modern aesthetic. No text overlay.`,
      n: 1,
      size: '1024x1024',
      quality: 'standard'
    },
    { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return r.data.data[0].url;
}

app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, brand, userId } = req.body;
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI non configurato' });
    const url = await generateImage(prompt, brand || 'Brand');
    res.json({ success: true, url });
  } catch (e) { res.status(500).json({ error: 'Errore immagine', details: e.message }); }
});

app.post('/api/generate-carousel', async (req, res) => {
  try {
    const { prompts, brand, userId } = req.body;
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI non configurato' });
    const images = [];
    for (const p of (prompts || []).slice(0, 5)) images.push(await generateImage(p, brand));
    res.json({ success: true, images });
  } catch (e) { res.status(500).json({ error: 'Errore carosello', details: e.message }); }
});

// ===== KLING AI =====
function klingToken() {
  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ iss: ak, exp: now + 1800, nbf: now - 5 })).toString('base64url');
  const s = crypto.createHmac('sha256', sk).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

async function generateKlingVideo(prompt, imageUrl) {
  const body = {
    model_name: 'kling-v1',
    prompt,
    negative_prompt: 'blurry, low quality, text, watermark',
    cfg_scale: 0.5,
    mode: 'std',
    duration: '5'
  };
  if (imageUrl) body.image = imageUrl;
  const r = await axios.post(
    'https://api.klingai.com/v1/videos/text2video',
    body,
    { headers: { 'Authorization': `Bearer ${klingToken()}`, 'Content-Type': 'application/json' } }
  );
  return r.data.data;
}

app.post('/api/generate-video', async (req, res) => {
  try {
    const { prompt, imageUrl, userId } = req.body;
    if (!process.env.KLING_ACCESS_KEY) return res.status(400).json({ error: 'Kling non configurato' });
    const result = await generateKlingVideo(prompt, imageUrl);
    res.json({ success: true, task_id: result.task_id, status: 'processing' });
  } catch (e) { res.status(500).json({ error: 'Errore video', details: e.message }); }
});

app.get('/api/video-status/:taskId', async (req, res) => {
  try {
    const r = await axios.get(
      `https://api.klingai.com/v1/videos/text2video/${req.params.taskId}`,
      { headers: { 'Authorization': `Bearer ${klingToken()}` } }
    );
    const d = r.data.data;
    res.json({ success: true, status: d.task_status, video_url: d.task_result?.videos?.[0]?.url || null });
  } catch (e) { res.status(500).json({ error: 'Errore stato video' }); }
});

// ===== META OAUTH =====
app.get('/auth/meta', (req, res) => {
  const { userId } = req.query;
  const scope = 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,pages_manage_posts';
  const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.FRONTEND_URL + '/auth/callback')}&scope=${scope}&state=${state}&response_type=code`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?error=auth_denied`);
    const { userId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const t1 = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: process.env.FRONTEND_URL + '/auth/callback', code }
    });
    const t2 = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: t1.data.access_token }
    });
    const longToken = t2.data.access_token;
    const pages = (await axios.get('https://graph.facebook.com/v19.0/me/accounts', { params: { access_token: longToken } })).data.data;
    if (userId) {
      await supabase.from('social_connections').upsert({ user_id: userId, platform: 'facebook', access_token: longToken, pages, connected_at: new Date().toISOString() });
      for (const page of pages) {
        try {
          const ig = await axios.get(`https://graph.facebook.com/v19.0/${page.id}`, { params: { fields: 'instagram_business_account', access_token: page.access_token } });
          if (ig.data.instagram_business_account) {
            await supabase.from('social_connections').upsert({ user_id: userId, platform: 'instagram', ig_account_id: ig.data.instagram_business_account.id, page_id: page.id, page_access_token: page.access_token, connected_at: new Date().toISOString() });
          }
        } catch (e) { console.log('No Instagram for page:', page.name); }
      }
    }
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?connected=true`);
  } catch (e) {
    console.error('OAuth error:', e.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?error=auth_failed`);
  }
});

// ===== STRIPE =====
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, userId, email } = req.body;
    const prices = { pro: process.env.STRIPE_PRICE_PRO, business: process.env.STRIPE_PRICE_BUSINESS };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: prices[plan], quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/dashboard.html?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL}/index.html#prezzi`,
      metadata: { userId, plan }
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Checkout error:', e.message);
    res.status(500).json({ error: 'Errore checkout', details: e.message });
  }
});

app.post('/webhook/stripe', async (req, res) => {
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const { userId, plan } = event.data.object.metadata;
      await supabase.from('users').update({ plan, stripe_customer_id: event.data.object.customer, subscription_id: event.data.object.subscription }).eq('id', userId);
    }
    if (event.type === 'customer.subscription.deleted') {
      const { data: u } = await supabase.from('users').select('id').eq('subscription_id', event.data.object.id).single();
      if (u) await supabase.from('users').update({ plan: 'free', subscription_id: null }).eq('id', u.id);
    }
    res.json({ received: true });
  } catch (e) { res.status(400).json({ error: 'Webhook error' }); }
});

// ===== USER =====
app.post('/api/user/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (error) throw error;
    await supabase.from('users').insert({ id: data.user.id, email, name, plan: 'free', posts_this_week: 0, created_at: new Date().toISOString() });
    res.json({ success: true, userId: data.user.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(404).json({ error: 'Utente non trovato' }); }
});

// ===== PUBBLICA SU INSTAGRAM =====
async function publishToInstagram(igAccountId, pageAccessToken, post) {
  const caption = post.text + '\n\n' + (post.hashtags || []).map(h => '#' + h).join(' ');
  if (!post.image_url) throw new Error('Nessuna immagine per il post');

  // Step 1: crea container media
  const containerRes = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media`,
    { image_url: post.image_url, caption, access_token: pageAccessToken }
  );
  const creationId = containerRes.data.id;

  // Step 2: pubblica il container
  const publishRes = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`,
    { creation_id: creationId, access_token: pageAccessToken }
  );
  return publishRes.data.id;
}

app.post('/api/publish', async (req, res) => {
  try {
    const { postId, userId } = req.body;
    const { data: post, error: postErr } = await supabase.from('posts').select('*').eq('id', postId).single();
    if (postErr || !post) return res.status(404).json({ error: 'Post non trovato' });
    const { data: conn, error: connErr } = await supabase.from('social_connections')
      .select('*').eq('user_id', userId).eq('platform', 'instagram').single();
    if (connErr || !conn) return res.status(400).json({ error: 'Account Instagram non collegato' });
    const mediaId = await publishToInstagram(conn.ig_account_id, conn.page_access_token, post);
    await supabase.from('posts').update({ status: 'published', published_at: new Date().toISOString(), ig_media_id: mediaId }).eq('id', postId);
    res.json({ success: true, ig_media_id: mediaId });
  } catch (e) {
    console.error('Publish error:', e.message);
    res.status(500).json({ error: 'Errore pubblicazione', details: e.message });
  }
});

// ===== SCHEDULER =====
cron.schedule('*/15 * * * *', async () => {
  try {
    const { data: posts } = await supabase.from('posts').select('*').eq('status', 'approved').lte('scheduled_at', new Date().toISOString());
    for (const post of posts || []) {
      await supabase.from('posts').update({ status: 'publishing' }).eq('id', post.id);
      try {
        const { data: conn } = await supabase.from('social_connections')
          .select('*').eq('user_id', post.user_id).eq('platform', 'instagram').single();
        if (conn) {
          const mediaId = await publishToInstagram(conn.ig_account_id, conn.page_access_token, post);
          await supabase.from('posts').update({ status: 'published', published_at: new Date().toISOString(), ig_media_id: mediaId }).eq('id', post.id);
          console.log('✅ Published post:', post.id, '→ IG media:', mediaId);
        }
      } catch (pubErr) {
        console.error('❌ Publish failed for post', post.id, ':', pubErr.message);
        await supabase.from('posts').update({ status: 'failed', error: pubErr.message }).eq('id', post.id);
      }
    }
  } catch (e) { console.error('Scheduler error:', e); }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`🚀 InPostSocial v2.0 on port ${PORT}`);
  console.log(`🤖 Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'}`);
  console.log(`🖼️  DALL-E 3: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
  console.log(`🎬 Kling AI: ${process.env.KLING_ACCESS_KEY ? '✅' : '❌'}`);
  console.log(`📊 Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`📘 Meta: ${process.env.META_APP_ID ? '✅' : '❌'}`);
});
