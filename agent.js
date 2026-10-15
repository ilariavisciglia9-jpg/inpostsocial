// =====================================================================
// INPOSTSOCIAL — AGENTE AI AUTONOMO (social media manager)
// ---------------------------------------------------------------------
// Modulo aggiuntivo: non tocca il generatore manuale né la tabella
// "posts" esistente. Lavora sulle proprie tabelle (vedi schema-agent.sql).
//
// Cosa fa da solo:
//  1. Pianifica i post della settimana in base al piano e al profilo brand
//  2. Genera immagini, caroselli e video Reel
//  3. Pubblica su Instagram e Facebook all'orario stabilito
//  4. Risponde ai commenti Instagram (piani Pro e Business)
//  5. Scrive un report con i risultati e lo usa per migliorare i post
// =====================================================================

const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');

const TZ = 'Europe/Rome';
const GRAPH = 'https://graph.facebook.com/v19.0';
const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-haiku-4-5-20251001';

// ===== I 3 PIANI =====
// Per cambiare limiti o funzioni di un piano basta modificare qui.
const PLANS = {
  free: {
    key: 'free', label: 'Gratuito', price: 0, agent: false,
    postsPerMonth: 0, videosPerMonth: 0, carousels: false,
    autopilot: false, autoReply: false, repliesPerMonth: 0, replyEveryMin: 0, report: 'none'
  },
  starter: {
    key: 'starter', label: 'Starter', price: 29, agent: true,
    postsPerMonth: 12, videosPerMonth: 0, carousels: false,
    autopilot: false, autoReply: false, repliesPerMonth: 0, replyEveryMin: 0, report: 'monthly'
  },
  pro: {
    key: 'pro', label: 'Pro', price: 79, agent: true,
    postsPerMonth: 30, videosPerMonth: 4, carousels: true,
    autopilot: true, autoReply: true, repliesPerMonth: 300, replyEveryMin: 120, report: 'weekly'
  },
  business: {
    key: 'business', label: 'Business', price: 199, agent: true,
    postsPerMonth: 60, videosPerMonth: 12, carousels: true,
    autopilot: true, autoReply: true, repliesPerMonth: 1500, replyEveryMin: 30, report: 'weekly'
  }
};

const ACTIVE_STATUSES = ['pending_approval', 'scheduled', 'publishing', 'published'];

module.exports = function setupAgent(app, deps) {
  const { supabase, anthropic, fal, generateImage, SEEDANCE_MODEL } = deps;

  // ===================================================================
  // UTILITÀ
  // ===================================================================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function tzOffsetMin(date) {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
      .formatToParts(date).find(p => p.type === 'timeZoneName');
    const m = (part ? part.value : '').match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const v = Number(m[2]) * 60 + Number(m[3] || 0);
    return m[1] === '-' ? -v : v;
  }
  function romeYmd(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
  function romeWeekday(date) {
    const d = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[d];
  }
  function romeToUtc(ymd, hm) {
    const [y, mo, d] = ymd.split('-').map(Number);
    const [h, mi] = String(hm || '18:30').split(':').map(Number);
    const guess = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0));
    return new Date(guess.getTime() - tzOffsetMin(guess) * 60000);
  }
  const monthKey = () => romeYmd(new Date()).slice(0, 7);
  const DAY_NAMES = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

  function parseJson(raw) {
    const clean = String(raw || '').replace(/```json|```/g, '').trim();
    const m = clean.match(/[\[{][\s\S]*[\]}]/);
    return JSON.parse(m ? m[0] : clean);
  }

  async function askClaude(prompt, maxTokens) {
    const r = await anthropic.messages.create({
      model: AGENT_MODEL,
      max_tokens: maxTokens || 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    return parseJson(r.content.map(b => b.text || '').join(''));
  }

  async function log(userId, type, message) {
    try { await supabase.from('agent_activity').insert({ user_id: userId, type, message }); }
    catch (e) { console.error('agent log error:', e.message); }
  }

  async function getPlan(userId) {
    const { data } = await supabase.from('users').select('plan,email').eq('id', userId).single();
    let key = (data && data.plan) || 'free';
    const owners = ['info@inpostsocial.com', 'ilaria.visciglia9@gmail.com'].concat((process.env.OWNER_EMAIL || '').split(',')).map(e => e.trim().toLowerCase()).filter(Boolean);
    let email = data && data.email;
    if (!email) {
      try { const { data: au } = await supabase.auth.admin.getUserById(userId); email = au && au.user && au.user.email; } catch (e) { /* ignora */ }
    }
    if (email && owners.includes(String(email).toLowerCase())) key = 'business';
    return PLANS[key] || PLANS.free;
  }

  async function getUsage(userId) {
    const { data } = await supabase.from('agent_usage').select('*')
      .eq('user_id', userId).eq('month', monthKey()).maybeSingle();
    return data || { user_id: userId, month: monthKey(), posts: 0, videos: 0, replies: 0 };
  }

  async function bumpUsage(userId, field, n) {
    const u = await getUsage(userId);
    u[field] = (u[field] || 0) + (n || 1);
    await supabase.from('agent_usage').upsert({
      user_id: userId, month: u.month, posts: u.posts || 0, videos: u.videos || 0, replies: u.replies || 0
    });
  }

  async function getConnections(userId) {
    const { data } = await supabase.from('social_connections').select('*').eq('user_id', userId);
    const rows = data || [];
    const ig = rows.find(r => r.platform === 'instagram' && r.ig_account_id);
    const fbRow = rows.find(r => r.platform === 'facebook');
    let fbPage = null;
    if (ig && ig.page_id) fbPage = { id: ig.page_id, token: ig.page_access_token };
    else if (fbRow && Array.isArray(fbRow.pages) && fbRow.pages[0]) {
      fbPage = { id: fbRow.pages[0].id, token: fbRow.pages[0].access_token };
    }
    return { ig: ig ? { id: ig.ig_account_id, token: ig.page_access_token } : null, fbPage };
  }

  function buildCaption(post) {
    const tags = (post.hashtags || []).map(h => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).join(' ');
    return (post.caption || '') + (tags ? '\n\n' + tags : '');
  }

  // ===================================================================
  // AUTENTICAZIONE (il frontend manda il token di sessione Supabase)
  // ===================================================================
  async function requireUser(req, res, next) {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'Accesso richiesto' });
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data || !data.user) return res.status(401).json({ error: 'Sessione non valida' });
      req.user = data.user;
      req.plan = await getPlan(data.user.id);
      next();
    } catch (e) { res.status(401).json({ error: 'Sessione non valida' }); }
  }

  function requireAgentPlan(req, res, next) {
    if (!req.plan.agent) return res.status(403).json({ error: 'L\'Agente AI è incluso nei piani Starter, Pro e Business', upgrade: true });
    next();
  }

  // ===================================================================
  // 1. PIANIFICAZIONE — crea i post dei prossimi 7 giorni
  // ===================================================================
  async function planForUser(profile, plan) {
    const userId = profile.user_id;
    if (!plan.agent || !profile.active) return 0;

    const usage = await getUsage(userId);
    const remaining = plan.postsPerMonth - (usage.posts || 0);
    if (remaining <= 0) { await log(userId, 'limit', 'Limite mensile di post raggiunto: riprendo il mese prossimo.'); return 0; }

    const now = new Date();
    const weekEnd = new Date(now.getTime() + 8 * 86400000);
    const { data: existing } = await supabase.from('agent_posts').select('id,type,scheduled_at')
      .eq('user_id', userId).in('status', ACTIVE_STATUSES)
      .gte('scheduled_at', now.toISOString()).lte('scheduled_at', weekEnd.toISOString());
    const ex = existing || [];

    const weeklyTarget = Math.max(1, Math.round(plan.postsPerMonth * 12 / 52));
    let need = Math.min(weeklyTarget - ex.length, remaining);
    if (need <= 0) return 0;

    // Slot liberi nei prossimi 7 giorni (da domani)
    const days = Array.isArray(profile.posting_days) && profile.posting_days.length ? profile.posting_days : [0, 1, 2, 3, 4, 5, 6];
    let times = Array.isArray(profile.posting_times) && profile.posting_times.length ? profile.posting_times : ['18:30'];
    if (weeklyTarget > 7 && times.length < 2) times = ['12:30', times[0] === '12:30' ? '19:00' : times[0]];
    const occupied = new Set(ex.map(p => new Date(p.scheduled_at).toISOString()));
    const occupiedDays = new Set(ex.map(p => romeYmd(new Date(p.scheduled_at))));
    const candidates = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      if (!days.includes(romeWeekday(d))) continue;
      const ymd = romeYmd(d);
      for (const t of times) {
        const at = romeToUtc(ymd, t);
        if (occupied.has(at.toISOString())) continue;
        // con un solo orario al giorno, non mettere due post nello stesso giorno
        if (times.length === 1 && occupiedDays.has(ymd)) continue;
        candidates.push({ ymd, time: t, at, weekday: romeWeekday(d) });
      }
    }
    need = Math.min(need, candidates.length);
    if (need <= 0) return 0;
    const slots = [];
    for (let k = 0; k < need; k++) slots.push(candidates[Math.floor(k * candidates.length / need)]);

    // Formati: reel e caroselli secondo il piano
    const weeklyVideos = Math.round(plan.videosPerMonth * 12 / 52);
    const reelsInWeek = ex.filter(p => p.type === 'reel').length;
    const videosLeft = plan.videosPerMonth - (usage.videos || 0);
    let reels = Math.max(0, Math.min(weeklyVideos - reelsInWeek, videosLeft, need));
    let carousels = plan.carousels && need >= 3 && !ex.some(p => p.type === 'carousel') ? 1 : 0;
    slots.forEach((s, i) => { s.type = 'image'; });
    for (let r = 0; r < reels; r++) slots[Math.floor((r + 0.5) * need / reels)].type = 'reel';
    if (carousels) { const c = slots.find(s => s.type === 'image'); if (c) c.type = 'carousel'; }

    // Contesto: ultimi post (per non ripetersi) e ultimo report
    const { data: recent } = await supabase.from('agent_posts').select('caption')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(15);
    const { data: report } = await supabase.from('agent_reports').select('data')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const recos = report && report.data ? (report.data.recommendations || []).join(' | ') : '';

    const slotText = slots.map((s, i) =>
      `${i + 1}. ${DAY_NAMES[s.weekday]} ${s.ymd} ore ${s.time} — formato: ${s.type === 'reel' ? 'REEL video verticale 5 secondi' : s.type === 'carousel' ? 'CAROSELLO 3 slide' : 'POST con immagine singola'}`
    ).join('\n');

    const prompt = `Sei il social media manager AI del brand descritto qui sotto. Scrivi i post per i prossimi giorni.

BRAND: ${profile.brand || ''}
SETTORE: ${profile.sector || ''}
CITTÀ: ${profile.city || ''}
DESCRIZIONE: ${profile.description || ''}
PUBBLICO TARGET: ${profile.target || ''}
OBIETTIVO: ${profile.goal || 'più clienti e più interazioni'}
TONO DI VOCE: ${profile.tone || 'professionale e caldo'}
STILE VISIVO DELLE IMMAGINI: ${profile.visual_style || 'fotografico, luminoso, professionale'}
INFORMAZIONI UTILI (orari, servizi, offerte): ${profile.faq || 'nessuna'}
${recos ? 'CONSIGLI DALL\'ULTIMO REPORT (applicali): ' + recos : ''}

POST GIÀ PUBBLICATI DI RECENTE (non ripetere gli stessi temi o frasi):
${(recent || []).map(r => '- ' + String(r.caption || '').slice(0, 120)).join('\n') || '- nessuno'}

SLOT DA RIEMPIRE:
${slotText}

Regole:
- Lingua italiana, caption tra 300 e 900 caratteri, con una call to action chiara.
- Alterna i temi: prodotti/servizi, dietro le quinte, consigli utili, testimonianze, offerte, stagionalità.
- Non inventare prezzi, sconti o dati che non sono nelle informazioni sopra.
- 5-10 hashtag pertinenti senza il simbolo #, anche locali se c'è la città.
- image_prompt in inglese, dettagliato, senza testo scritto nell'immagine.

Rispondi SOLO con JSON valido:
{"posts":[{"slot":1,"caption":"...","hashtags":["..."],"image_prompt":"...","carousel_prompts":["slide1","slide2","slide3","slide4","slide5"],"video_prompt":"..."}]}
(carousel_prompts solo per i caroselli, video_prompt solo per i reel: movimento di camera e azione in inglese)`;

    const result = await askClaude(prompt, 6000);
    const generated = Array.isArray(result.posts) ? result.posts : [];

    const autopilot = plan.autopilot && profile.autopilot;
    const socials = Array.isArray(profile.socials) && profile.socials.length ? profile.socials : ['instagram'];
    const rows = slots.map((s, i) => {
      const g = generated.find(p => Number(p.slot) === i + 1) || generated[i];
      if (!g || !g.caption) return null;
      return {
        user_id: userId,
        type: s.type,
        socials,
        caption: g.caption,
        hashtags: Array.isArray(g.hashtags) ? g.hashtags.slice(0, 15) : [],
        image_prompt: g.image_prompt || g.caption.slice(0, 300),
        carousel_prompts: s.type === 'carousel' ? (g.carousel_prompts || []).slice(0, 5) : null,
        video_prompt: s.type === 'reel' ? (g.video_prompt || 'slow cinematic camera movement') : null,
        media_status: 'pending',
        status: autopilot ? 'scheduled' : 'pending_approval',
        scheduled_at: s.at.toISOString()
      };
    }).filter(Boolean);

    if (!rows.length) throw new Error('L\'AI non ha restituito post validi');
    const { error } = await supabase.from('agent_posts').insert(rows);
    if (error) throw error;
    await bumpUsage(userId, 'posts', rows.length);
    await log(userId, 'plan', `Ho preparato ${rows.length} nuovi post${autopilot ? ' (autopilota: verranno pubblicati da soli)' : ' da approvare'}.`);
    // genera subito le immagini senza aspettare il prossimo giro
    processMedia().catch(e => console.error('media kick error:', e.message));
    return rows.length;
  }

  async function runPlanner() {
    const { data: profiles } = await supabase.from('brand_profiles').select('*').eq('active', true);
    for (const profile of profiles || []) {
      try {
        const plan = await getPlan(profile.user_id);
        await planForUser(profile, plan);
      } catch (e) {
        console.error('Planner error', profile.user_id, e.message);
        await log(profile.user_id, 'error', 'Errore nella pianificazione: ' + e.message);
      }
    }
  }

  // ===================================================================
  // 2. MEDIA — immagini, caroselli, video (in background)
  // ===================================================================
  async function uploadVideoFromUrl(url) {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    const fileName = `videos/${crypto.randomUUID()}.mp4`;
    const { error } = await supabase.storage.from('post-images')
      .upload(fileName, Buffer.from(r.data), { contentType: 'video/mp4', upsert: false });
    if (error) throw new Error('Upload video: ' + error.message);
    return supabase.storage.from('post-images').getPublicUrl(fileName).data.publicUrl;
  }

  let mediaRunning = false;
  async function processMedia() {
    if (mediaRunning) return;
    mediaRunning = true;
    try {
      const { data: list } = await supabase.from('agent_posts').select('*')
        .in('media_status', ['pending', 'video_processing'])
        .in('status', ['pending_approval', 'scheduled'])
        .order('scheduled_at', { ascending: true }).limit(6);
      const profileCache = {};
      for (const post of list || []) {
        try {
          if (!profileCache[post.user_id]) {
            const { data } = await supabase.from('brand_profiles').select('*').eq('user_id', post.user_id).maybeSingle();
            profileCache[post.user_id] = data || {};
          }
          const profile = profileCache[post.user_id];
          const brand = profile.brand || 'Brand';
          const styled = (p) => profile.visual_style ? `${p}. Visual style: ${profile.visual_style}` : p;
          const upd = {};

          if (post.type === 'carousel') {
            const prompts = (post.carousel_prompts && post.carousel_prompts.length ? post.carousel_prompts : [post.image_prompt]).slice(0, 5);
            const imgs = (post.carousel_images || []).slice();
            for (let i = imgs.length; i < prompts.length; i++) imgs.push(await generateImage(styled(prompts[i]), brand));
            upd.carousel_images = imgs;
            upd.image_url = imgs[0];
            upd.media_status = 'ready';
          } else {
            let imageUrl = post.image_url;
            if (!imageUrl) { imageUrl = await generateImage(styled(post.image_prompt), brand); upd.image_url = imageUrl; }

            if (post.type === 'reel') {
              if (!post.video_task_id) {
                const plan = await getPlan(post.user_id);
                const usage = await getUsage(post.user_id);
                if ((usage.videos || 0) >= plan.videosPerMonth || !process.env.FAL_KEY) {
                  upd.type = 'image'; upd.media_status = 'ready';
                  await log(post.user_id, 'limit', 'Video non disponibile questo mese: il reel diventa un post con immagine.');
                } else {
                  // VIDEO: generazione Reel con Seedance (fal.ai) a partire dall'immagine del post
                  const { request_id } = await fal.queue.submit(SEEDANCE_MODEL, {
                    input: { prompt: post.video_prompt || post.caption.slice(0, 300), image_url: imageUrl, resolution: process.env.VIDEO_RESOLUTION === '720p' ? '720p' : '480p', duration: '5', aspect_ratio: '9:16', generate_audio: false }
                  });
                  upd.video_task_id = request_id;
                  upd.media_status = 'video_processing';
                  await bumpUsage(post.user_id, 'videos', 1);
                }
              } else {
                const st = await fal.queue.status(SEEDANCE_MODEL, { requestId: post.video_task_id, logs: false });
                if (st.status === 'COMPLETED') {
                  const result = await fal.queue.result(SEEDANCE_MODEL, { requestId: post.video_task_id });
                  upd.video_url = await uploadVideoFromUrl(result.data.video.url);
                  upd.media_status = 'ready';
                }
              }
            } else {
              upd.media_status = 'ready';
            }
          }
          if (Object.keys(upd).length) await supabase.from('agent_posts').update(upd).eq('id', post.id);
        } catch (e) {
          console.error('Media error post', post.id, e.message);
          const attempts = (post.media_attempts || 0) + 1;
          const upd = { media_attempts: attempts, error: 'Media: ' + e.message };
          if (attempts >= 3) {
            if (post.type === 'reel' && post.image_url) { upd.type = 'image'; upd.media_status = 'ready'; }
            else upd.media_status = 'failed';
            await log(post.user_id, 'error', 'Non sono riuscito a creare il contenuto visivo di un post: ' + e.message);
          }
          await supabase.from('agent_posts').update(upd).eq('id', post.id);
        }
      }
    } finally { mediaRunning = false; }
  }

  // ===================================================================
  // 3. PUBBLICAZIONE — Instagram e Facebook
  // ===================================================================
  async function waitIgContainer(id, token, tries) {
    for (let i = 0; i < (tries || 36); i++) {
      const r = await axios.get(`${GRAPH}/${id}`, { params: { fields: 'status_code', access_token: token } });
      if (r.data.status_code === 'FINISHED') return;
      if (r.data.status_code === 'ERROR' || r.data.status_code === 'EXPIRED') throw new Error('Instagram ha rifiutato il file (' + r.data.status_code + ')');
      await sleep(5000);
    }
    throw new Error('Instagram non ha finito di elaborare il video in tempo');
  }

  async function publishInstagram(ig, post) {
    const caption = buildCaption(post);
    let creationId;
    if (post.type === 'reel' && post.video_url) {
      const c = await axios.post(`${GRAPH}/${ig.id}/media`, { media_type: 'REELS', video_url: post.video_url, caption, share_to_feed: true, access_token: ig.token });
      creationId = c.data.id;
      await waitIgContainer(creationId, ig.token);
    } else if (post.type === 'carousel' && (post.carousel_images || []).length >= 2) {
      const children = [];
      for (const url of post.carousel_images.slice(0, 10)) {
        const c = await axios.post(`${GRAPH}/${ig.id}/media`, { image_url: url, is_carousel_item: true, access_token: ig.token });
        children.push(c.data.id);
      }
      const c = await axios.post(`${GRAPH}/${ig.id}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: ig.token });
      creationId = c.data.id;
      await waitIgContainer(creationId, ig.token, 12);
    } else {
      if (!post.image_url) throw new Error('Nessuna immagine');
      const c = await axios.post(`${GRAPH}/${ig.id}/media`, { image_url: post.image_url, caption, access_token: ig.token });
      creationId = c.data.id;
      await waitIgContainer(creationId, ig.token, 12);
    }
    const p = await axios.post(`${GRAPH}/${ig.id}/media_publish`, { creation_id: creationId, access_token: ig.token });
    let permalink = null;
    try {
      const m = await axios.get(`${GRAPH}/${p.data.id}`, { params: { fields: 'permalink', access_token: ig.token } });
      permalink = m.data.permalink;
    } catch (e) { /* non indispensabile */ }
    return { id: p.data.id, permalink };
  }

  async function publishFacebook(page, post) {
    const message = buildCaption(post);
    if (post.type === 'reel' && post.video_url) {
      const r = await axios.post(`${GRAPH}/${page.id}/videos`, { file_url: post.video_url, description: message, access_token: page.token });
      return r.data.id;
    }
    if (post.type === 'carousel' && (post.carousel_images || []).length >= 2) {
      const media = [];
      for (const url of post.carousel_images.slice(0, 10)) {
        const r = await axios.post(`${GRAPH}/${page.id}/photos`, { url, published: false, access_token: page.token });
        media.push({ media_fbid: r.data.id });
      }
      const r = await axios.post(`${GRAPH}/${page.id}/feed`, { message, attached_media: media, access_token: page.token });
      return r.data.id;
    }
    const r = await axios.post(`${GRAPH}/${page.id}/photos`, { url: post.image_url, caption: message, access_token: page.token });
    return r.data.post_id || r.data.id;
  }

  const apiErr = (e) => (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;

  let publishRunning = false;
  async function publishDue() {
    if (publishRunning) return;
    publishRunning = true;
    try {
      const nowIso = new Date().toISOString();

      // post da approvare scaduti da più di 24 ore
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      await supabase.from('agent_posts').update({ status: 'expired' })
        .eq('status', 'pending_approval').lt('scheduled_at', dayAgo);

      // post programmati con media non generabile
      await supabase.from('agent_posts').update({ status: 'failed', error: 'Contenuto visivo non disponibile' })
        .eq('status', 'scheduled').eq('media_status', 'failed').lte('scheduled_at', nowIso);

      const { data: due } = await supabase.from('agent_posts').select('*')
        .eq('status', 'scheduled').eq('media_status', 'ready').lte('scheduled_at', nowIso)
        .order('scheduled_at', { ascending: true }).limit(10);

      for (const post of due || []) {
        // blocco: solo un processo pubblica questo post
        const { data: locked } = await supabase.from('agent_posts').update({ status: 'publishing' })
          .eq('id', post.id).eq('status', 'scheduled').select('id');
        if (!locked || !locked.length) continue;

        const conns = await getConnections(post.user_id);
        const socials = post.socials && post.socials.length ? post.socials : ['instagram'];
        const upd = { error: null };
        const errors = [];
        let ok = 0;

        if (socials.includes('instagram')) {
          if (!conns.ig) errors.push('Instagram non collegato');
          else {
            try { const r = await publishInstagram(conns.ig, post); upd.ig_media_id = r.id; upd.permalink = r.permalink; ok++; }
            catch (e) { errors.push('Instagram: ' + apiErr(e)); }
          }
        }
        if (socials.includes('facebook')) {
          if (!conns.fbPage) errors.push('Pagina Facebook non collegata');
          else {
            try { upd.fb_post_id = await publishFacebook(conns.fbPage, post); ok++; }
            catch (e) { errors.push('Facebook: ' + apiErr(e)); }
          }
        }

        if (ok > 0) {
          upd.status = 'published';
          upd.published_at = new Date().toISOString();
          if (errors.length) upd.error = errors.join(' · ');
          await log(post.user_id, 'publish', `Post pubblicato${errors.length ? ' (con avvisi: ' + errors.join(' · ') + ')' : ''}.`);
        } else {
          upd.status = 'failed';
          upd.error = errors.join(' · ') || 'Errore sconosciuto';
          await log(post.user_id, 'error', 'Pubblicazione non riuscita: ' + upd.error);
        }
        await supabase.from('agent_posts').update(upd).eq('id', post.id);
      }
    } catch (e) { console.error('Publisher error:', e.message); }
    finally { publishRunning = false; }
  }

  // ===================================================================
  // 4. RISPOSTE AI COMMENTI INSTAGRAM (Pro e Business)
  // ===================================================================
  async function repliesForUser(profile, plan) {
    const userId = profile.user_id;
    const usage = await getUsage(userId);
    let left = plan.repliesPerMonth - (usage.replies || 0);
    if (left <= 0) return 0;

    const { ig } = await getConnections(userId);
    if (!ig) return 0;

    const me = await axios.get(`${GRAPH}/${ig.id}`, { params: { fields: 'username', access_token: ig.token } });
    const myUsername = me.data.username;
    const media = await axios.get(`${GRAPH}/${ig.id}/media`, { params: { fields: 'id,caption,timestamp', limit: 8, access_token: ig.token } });
    const weekAgo = Date.now() - 7 * 86400000;

    const comments = [];
    for (const m of media.data.data || []) {
      if (new Date(m.timestamp).getTime() < weekAgo - 21 * 86400000) continue;
      const c = await axios.get(`${GRAPH}/${m.id}/comments`, { params: { fields: 'id,text,username,timestamp', limit: 50, access_token: ig.token } });
      for (const cm of c.data.data || []) {
        if (cm.username === myUsername) continue;
        if (new Date(cm.timestamp).getTime() < weekAgo) continue;
        comments.push({ id: cm.id, text: cm.text, username: cm.username, media_id: m.id, post: String(m.caption || '').slice(0, 200) });
      }
    }
    if (!comments.length) return 0;

    const { data: done } = await supabase.from('agent_replies').select('comment_id').in('comment_id', comments.map(c => c.id));
    const doneSet = new Set((done || []).map(d => d.comment_id));
    const todo = comments.filter(c => !doneSet.has(c.id)).slice(0, Math.min(20, left));
    if (!todo.length) return 0;

    const prompt = `Gestisci i commenti Instagram del brand "${profile.brand}" (${profile.sector || ''}, ${profile.city || ''}).
Tono di voce: ${profile.tone || 'cordiale e professionale'}.
Informazioni che puoi usare nelle risposte: ${profile.faq || 'nessuna informazione aggiuntiva'}

Per ogni commento decidi:
- "reply": domande, complimenti, tag ad amici, emoji. Risposta breve (max 2 frasi), naturale, nella lingua del commento, firma implicita del brand. Puoi chiamare la persona per nome utente.
- "flag": lamentele, problemi con ordini/servizi, richieste di prezzi o disponibilità che non trovi nelle informazioni sopra, temi delicati. Questi li gestisce una persona.
- "skip": spam, offese, link sospetti, commenti senza senso.
Non inventare mai prezzi, orari, promozioni o promesse.

COMMENTI:
${todo.map(c => `[${c.id}] @${c.username} (sul post: "${c.post}"): ${c.text}`).join('\n')}

Rispondi SOLO con JSON valido: {"items":[{"id":"...","action":"reply|flag|skip","reply":"testo risposta (solo se reply)"}]}`;

    const result = await askClaude(prompt, 3000);
    let sent = 0;
    for (const c of todo) {
      const d = (result.items || []).find(i => String(i.id) === String(c.id));
      const action = d ? d.action : 'flag';
      const row = { user_id: userId, comment_id: c.id, media_id: c.media_id, username: c.username, comment_text: c.text, reply_text: null, status: action === 'reply' ? 'replied' : action === 'skip' ? 'skipped' : 'flagged' };
      if (action === 'reply' && d.reply && left > 0) {
        try {
          await axios.post(`${GRAPH}/${c.id}/replies`, { message: d.reply, access_token: ig.token });
          row.reply_text = d.reply; sent++; left--;
        } catch (e) { row.status = 'flagged'; row.reply_text = 'Errore invio: ' + apiErr(e); }
      } else if (action === 'reply') row.status = 'flagged';
      await supabase.from('agent_replies').upsert(row, { onConflict: 'comment_id' });
    }
    if (sent) { await bumpUsage(userId, 'replies', sent); await log(userId, 'reply', `Ho risposto a ${sent} commenti su Instagram.`); }
    const flagged = todo.length - sent;
    if (flagged > 0) await log(userId, 'reply', `${flagged} commenti lasciati a te (lamentele, domande senza risposta nelle info o spam).`);
    return sent;
  }

  let repliesRunning = false;
  async function runReplies() {
    if (repliesRunning) return;
    repliesRunning = true;
    try {
      const { data: profiles } = await supabase.from('brand_profiles').select('*').eq('active', true).eq('auto_reply', true);
      for (const profile of profiles || []) {
        try {
          const plan = await getPlan(profile.user_id);
          if (!plan.autoReply) continue;
          const last = profile.last_reply_check ? new Date(profile.last_reply_check).getTime() : 0;
          if (Date.now() - last < (plan.replyEveryMin - 2) * 60000) continue;
          await supabase.from('brand_profiles').update({ last_reply_check: new Date().toISOString() }).eq('user_id', profile.user_id);
          await repliesForUser(profile, plan);
        } catch (e) {
          console.error('Replies error', profile.user_id, apiErr(e));
          await log(profile.user_id, 'error', 'Errore nella lettura dei commenti: ' + apiErr(e));
        }
      }
    } finally { repliesRunning = false; }
  }

  // ===================================================================
  // 5. REPORT — risultati e consigli (usati nella pianificazione)
  // ===================================================================
  async function reportForUser(profile, plan) {
    const userId = profile.user_id;
    const daysBack = plan.report === 'monthly' ? 30 : 7;
    const since = new Date(Date.now() - daysBack * 86400000).toISOString();
    const { data: published } = await supabase.from('agent_posts').select('*')
      .eq('user_id', userId).eq('status', 'published').gte('published_at', since);
    const { ig } = await getConnections(userId);

    const stats = [];
    for (const p of published || []) {
      const s = { id: p.id, type: p.type, caption: String(p.caption || '').slice(0, 140), published_at: p.published_at, permalink: p.permalink, likes: null, comments: null, reach: null, saved: null };
      if (ig && p.ig_media_id) {
        try {
          const m = await axios.get(`${GRAPH}/${p.ig_media_id}`, { params: { fields: 'like_count,comments_count', access_token: ig.token } });
          s.likes = m.data.like_count; s.comments = m.data.comments_count;
        } catch (e) { /* post rimosso o permesso mancante */ }
        try {
          const ins = await axios.get(`${GRAPH}/${p.ig_media_id}/insights`, { params: { metric: 'reach,saved', access_token: ig.token } });
          for (const it of ins.data.data || []) s[it.name] = it.values && it.values[0] ? it.values[0].value : null;
        } catch (e) { /* insights non disponibili */ }
      }
      stats.push(s);
    }

    let data;
    if (!stats.length) {
      data = { summary: `Nessun post pubblicato negli ultimi ${daysBack} giorni.`, highlights: [], recommendations: ['Collega Instagram e approva i post in attesa per iniziare a raccogliere risultati.'], totals: {} };
    } else {
      const totals = stats.reduce((t, s) => ({ posts: t.posts + 1, likes: t.likes + (s.likes || 0), comments: t.comments + (s.comments || 0), reach: t.reach + (s.reach || 0), saved: t.saved + (s.saved || 0) }), { posts: 0, likes: 0, comments: 0, reach: 0, saved: 0 });
      const prompt = `Sei il social media manager del brand "${profile.brand}" (${profile.sector || ''}). Analizza i risultati degli ultimi ${daysBack} giorni.
OBIETTIVO DEL BRAND: ${profile.goal || 'crescita e clienti'}
DATI POST (JSON): ${JSON.stringify(stats)}
TOTALI: ${JSON.stringify(totals)}

Scrivi in italiano, semplice, per un imprenditore non esperto. Rispondi SOLO con JSON valido:
{"summary":"3-4 frasi su com'è andata","highlights":["cosa ha funzionato meglio e perché","..."],"recommendations":["consiglio concreto 1 per i prossimi post","consiglio 2","consiglio 3"],"best_post_id":"id del post migliore"}`;
      data = await askClaude(prompt, 2000);
      data.totals = totals;
      data.posts = stats;
    }
    await supabase.from('agent_reports').insert({ user_id: userId, period: `${daysBack} giorni fino al ${romeYmd(new Date())}`, data });
    await log(userId, 'report', 'Nuovo report disponibile.');
    return data;
  }

  async function runReports() {
    const { data: profiles } = await supabase.from('brand_profiles').select('*').eq('active', true);
    const isFirstWeek = Number(romeYmd(new Date()).slice(8, 10)) <= 7;
    for (const profile of profiles || []) {
      try {
        const plan = await getPlan(profile.user_id);
        if (plan.report === 'none') continue;
        if (plan.report === 'monthly' && !isFirstWeek) continue;
        await reportForUser(profile, plan);
      } catch (e) { console.error('Report error', profile.user_id, e.message); }
    }
  }

  // ===================================================================
  // API PER LA DASHBOARD
  // ===================================================================
  const PROFILE_FIELDS = ['brand', 'sector', 'description', 'target', 'tone', 'visual_style', 'city', 'goal', 'faq', 'socials', 'posting_days', 'posting_times', 'autopilot', 'auto_reply', 'active'];

  app.get('/api/agent/plans', (req, res) => res.json({ plans: PLANS }));

  app.get('/api/agent/state', requireUser, async (req, res) => {
    try {
      const uid = req.user.id;
      const [profileR, usage, postsR, repliesR, reportR, activityR, conns] = await Promise.all([
        supabase.from('brand_profiles').select('*').eq('user_id', uid).maybeSingle(),
        getUsage(uid),
        supabase.from('agent_posts').select('*').eq('user_id', uid)
          .gte('scheduled_at', new Date(Date.now() - 30 * 86400000).toISOString())
          .order('scheduled_at', { ascending: true }).limit(150),
        supabase.from('agent_replies').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(40),
        supabase.from('agent_reports').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('agent_activity').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(25),
        getConnections(uid)
      ]);
      res.json({
        plan: req.plan,
        usage,
        profile: profileR.data || null,
        posts: postsR.data || [],
        replies: repliesR.data || [],
        report: reportR.data || null,
        activity: activityR.data || [],
        connections: { instagram: !!conns.ig, facebook: !!conns.fbPage }
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/profile', requireUser, requireAgentPlan, async (req, res) => {
    try {
      const uid = req.user.id;
      const body = req.body || {};
      const row = { user_id: uid, updated_at: new Date().toISOString() };
      for (const f of PROFILE_FIELDS) if (body[f] !== undefined) row[f] = body[f];
      if (!req.plan.autopilot) row.autopilot = false;
      if (!req.plan.autoReply) row.auto_reply = false;
      if (row.socials) row.socials = row.socials.filter(s => ['instagram', 'facebook'].includes(s));
      if (row.posting_days) row.posting_days = row.posting_days.map(Number).filter(n => n >= 0 && n <= 6);
      if (row.posting_times) row.posting_times = row.posting_times.filter(t => /^\d{2}:\d{2}$/.test(t)).slice(0, 3);
      if (!row.brand && !body.keepBrand) {
        const { data: ex } = await supabase.from('brand_profiles').select('brand').eq('user_id', uid).maybeSingle();
        if (!ex || !ex.brand) return res.status(400).json({ error: 'Inserisci il nome del brand' });
      }
      const { data: before } = await supabase.from('brand_profiles').select('user_id').eq('user_id', uid).maybeSingle();
      const { data, error } = await supabase.from('brand_profiles').upsert(row).select('*').single();
      if (error) throw error;

      // primo salvataggio: l'agente parte subito
      if (!before && data.active) {
        planForUser(data, req.plan).catch(async e => { await log(uid, 'error', 'Errore nella prima pianificazione: ' + e.message); });
      }
      res.json({ success: true, profile: data, started: !before });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/plan-now', requireUser, requireAgentPlan, async (req, res) => {
    try {
      const uid = req.user.id;
      const { data: profile } = await supabase.from('brand_profiles').select('*').eq('user_id', uid).maybeSingle();
      if (!profile) return res.status(400).json({ error: 'Compila prima il profilo del brand' });
      if (!profile.active) return res.status(400).json({ error: 'L\'agente è in pausa: riattivalo prima' });
      if (profile.last_manual_plan && Date.now() - new Date(profile.last_manual_plan).getTime() < 15 * 60000) {
        return res.status(429).json({ error: 'Hai appena pianificato: riprova tra qualche minuto' });
      }
      await supabase.from('brand_profiles').update({ last_manual_plan: new Date().toISOString() }).eq('user_id', uid);
      const created = await planForUser(profile, req.plan);
      res.json({ success: true, created, message: created ? `${created} nuovi post pianificati` : 'La settimana è già completa (o hai raggiunto il limite del mese)' });
    } catch (e) {
      await log(req.user.id, 'error', 'Errore nella pianificazione: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  async function ownPost(req, res) {
    const { data } = await supabase.from('agent_posts').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!data) { res.status(404).json({ error: 'Post non trovato' }); return null; }
    return data;
  }

  function editableFields(body) {
    const upd = {};
    if (typeof body.caption === 'string' && body.caption.trim()) upd.caption = body.caption.trim().slice(0, 2200);
    if (Array.isArray(body.hashtags)) upd.hashtags = body.hashtags.map(h => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);
    if (body.scheduled_at) {
      const d = new Date(body.scheduled_at);
      if (!isNaN(d)) upd.scheduled_at = d.toISOString();
    }
    return upd;
  }

  app.post('/api/agent/posts/:id/approve', requireUser, requireAgentPlan, async (req, res) => {
    try {
      const post = await ownPost(req, res); if (!post) return;
      if (!['pending_approval', 'expired', 'failed'].includes(post.status)) return res.status(400).json({ error: 'Questo post non è da approvare' });
      const upd = Object.assign(editableFields(req.body || {}), { status: 'scheduled', error: null });
      const when = new Date(upd.scheduled_at || post.scheduled_at);
      if (when.getTime() < Date.now()) upd.scheduled_at = new Date(Date.now() + 10 * 60000).toISOString();
      if (post.media_status === 'failed') { upd.media_status = 'pending'; upd.media_attempts = 0; }
      await supabase.from('agent_posts').update(upd).eq('id', post.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/posts/:id/reject', requireUser, async (req, res) => {
    try {
      const post = await ownPost(req, res); if (!post) return;
      if (['published', 'publishing'].includes(post.status)) return res.status(400).json({ error: 'Il post è già stato pubblicato' });
      await supabase.from('agent_posts').update({ status: 'rejected' }).eq('id', post.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/posts/:id/update', requireUser, requireAgentPlan, async (req, res) => {
    try {
      const post = await ownPost(req, res); if (!post) return;
      if (['published', 'publishing'].includes(post.status)) return res.status(400).json({ error: 'Il post è già stato pubblicato' });
      const upd = editableFields(req.body || {});
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Niente da aggiornare' });
      await supabase.from('agent_posts').update(upd).eq('id', post.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/posts/:id/regenerate-image', requireUser, requireAgentPlan, async (req, res) => {
    try {
      const post = await ownPost(req, res); if (!post) return;
      if (['published', 'publishing'].includes(post.status)) return res.status(400).json({ error: 'Il post è già stato pubblicato' });
      if (post.video_task_id) return res.status(400).json({ error: 'Il video è già stato creato da questa immagine' });
      const upd = { image_url: null, carousel_images: null, media_status: 'pending', media_attempts: 0, error: null };
      if (typeof req.body.image_prompt === 'string' && req.body.image_prompt.trim()) upd.image_prompt = req.body.image_prompt.trim().slice(0, 800);
      await supabase.from('agent_posts').update(upd).eq('id', post.id);
      processMedia().catch(() => {});
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/replies/:id/resolve', requireUser, async (req, res) => {
    try {
      await supabase.from('agent_replies').update({ status: 'resolved' }).eq('id', req.params.id).eq('user_id', req.user.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent/report-now', requireUser, requireAgentPlan, async (req, res) => {
    try {
      const uid = req.user.id;
      const { data: profile } = await supabase.from('brand_profiles').select('*').eq('user_id', uid).maybeSingle();
      if (!profile) return res.status(400).json({ error: 'Compila prima il profilo del brand' });
      if (profile.last_manual_report && Date.now() - new Date(profile.last_manual_report).getTime() < 6 * 3600000) {
        return res.status(429).json({ error: 'Puoi generare un report ogni 6 ore' });
      }
      await supabase.from('brand_profiles').update({ last_manual_report: new Date().toISOString() }).eq('user_id', uid);
      const data = await reportForUser(profile, req.plan);
      res.json({ success: true, report: data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===================================================================
  // PIANIFICAZIONE AUTOMATICA (orari di Roma)
  // ===================================================================
  if (process.env.AGENT_CRON !== 'off') {
    cron.schedule('0 6 * * *', () => runPlanner().catch(e => console.error('planner', e.message)), { timezone: TZ });
    cron.schedule('*/5 * * * *', async () => {
      await processMedia().catch(e => console.error('media', e.message));
      await publishDue().catch(e => console.error('publish', e.message));
    }, { timezone: TZ });
    cron.schedule('*/30 * * * *', () => runReplies().catch(e => console.error('replies', e.message)), { timezone: TZ });
    cron.schedule('15 8 * * 1', () => runReports().catch(e => console.error('reports', e.message)), { timezone: TZ });
  }

  console.log(`🤖 Agente AI attivo (modello: ${AGENT_MODEL})`);

  return { PLANS, runPlanner, processMedia, publishDue, runReplies, runReports, planForUser, romeToUtc, getConnections, publishInstagram, publishFacebook, uploadVideoFromUrl };
};

module.exports.PLANS = PLANS;
