require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { addTextOverlay } = require('./overlay');
const Stripe = require('stripe');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');
const { fal } = require('@fal-ai/client');

fal.config({ credentials: process.env.FAL_KEY });

const SEEDANCE_MODEL = 'bytedance/seedance-2.0/fast/image-to-video';
// tiene traccia di quale modello e' stato usato per ogni richiesta (serve per interrogare lo stato dopo)
const videoJobs = new Map();
const videoSaved = new Map(); // taskId -> link permanente del video

// ===== SCRITTE IN ITALIANO CORRETTO SULLE IMMAGINI =====
// colore d'accento preso dallo stile del brand (es. "marrone e oro" -> oro)
function accentFromStyle(style) {
  const t = String(style || '').toLowerCase();
  const map = [['oro', '#d4af37'], ['gold', '#d4af37'], ['rosso', '#e5484d'], ['bordeaux', '#9b2335'], ['rosa', '#f0a6ca'], ['viola', '#8e6cef'], ['lilla', '#c3a6f0'],
    ['blu', '#4c8dff'], ['azzurro', '#7cc4ff'], ['verde', '#46c37b'], ['arancio', '#ff9a3c'], ['giallo', '#f5d142'], ['beige', '#e8d5b5'], ['marrone', '#c8a27a'], ['argento', '#c0c4cc']];
  for (const [k, v] of map) if (t.includes(k)) return v;
  return '#ffffff';
}
async function overlayAndUpload(imageUrl, title, subtitle, accent) {
  if (!imageUrl || !title || !String(title).trim()) return imageUrl;
  const f = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const out = await addTextOverlay(Buffer.from(f.data), String(title).trim().slice(0, 90), subtitle ? String(subtitle).trim().slice(0, 140) : '', { accent });
  const fileName = `posts/${crypto.randomUUID()}.png`;
  const { error } = await supabase.storage.from('post-images').upload(fileName, out, { contentType: 'image/png', upsert: false });
  if (error) throw new Error('Salvataggio immagine con scritta: ' + error.message);
  return supabase.storage.from('post-images').getPublicUrl(fileName).data.publicUrl;
}

// ===== VIDEO PUBBLICITARI (Seedance via fal.ai) =====
function adVideoPrompt(motion, brand, sector, style) {
  return (`${motion || ''} ` +
    `This is a short commercial advertising video for "${brand || 'the brand'}"${sector ? ' (' + sector + ')' : ''}: ` +
    `premium ad look, the product or service is the hero and clearly visible, dynamic but smooth camera movement (slow push-in, orbit or tracking shot), ` +
    `realistic people and details, natural cinematic lighting, shallow depth of field, vertical 9:16 social media reel. ` +
    `Subtle, slow and realistic motion: keep faces, hands and products stable and correctly shaped, no morphing, no distortion, no sudden cuts. ` +
    `Absolutely no text of any kind: no words, letters, captions, subtitles, logos, signs or writing anywhere in the frame. Nobody speaks to the camera.` +
    (style && style.trim() ? ` Visual style and colors: ${style.trim()}.` : '')).substring(0, 2000);
}
function falErrorMessage(e) {
  const st = e && (e.status || (e.response && e.response.status));
  const body = e && (e.body || (e.response && e.response.data)) || {};
  const detail = typeof body.detail === 'string' ? body.detail : (Array.isArray(body.detail) && body.detail[0] && body.detail[0].msg) || body.message || (e && e.message) || 'errore sconosciuto';
  if (!process.env.FAL_KEY) return 'Chiave FAL_KEY mancante su Railway: video non creati';
  if (st === 401 || st === 403) return /balance|credit|locked|billing/i.test(detail) ? 'Credito fal.ai esaurito: ricaricalo su fal.ai → Billing' : 'Chiave FAL_KEY non valida (controllala su Railway)';
  if (st === 402 || /balance|credit|billing/i.test(detail)) return 'Credito fal.ai esaurito: ricaricalo su fal.ai → Billing';
  return 'Video: ' + detail;
}
async function startAdVideo(imageUrl, motion, brand, sector, style) {
  const { request_id } = await fal.queue.submit(SEEDANCE_MODEL, {
    // niente audio generato: la voce AI non parla bene l'italiano. La musica si aggiunge su Instagram.
    input: { prompt: adVideoPrompt(motion, brand, sector, style), image_url: imageUrl, resolution: '720p', duration: '5', aspect_ratio: '9:16', generate_audio: false }
  });
  videoJobs.set(request_id, SEEDANCE_MODEL);
  return request_id;
}

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'placeholder');

app.use(cors({ origin: [siteUrl(), siteUrl().replace('://www.', '://'), 'http://localhost:3000'], credentials: true }));
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '30mb' })); // spazio per le foto caricate dal cliente

// URL pubblico del sito, sempre con https:// e senza slash finale (anche se su Railway manca il protocollo)
function siteUrl() {
  let u = (process.env.FRONTEND_URL || 'https://www.inpostsocial.com').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// un solo indirizzo per il sito (es. sempre con www): il login di Supabase vale per un dominio alla volta,
// quindi se l'utente entra da inpostsocial.com e torna da Meta su www.inpostsocial.com risulterebbe scollegato
app.use((req, res, next) => {
  try {
    const canonical = new URL(siteUrl()).host;
    const host = (req.headers.host || '').toLowerCase();
    const sameSite = host.replace(/^www\./, '') === canonical.replace(/^www\./, '');
    if (req.method === 'GET' && sameSite && host !== canonical && !req.path.startsWith('/webhook')) {
      return res.redirect(301, 'https://' + canonical + req.originalUrl);
    }
  } catch (e) { /* FRONTEND_URL non valido: nessun redirect */ }
  next();
});

// ===== ACCOUNT TITOLARE: nessun limite, piano Business =====
// altri indirizzi si aggiungono su Railway in OWNER_EMAIL, separati da virgola
const OWNER_EMAILS = ['info@inpostsocial.com', 'ilaria.visciglia9@gmail.com']
  .concat((process.env.OWNER_EMAIL || '').split(','))
  .map(e => e.trim().toLowerCase()).filter(Boolean);
function isOwnerEmail(email) { return !!email && OWNER_EMAILS.includes(String(email).trim().toLowerCase()); }

// ===== PROVA GRATUITA: 2 post a settimana =====
const FREE_WEEKLY_POSTS = 2;
function freeWeekKey() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `free-${y}-W${w}`;
}

// ===== LOGIN OBBLIGATORIO SULLE API DELLA DASHBOARD =====
// L'utente viene preso dal token di sessione, non dall'userId inviato dal browser.
const PROTECTED_API = ['/api/generate', '/api/generate-image', '/api/generate-carousel', '/api/generate-video',
  '/api/user/profile', '/api/user/save', '/api/posts/save', '/api/posts/delete', '/api/publish', '/api/social/status', '/api/social/disconnect', '/api/posts/state', '/api/media/upload', '/api/posts/update', '/api/image/overlay'];
app.use(async (req, res, next) => {
  const userById = req.method === 'GET' && /^\/api\/user\/[0-9a-f-]{36}$/i.test(req.path);
  if (!PROTECTED_API.includes(req.path) && !userById) return next();
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { data, error } = token ? await supabase.auth.getUser(token) : { data: null, error: true };
    if (error || !data || !data.user) return res.status(401).json({ error: 'Accesso richiesto' });
    const uid = data.user.id;
    req.authEmail = data.user.email || '';
    if (userById && req.path.split('/').pop() !== uid) return res.status(403).json({ error: 'Non autorizzato' });
    req.query.userId = uid;
    if (req.body && typeof req.body === 'object') req.body.userId = uid;
    next();
  } catch (e) { res.status(401).json({ error: 'Accesso richiesto' }); }
});
// il codice del server e i file di configurazione non devono essere scaricabili dal sito
app.use((req, res, next) => {
  if (/^\/(server\.js|agent\.js|package(-lock)?\.json|schema.*\.sql|env\.example|download|.*\.md)$/i.test(req.path) || req.path.startsWith('/node_modules')) {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhook')) return next();
  const html = req.path.includes('dashboard') ? 'dashboard.html'
             : req.path.includes('login') ? 'login.html'
             : 'index.html';
  res.sendFile(path.join(__dirname, html));
});

app.get('/healthz', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

// ===== CONFIG PUBBLICA PER IL BROWSER (solo la chiave anon, mai la service) =====
function publicAnonKey() {
  const k = process.env.SUPABASE_ANON_KEY || '';
  if (!k || k.startsWith('sb_secret_')) return '';
  try {
    const payload = JSON.parse(Buffer.from(k.split('.')[1] || '', 'base64').toString() || '{}');
    if (payload.role === 'service_role') return '';
  } catch (e) { /* chiave nel nuovo formato sb_publishable_ */ }
  return k;
}
app.get('/api/config.js', (req, res) => {
  const key = publicAnonKey();
  if (!key) console.error('⚠️ SUPABASE_ANON_KEY mancante o non valida (deve essere la chiave anon/publishable, non la service_role)');
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send(`window.INPOST_CONFIG=${JSON.stringify({ supabaseAnonKey: key })};` +
    (key ? '' : `console.error('InPostSocial: manca SUPABASE_ANON_KEY su Railway');`));
});

// ===== GENERATE =====
app.post('/api/generate', async (req, res) => {
  try {
    const { brand, description, sector, city, usp, goal, socials, frequency, tone, style, userId, generateImages, generateVideo, refImages, useRealPhotos, textOverlay } = req.body;
    const wantText = textOverlay === true || textOverlay === 'true';
    // foto del cliente: solo link del nostro storage
    const photos = (Array.isArray(refImages) ? refImages : []).filter(u => typeof u === 'string' && u.includes('/storage/v1/object/public/post-images/uploads/')).slice(0, 8);
    const realPhotos = (useRealPhotos === true || useRealPhotos === 'true') && photos.length > 0;
    const wantVideo = generateVideo === true || generateVideo === 'true';
    if (!brand || !description) return res.status(400).json({ error: 'Brand e descrizione obbligatori' });

    // piano gratuito: massimo FREE_WEEKLY_POSTS post a settimana, senza video
    let freeLeft = null, freeUsed = 0;
    const freeKey = freeWeekKey();
    if (userId) {
      const { data: user } = await supabase.from('users').select('plan,email').eq('id', userId).single();
      const isOwner = isOwnerEmail(req.authEmail) || (user && isOwnerEmail(user.email));
      if (!isOwner && (!user || !user.plan || user.plan === 'free')) {
        const { data: usage } = await supabase.from('agent_usage').select('posts').eq('user_id', userId).eq('month', freeKey).maybeSingle();
        freeUsed = (usage && usage.posts) || 0;
        freeLeft = FREE_WEEKLY_POSTS - freeUsed;
        if (freeLeft <= 0) {
          return res.status(403).json({ error: `Hai già usato i ${FREE_WEEKLY_POSTS} post gratuiti di questa settimana. Si ricaricano lunedì, oppure scegli un piano per generarne di più.`, upgrade: true });
        }
      }
    }

    // social scelti dall'utente: ogni post verrà pubblicato su tutti questi
    const rawSocial = Array.isArray(socials) ? socials.join(' + ') : String(socials || 'Instagram');
    let platforms = /tutti/i.test(rawSocial) ? ['Instagram', 'Facebook', 'TikTok']
      : ['Instagram', 'Facebook', 'TikTok', 'LinkedIn'].filter(n => new RegExp(n, 'i').test(rawSocial));
    if (!platforms.length) platforms = ['Instagram'];
    const socialsList = platforms.join(' + ');

    const styleInstruction = style && style.trim()
      ? `\nSTILE RICHIESTO DALL'UTENTE (seguilo con precisione, ha priorità sul tono generico sopra): ${style.trim()}\n`
      : '';

    const prompt = `Sei un social media manager italiano. Crea strategia e 5 post per questo brand.
BRAND: ${brand}
SETTORE: ${sector || 'generale'}
DESCRIZIONE: ${description}
SOCIAL: ogni post verrà pubblicato su ${socialsList}: scrivi testi che funzionino su ${platforms.length > 1 ? 'tutti questi social' : 'questo social'}.
TONO: ${tone || 'professionale'}
LINGUA: scrivi in italiano corretto e naturale, come un copywriter madrelingua: niente traduzioni letterali dall'inglese, niente errori di grammatica, accenti e apostrofi giusti (è, perché, po', un'idea).
${styleInstruction}${style && style.trim() ? `IMMAGINI: ogni "image_prompt" (anche quelli di ogni slide del carosello e della scena del reel) deve descrivere esplicitamente i colori, la palette e lo stile visivo richiesti dall'utente qui sopra.\n` : ''}
REEL: ogni post di tipo "reel" deve parlare di un argomento concreto e specifico di questo settore e di questa attività (un servizio, un prodotto, un lavoro tipico, un dietro le quinte, un consiglio pratico), mai generico. Il suo "image_prompt" descrive la scena di apertura verticale (9:16) con il soggetto del settore ben riconoscibile; il suo "video_prompt" va scritto IN INGLESE (50-90 parole) e descrive cosa succede nei 5 secondi: un'azione semplice e realistica del soggetto (movimenti lenti, niente mani in primo piano che fanno gesti complessi), movimento della camera, luce, atmosfera, coerente con l'immagine di apertura. Nel video non deve comparire nessuna scritta e nessuno deve parlare.${wantVideo ? ' Includi almeno 2 post di tipo "reel".' : ''}
${wantText ? `SCRITTE SULLE IMMAGINI: per ogni post aggiungi "overlay_title" (titolo d'impatto, massimo 6 parole, italiano perfetto, senza emoji e senza hashtag) e "overlay_subtitle" (frase breve di supporto, massimo 10 parole). Per ogni slide del carosello scrivi in "title" il titolo che apparirà su quella slide (massimo 6 parole) e in "subtitle" una riga di supporto (massimo 10 parole). Queste scritte verranno sovrapposte all'immagine in modo tipografico, quindi l'immagine stessa NON deve contenere testo.\n` : ''}IMMAGINI REALISTICHE: ogni "image_prompt" deve essere ricco e dettagliato (almeno 60 parole) e descrivere come una vera fotografia: soggetto, ambientazione, persone o prodotti, luce, inquadratura, profondità di campo, palette di colori, atmosfera. Il soggetto deve stare interamente nell'inquadratura. Niente testo, scritte, insegne o loghi nell'immagine: i messaggi vanno solo nel testo del post.
${photos.length ? `FOTO REALI DEL BRAND: ti allego ${Math.min(photos.length, 4)} foto reali del brand. Studiale con attenzione (prodotti, ambienti, persone, colori, stile) e fai in modo che testi e image_prompt siano coerenti con ciò che vedi.\n` : ''}Rispondi SOLO con JSON valido, niente testo fuori dal JSON:
{"strategy":{"summary":"sintesi strategia in 2 frasi","target":"descrizione pubblico target","content_pillars":["pillar1","pillar2","pillar3"],"best_times":"orari migliori per pubblicare","tips":["consiglio1","consiglio2"]},"posts":[{"social":"${platforms[0]}","type":"image","day":"Lunedi","scheduled_time":"11:00","text":"testo completo del post con emoji e call to action","hashtags":["hashtag1","hashtag2","hashtag3","hashtag4","hashtag5"],"image_prompt":"descrizione dettagliata immagine professionale"},{"social":"${platforms[0]}","type":"reel","day":"Mercoledi","scheduled_time":"19:00","text":"testo coinvolgente per il reel su un tema specifico del settore","hashtags":["hashtag1","hashtag2","hashtag3","hashtag4","hashtag5"],"image_prompt":"scena di apertura del video","video_prompt":"english description of the 5-second action and camera movement, specific to this business"},{"social":"${platforms[0]}","type":"image","day":"Venerdi","scheduled_time":"12:00","text":"testo dettagliato e coinvolgente","hashtags":["hashtag1","hashtag2","hashtag3"],"image_prompt":"immagine professionale"},{"social":"${platforms[0]}","type":"carousel","day":"Sabato","scheduled_time":"10:00","text":"testo del carosello","hashtags":["hashtag1","hashtag2","hashtag3"],"carousel_slides":[{"title":"Slide 1","image_prompt":"descrizione prima slide"},{"title":"Slide 2","image_prompt":"descrizione seconda slide"},{"title":"Slide 3","image_prompt":"descrizione terza slide"}]},{"social":"${platforms[0]}","type":"image","day":"Martedi","scheduled_time":"20:00","text":"testo del quinto post","hashtags":["hashtag1","hashtag2","hashtag3"],"image_prompt":"descrizione immagine"}]}`;

    // le foto del cliente vengono mostrate anche all'AI che scrive post e descrizioni delle immagini
    let content = prompt;
    if (photos.length) {
      const blocks = [];
      for (const u of photos.slice(0, 4)) {
        try {
          const f = await axios.get(u, { responseType: 'arraybuffer', timeout: 20000 });
          const mt = (f.headers['content-type'] || 'image/jpeg').split(';')[0];
          if (['image/jpeg', 'image/png', 'image/webp'].includes(mt)) blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: Buffer.from(f.data).toString('base64') } });
        } catch (e) { console.log('Foto di riferimento non leggibile:', e.message); }
      }
      if (blocks.length) content = blocks.concat([{ type: 'text', text: prompt }]);
    }
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      messages: [{ role: 'user', content }]
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

    if (Array.isArray(data.posts)) data.posts.forEach(p => { p.socials = platforms.slice(); p.social = platforms[0]; });

    if (freeLeft !== null && Array.isArray(data.posts)) {
      // nella prova gratuita teniamo prima i post con immagine singola (niente reel)
      const order = { image: 0, carousel: 1, reel: 2 };
      data.posts = data.posts.slice().sort((a, b) => (order[a.type] ?? 1) - (order[b.type] ?? 1)).slice(0, freeLeft);
    }

    // "usa le mie foto": i post usano direttamente le foto reali caricate
    if (realPhotos && Array.isArray(data.posts)) {
      let k = 0;
      const next = () => photos[(k++) % photos.length];
      data.posts.forEach(p => {
        if (p.type === 'carousel') {
          const n = Math.min(Math.max(photos.length, 2), 5);
          p.carousel_images = Array.from({ length: n }, next);
          p.image_url = p.carousel_images[0];
        } else {
          p.image_url = next();
        }
        p.real_photo = true;
      });
    }

    const doImages = (generateImages === true || generateImages === 'true') && !realPhotos;
    const doVideo = freeLeft === null && (generateVideo === true || generateVideo === 'true');
    console.log('🖼️ generateImages:', generateImages, '→ doImages:', doImages, '| KEY:', !!process.env.OPENAI_API_KEY);
    // il video parte da un'immagine: per i reel la creiamo anche se "Immagini AI" non è spuntato
    const mediaErrors = [];
    if ((doImages || doVideo) && !process.env.OPENAI_API_KEY) mediaErrors.push('Chiave OpenAI (OPENAI_API_KEY) mancante su Railway: immagini non create');
    if ((doImages || doVideo) && process.env.OPENAI_API_KEY) {
      const styled = (p) => style && style.trim() ? `${p}. Stile e colori: ${style.trim()}` : p;
      const jobs = data.posts.map((post, i) => async () => {
        if (!doImages && (post.type !== 'reel' || post.image_url)) return;
        try {
          if (post.type === 'carousel' && post.carousel_slides) {
            const imgs = [];
            for (const sl of post.carousel_slides.slice(0, 3)) imgs.push(await generateImage(styled(sl.image_prompt || post.text), brand, { refs: photos }));
            data.posts[i].carousel_images = imgs.filter(Boolean);
            data.posts[i].image_url = data.posts[i].carousel_images[0] || null;
          } else if (post.image_prompt || post.text) {
            data.posts[i].image_url = await generateImage(styled(post.image_prompt || post.text), brand, { refs: photos, size: post.type === 'reel' ? '1024x1536' : '1024x1024' });
          }
        } catch (e) {
          const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
          console.error('Image error post', i, ':', msg);
          mediaErrors.push(msg);
        }
      });
      // 2 post alla volta: più veloce, senza superare i limiti al minuto di OpenAI
      for (let k = 0; k < jobs.length; k += 2) await Promise.all(jobs.slice(k, k + 2).map(j => j()));
    }

    // scritte tipografiche sulle immagini (non sui reel: il video deformerebbe le lettere)
    if (wantText && Array.isArray(data.posts)) {
      const accent = accentFromStyle(style);
      for (const post of data.posts) {
        if (post.type === 'reel') continue;
        try {
          if (post.type === 'carousel' && Array.isArray(post.carousel_images) && post.carousel_images.length) {
            post.carousel_raw_images = post.carousel_images.slice();
            const slides = post.carousel_slides || [];
            const out = [];
            for (let k = 0; k < post.carousel_images.length; k++) {
              const sl = slides[k] || {};
              const t = sl.title && !/^slide\s*\d+$/i.test(sl.title) ? sl.title : (k === 0 ? post.overlay_title : '');
              out.push(t ? await overlayAndUpload(post.carousel_images[k], t, sl.subtitle || (k === 0 ? post.overlay_subtitle : ''), accent) : post.carousel_images[k]);
            }
            post.carousel_images = out;
            post.image_url = out[0];
          } else if (post.image_url && post.overlay_title) {
            post.image_raw_url = post.image_url;
            post.image_url = await overlayAndUpload(post.image_url, post.overlay_title, post.overlay_subtitle, accent);
          }
        } catch (e) { console.error('Scritta su immagine non riuscita:', e.message); mediaErrors.push('Scritta sull\'immagine non applicata: ' + e.message); }
      }
    }

    if (doVideo) {
      for (let i = 0; i < data.posts.length; i++) {
        const post = data.posts[i];
        if (post.type !== 'reel') continue;
        if (!post.image_url) { mediaErrors.push('Video non creato: manca l\'immagine di partenza del reel (usa "Crea immagine", poi partirà il video)'); continue; }
        try {
          data.posts[i].video_task_id = await startAdVideo(post.image_url, post.video_prompt || post.text, brand, sector, style);
          data.posts[i].video_status = 'processing';
          console.log('🎬 Video Seedance avviato:', data.posts[i].video_task_id);
        } catch (e) {
          const msg = falErrorMessage(e);
          console.error('Video error post', i, ':', msg);
          mediaErrors.push(msg);
        }
      }
    }

    let strategyId = null;
    if (userId) {
      const { data: saved } = await supabase.from('strategies').insert({
        user_id: userId, brand, sector,
        strategy: data.strategy, posts: data.posts,
        created_at: new Date().toISOString()
      }).select('id').single();
      strategyId = saved && saved.id;
    }

    let free = null;
    if (freeLeft !== null) {
      const usedNow = freeUsed + data.posts.length;
      await supabase.from('agent_usage').upsert({ user_id: userId, month: freeKey, posts: usedNow }, { onConflict: 'user_id,month' });
      free = { limit: FREE_WEEKLY_POSTS, left: Math.max(0, FREE_WEEKLY_POSTS - usedNow) };
    }

    res.json({ success: true, data, free, strategy_id: strategyId, media_errors: [...new Set(mediaErrors)].slice(0, 3) });

  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: 'Errore generazione', details: error.message });
  }
});

// ===== DALL-E 3 =====
// opts.size: '1024x1024' (feed/carosello) o '1024x1536' (reel verticale)
// opts.refs: link di foto reali del cliente da usare come riferimento visivo
async function generateImage(prompt, brand, opts) {
  opts = opts || {};
  const size = opts.size || '1024x1024';
  const refs = (opts.refs || []).filter(Boolean).slice(0, 4);
  const safePrompt = (`Fotografia realistica per i social di "${brand}". ${prompt}. ` +
    `Stile: foto vera scattata con fotocamera professionale, luce naturale, dettagli e texture reali, composizione curata, ` +
    `soggetto principale ben visibile e centrato con margine sui bordi (niente tagliato), nessuna illustrazione o resa da cartone animato, ` +
    `ASSOLUTAMENTE nessun testo nell'immagine: niente parole, lettere, scritte, insegne, etichette leggibili, numeri o loghi inventati (l'AI le scrive sbagliate).` +
    (refs.length ? ' Usa le foto di riferimento allegate: mantieni prodotti, ambienti, colori e stile reali del brand.' : '')).substring(0, 3800);
  console.log('🎨 Prompt immagine:', safePrompt.length, 'caratteri', refs.length ? `+ ${refs.length} foto di riferimento` : '');
  try {
    let r;
    if (refs.length) {
      // modifica guidata da foto reali (gpt-image-1 accetta più immagini di riferimento)
      const form = new FormData();
      form.append('model', 'gpt-image-1');
      form.append('prompt', safePrompt);
      form.append('size', size);
      form.append('quality', 'medium');
      for (let i = 0; i < refs.length; i++) {
        const f = await axios.get(refs[i], { responseType: 'arraybuffer', timeout: 30000 });
        const type = f.headers['content-type'] || 'image/jpeg';
        const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
        form.append('image[]', new Blob([f.data], { type }), `ref${i}.${ext}`);
      }
      const resp = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }, body: form
      });
      const json = await resp.json();
      if (!resp.ok) {
        // se la modifica con le foto di riferimento non riesce, generiamo comunque l'immagine senza
        console.log('⚠️ Immagine con foto di riferimento non riuscita, riprovo senza:', json.error && json.error.message);
        return generateImage(prompt, brand, { size });
      }
      r = { data: json };
    } else {
      // OpenAI risponde 429 sia per "troppe richieste" (si riprova dopo una pausa) sia per credito esaurito (inutile riprovare)
      for (let attempt = 1; ; attempt++) {
        try {
          r = await axios.post(
            'https://api.openai.com/v1/images/generations',
            { model: 'gpt-image-1', prompt: safePrompt, n: 1, size, quality: 'medium' },
            { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000 }
          );
          break;
        } catch (err) {
          const st = err.response && err.response.status;
          const oe = (err.response && err.response.data && err.response.data.error) || {};
          if (st === 429 && (oe.code === 'insufficient_quota' || /quota|billing/i.test(oe.message || ''))) {
            throw new Error('Credito OpenAI esaurito: ricarica il saldo su platform.openai.com → Billing');
          }
          if (st === 429 && attempt < 5) {
            const wait = (parseInt(err.response.headers['retry-after'], 10) || attempt * 15) * 1000;
            console.log(`⏳ OpenAI 429 (troppe richieste), riprovo tra ${wait / 1000}s (tentativo ${attempt})`);
            await new Promise(res => setTimeout(res, wait));
            continue;
          }
          if (st === 429) throw new Error('OpenAI: limite di immagini al minuto raggiunto. Riprova tra qualche minuto.');
          if (oe.message) throw new Error('OpenAI: ' + oe.message);
          throw err;
        }
      }
    }
    const img = r.data.data[0];

    // Otteniamo i byte dell'immagine, sia che OpenAI dia un base64 sia un url temporaneo
    let imageBuffer;
    if (img.b64_json) {
      imageBuffer = Buffer.from(img.b64_json, 'base64');
    } else if (img.url) {
      const imgResp = await axios.get(img.url, { responseType: 'arraybuffer' });
      imageBuffer = Buffer.from(imgResp.data);
    } else {
      return null;
    }

    // Carichiamo su Supabase Storage per avere un link pubblico permanente
    // (i link temporanei di OpenAI scadono dopo circa un'ora: troppo poco per
    // i post schedulati, e Instagram/Seedance richiedono comunque un vero URL pubblico)
    const fileName = `posts/${crypto.randomUUID()}.png`;
    const { error: uploadError } = await supabase.storage
      .from('post-images')
      .upload(fileName, imageBuffer, { contentType: 'image/png', upsert: false });

    if (uploadError) {
      console.error('❌ Errore upload Supabase Storage:', uploadError.message);
      throw new Error('Impossibile salvare l\'immagine generata: ' + uploadError.message);
    }

    const { data: publicUrlData } = supabase.storage.from('post-images').getPublicUrl(fileName);
    return publicUrlData.publicUrl;
  } catch(e) {
    console.error('❌ DALL-E error:', e.response?.data || e.message);
    throw e;
  }
}

app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, brand, userId, refImages, size } = req.body;
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI non configurato' });
    const refs = (Array.isArray(refImages) ? refImages : []).filter(u => typeof u === 'string' && u.includes('/storage/v1/object/public/post-images/uploads/')).slice(0, 4);
    const url = await generateImage(prompt, brand || 'Brand', { refs, size: size === '1024x1536' ? '1024x1536' : '1024x1024' });
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

// ===== VIDEO AI CON SEEDANCE (via fal.ai) =====
// nessuna funzione di supporto extra necessaria: fal.ai gestisce tutto

app.post('/api/generate-video', async (req, res) => {
  try {
    const { prompt, imageUrl, userId, brand, sector, style } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl obbligatoria' });
    const request_id = await startAdVideo(imageUrl, prompt, brand, sector, style);
    res.json({ success: true, task_id: request_id, status: 'processing' });
  } catch (e) { res.status(500).json({ error: falErrorMessage(e) }); }
});

app.get('/api/video-status/:taskId', async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const model = videoJobs.get(taskId) || SEEDANCE_MODEL;
    const status = await fal.queue.status(model, { requestId: taskId, logs: false });
    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result(model, { requestId: taskId });
      return res.json({ success: true, status: 'completed', video_url: result.data.video.url });
    }
    res.json({ success: true, status: 'processing', video_url: null });
  } catch (e) { res.status(500).json({ error: 'Errore stato video', details: e.message }); }
});

// ===== META OAUTH =====
app.get('/auth/meta', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.redirect(`${siteUrl()}/dashboard.html?error=no_user`);
  const scope = [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts'
  ].join(',');
  const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
  const redirectUri = encodeURIComponent(siteUrl() + '/auth/callback');
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&response_type=code`;
  console.log('🔗 Meta OAuth start for user:', userId);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const DASH = siteUrl() + '/dashboard.html';
  try {
    const { code, state, error } = req.query;
    if (error || !code) {
      console.error('OAuth denied:', error);
      return res.redirect(DASH + '?error=auth_denied');
    }

    const { userId } = JSON.parse(Buffer.from(state, 'base64').toString());
    if (!userId) return res.redirect(DASH + '?error=no_user');

    const t1 = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: siteUrl() + '/auth/callback',
        code
      }
    });
    const shortToken = t1.data.access_token;

    const t2 = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const longToken = t2.data.access_token;
    console.log('✅ Long-lived token ottenuto per user:', userId);

    const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: longToken, fields: 'id,name,access_token,instagram_business_account' }
    });
    const pages = pagesRes.data.data || [];
    console.log('📄 Pagine trovate:', pages.length);

    await supabase.from('social_connections').delete().eq('user_id', userId).in('platform', ['facebook', 'instagram']);

    const { error: fbSaveErr } = await supabase.from('social_connections').insert({
      user_id: userId,
      platform: 'facebook',
      access_token: longToken,
      pages: pages,
      connected_at: new Date().toISOString()
    });
    if (fbSaveErr) {
      console.error('❌ Salvataggio collegamento Facebook fallito:', fbSaveErr.message);
      return res.redirect(DASH + '?error=save_failed');
    }

    let igConnected = false;
    for (const page of pages) {
      try {
        const igRes = await axios.get(`https://graph.facebook.com/v19.0/${page.id}`, {
          params: { fields: 'instagram_business_account', access_token: page.access_token }
        });
        const igAccount = igRes.data.instagram_business_account;
        if (igAccount && igAccount.id) {
          const { error: igSaveErr } = await supabase.from('social_connections').insert({
            user_id: userId,
            platform: 'instagram',
            ig_account_id: igAccount.id,
            page_id: page.id,
            page_name: page.name,
            page_access_token: page.access_token,
            connected_at: new Date().toISOString()
          });
          if (igSaveErr) throw new Error('salvataggio non riuscito: ' + igSaveErr.message);
          igConnected = true;
          console.log('📸 Instagram collegato:', igAccount.id, 'via pagina:', page.name);
        }
      } catch (igErr) {
        console.log('⚠️ Nessun Instagram per pagina:', page.name, igErr.message);
      }
    }

    const msg = igConnected ? 'connected=instagram' : 'connected=facebook';
    res.redirect(DASH + '?' + msg);
  } catch (e) {
    console.error('❌ OAuth error:', e.response?.data || e.message);
    res.redirect(DASH + '?error=auth_failed');
  }
});

// ===== USER PROFILE =====
app.get('/api/user/profile', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId mancante' });
    const { data, error } = await supabase.from('users').select('plan,brand,sector,name,email').eq('id', userId).single();
    if (error || !data) return res.json({ plan: isOwnerEmail(req.authEmail) ? 'business' : 'free', brand: '', sector: '', name: '', email: req.authEmail || '' });
    if (isOwnerEmail(data.email) || isOwnerEmail(req.authEmail)) data.plan = 'business';
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/save', async (req, res) => {
  try {
    const { userId, name, brand, sector } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId mancante' });
    await supabase.from('users').upsert({ id: userId, name, brand, sector });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== STRIPE =====
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, userId, email } = req.body;
    const prices = { starter: process.env.STRIPE_PRICE_STARTER, pro: process.env.STRIPE_PRICE_PRO, business: process.env.STRIPE_PRICE_BUSINESS };
    if (!prices[plan]) return res.status(400).json({ error: 'Piano non valido o prezzo Stripe non configurato' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: prices[plan], quantity: 1 }],
      success_url: `${siteUrl()}/dashboard.html?payment=success`,
      cancel_url: `${siteUrl()}/index.html#prezzi`,
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
    if (event.type === 'customer.subscription.updated') {
      // cambio piano o pagamento non riuscito
      const sub = event.data.object;
      const priceId = sub.items && sub.items.data[0] && sub.items.data[0].price.id;
      const byPrice = { [process.env.STRIPE_PRICE_STARTER]: 'starter', [process.env.STRIPE_PRICE_PRO]: 'pro', [process.env.STRIPE_PRICE_BUSINESS]: 'business' };
      const newPlan = ['unpaid', 'canceled', 'incomplete_expired'].includes(sub.status) ? 'free' : byPrice[priceId];
      if (newPlan) await supabase.from('users').update({ plan: newPlan }).eq('subscription_id', sub.id);
    }
    if (event.type === 'customer.subscription.deleted') {
      const { data: u } = await supabase.from('users').select('id').eq('subscription_id', event.data.object.id).single();
      if (u) await supabase.from('users').update({ plan: 'free', subscription_id: null }).eq('id', u.id);
    }
    res.json({ received: true });
  } catch (e) { res.status(400).json({ error: 'Webhook error' }); }
});

// ===== SCOLLEGA SOCIAL =====
// Facebook e Instagram si collegano insieme (stesso accesso Meta), quindi si scollegano insieme.
app.post('/api/social/disconnect', async (req, res) => {
  try {
    const { userId, platform } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId mancante' });
    const platforms = platform === 'tiktok' ? ['tiktok'] : ['facebook', 'instagram'];
    if (platforms.includes('facebook')) {
      // revoca anche l'autorizzazione lato Meta, così al prossimo collegamento si può scegliere un altro account
      const { data: fb } = await supabase.from('social_connections').select('access_token').eq('user_id', userId).eq('platform', 'facebook').maybeSingle();
      if (fb && fb.access_token) {
        try { await axios.delete('https://graph.facebook.com/v19.0/me/permissions', { params: { access_token: fb.access_token } }); }
        catch (e) { console.log('Revoca Meta non riuscita (ignoro):', e.message); }
      }
    }
    const { error } = await supabase.from('social_connections').delete().eq('user_id', userId).in('platform', platforms);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DEBUG SOCIAL =====
app.get('/api/social/status', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId mancante' });
    const { data, error } = await supabase.from('social_connections').select('platform,page_name,connected_at').eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    // i token di accesso restano solo sul server
    res.json({ count: data.length, connections: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ===== SALVA POST APPROVATO =====
app.post('/api/posts/save', async (req, res) => {
  try {
    const { userId, post } = req.body;
    if (!userId || !post) return res.status(400).json({ error: 'userId e post obbligatori' });
    const { data, error } = await supabase.from('posts').insert({
      user_id: userId,
      platform: (Array.isArray(post.socials) && post.socials.length ? post.socials : [post.social || 'instagram']).map(x => String(x).toLowerCase()).join(','),
      text: post.text,
      hashtags: post.hashtags,
      image_url: post.image_url || null,
      carousel_images: post.carousel_images || null,
      video_url: post.video_url || null,
      video_task_id: post.video_task_id || null,
      status: 'approved',
      scheduled_at: post.scheduled_at,
      day: post.day || null,
      type: post.type || 'image',
      brand: post.brand || null,
      created_at: new Date().toISOString()
    }).select('id').single();
    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch (e) {
    console.error('Save post error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== FOTO DEL CLIENTE (riferimento per l'AI o da usare direttamente nei post) =====
app.post('/api/media/upload', async (req, res) => {
  try {
    const { userId, files } = req.body;
    if (!userId || !Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Nessuna foto' });
    const urls = [];
    for (const f of files.slice(0, 8)) {
      const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(f.data || '');
      if (!m) continue;
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 8 * 1024 * 1024) continue;
      const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
      const fileName = `uploads/${userId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('post-images').upload(fileName, buf, { contentType: m[1], upsert: false });
      if (error) throw new Error(error.message);
      urls.push(supabase.storage.from('post-images').getPublicUrl(fileName).data.publicUrl);
    }
    if (!urls.length) return res.status(400).json({ error: 'Formato non supportato (usa JPG, PNG o WEBP)' });
    res.json({ success: true, urls });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== RIFAI LA SCRITTA SULL'IMMAGINE (dall'editor del post) =====
app.post('/api/image/overlay', async (req, res) => {
  try {
    const { rawUrl, title, subtitle, style } = req.body;
    if (!rawUrl || !/^https:\/\//.test(rawUrl) || !rawUrl.includes('/storage/v1/object/public/post-images/')) return res.status(400).json({ error: 'Immagine non valida' });
    if (!title || !String(title).trim()) return res.json({ success: true, url: rawUrl });
    const url = await overlayAndUpload(rawUrl, title, subtitle, accentFromStyle(style));
    res.json({ success: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== MODIFICA DI UN POST GIÀ APPROVATO (testo e data di pubblicazione) =====
app.post('/api/posts/update', async (req, res) => {
  try {
    const { userId, postId, text, scheduled_at } = req.body;
    if (!userId || !postId) return res.status(400).json({ error: 'Dati mancanti' });
    const patch = {};
    if (typeof text === 'string' && text.trim()) patch.text = text.slice(0, 2200);
    if (scheduled_at && !isNaN(Date.parse(scheduled_at))) patch.scheduled_at = new Date(scheduled_at).toISOString();
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Niente da modificare' });
    const { error } = await supabase.from('posts').update(patch).eq('id', postId).eq('user_id', userId).in('status', ['approved', 'failed']);
    if (error) throw error;
    if (patch.scheduled_at) await supabase.from('posts').update({ status: 'approved', error: null }).eq('id', postId).eq('user_id', userId).eq('status', 'failed');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== STATO DI UN POST DENTRO LA STRATEGIA (approvato / eliminato) =====
app.post('/api/posts/state', async (req, res) => {
  try {
    const { userId, sid, text, status, video_url, video_task_id, image_url, carousel_images, new_text, scheduled_time, day, overlay_title, overlay_subtitle } = req.body;
    const hasEdit = video_url || video_task_id || image_url || carousel_images || new_text || scheduled_time || day || overlay_title !== undefined;
    if (!userId || !sid || (!['approved', 'deleted', 'draft'].includes(status) && !hasEdit)) return res.status(400).json({ error: 'Dati mancanti' });
    const { data: st, error } = await supabase.from('strategies').select('posts').eq('id', sid).eq('user_id', userId).single();
    if (error || !st) return res.status(404).json({ error: 'Strategia non trovata' });
    const list = Array.isArray(st.posts) ? st.posts : [];
    const key = String(text || '').substring(0, 50);
    const i = list.findIndex(p => p && String(p.text || '').substring(0, 50) === key && p.status !== 'deleted');
    if (i < 0) return res.status(404).json({ error: 'Post non trovato' });
    const patch = {};
    if (status) patch.status = status;
    if (typeof video_url === 'string' && /^https:\/\//.test(video_url)) { patch.video_url = video_url; patch.video_status = 'completed'; }
    if (typeof image_url === 'string' && /^https:\/\//.test(image_url)) patch.image_url = image_url;
    if (typeof req.body.image_raw_url === 'string' && /^https:\/\//.test(req.body.image_raw_url)) patch.image_raw_url = req.body.image_raw_url;
    if (typeof video_task_id === 'string' && video_task_id.length < 200) { patch.video_task_id = video_task_id; patch.video_status = 'processing'; }
    if (Array.isArray(carousel_images)) patch.carousel_images = carousel_images.filter(u => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 10);
    if (typeof new_text === 'string' && new_text.trim()) patch.text = new_text.slice(0, 2200);
    if (typeof scheduled_time === 'string' && /^\d{1,2}:\d{2}$/.test(scheduled_time)) patch.scheduled_time = scheduled_time;
    if (typeof day === 'string' && day.length < 20) patch.day = day;
    if (typeof overlay_title === 'string') patch.overlay_title = overlay_title.slice(0, 90);
    if (typeof overlay_subtitle === 'string') patch.overlay_subtitle = overlay_subtitle.slice(0, 140);
    list[i] = Object.assign({}, list[i], patch);
    const { error: upErr } = await supabase.from('strategies').update({ posts: list }).eq('id', sid).eq('user_id', userId);
    if (upErr) throw upErr;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ELIMINA POST =====
app.post('/api/posts/delete', async (req, res) => {
  try {
    const { postId, userId } = req.body;
    if (!postId || !userId) return res.status(400).json({ error: 'postId e userId obbligatori' });
    const { error } = await supabase.from('posts').delete().eq('id', postId).eq('user_id', userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('Delete post error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== VIDEO STATUS =====
app.get('/api/video/status', async (req, res) => {
  try {
    const { taskId } = req.query;
    if (!taskId) return res.status(400).json({ error: 'taskId mancante' });
    if (videoSaved.has(taskId)) return res.json({ status: 'completed', video_url: videoSaved.get(taskId) });
    const model = videoJobs.get(taskId) || SEEDANCE_MODEL;
    const status = await fal.queue.status(model, { requestId: taskId, logs: false });
    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result(model, { requestId: taskId });
      // il link di fal.ai è temporaneo: copiamo il video nel nostro storage
      let url = result.data.video.url;
      try { if (agentApi) url = await agentApi.uploadVideoFromUrl(url); } catch (e) { console.log('Copia video non riuscita, uso il link temporaneo:', e.message); }
      videoSaved.set(taskId, url);
      return res.json({ status: 'completed', video_url: url });
    }
    if (status.status === 'FAILED' || status.status === 'ERROR') return res.json({ status: 'failed', video_url: null });
    res.json({ status: 'processing', video_url: null });
  } catch (e) {
    // fal.ai segnala un video fallito con un errore sul risultato
    const msg = falErrorMessage(e);
    if (e && (e.status === 422 || e.status === 400 || e.status === 404)) return res.json({ status: 'failed', video_url: null, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ===== PUBBLICAZIONE DEI POST APPROVATI (Instagram e/o Facebook) =====
// usa le stesse funzioni dell'Agente AI (immagine singola, carosello, reel)
let agentApi = null;
async function publishManualPost(post) {
  if (!agentApi) throw new Error('Servizio di pubblicazione non pronto');
  const conns = await agentApi.getConnections(post.user_id);
  const p = Object.assign({}, post, { caption: post.text || '' });
  // reel: se il video era ancora in elaborazione al momento dell'approvazione, lo recuperiamo ora
  if (p.type === 'reel' && !p.video_url && p.video_task_id) {
    try {
      const model = videoJobs.get(p.video_task_id) || SEEDANCE_MODEL;
      const st = await fal.queue.status(model, { requestId: p.video_task_id, logs: false });
      if (st.status === 'COMPLETED') {
        const result = await fal.queue.result(model, { requestId: p.video_task_id });
        p.video_url = await agentApi.uploadVideoFromUrl(result.data.video.url);
        await supabase.from('posts').update({ video_url: p.video_url }).eq('id', post.id);
      }
    } catch (e) { console.log('Video non ancora pronto per post', post.id, e.message); }
  }
  const targets = String(post.platform || 'instagram').split(',').map(x => x.trim()).filter(Boolean);
  const done = [], failed = [];
  let igId = null;
  for (const t of targets) {
    try {
      if (t === 'instagram') {
        if (!conns.ig) throw new Error('Instagram non collegato');
        const r = await agentApi.publishInstagram(conns.ig, p);
        igId = r.id; done.push('Instagram');
      } else if (t === 'facebook') {
        if (!conns.fbPage) throw new Error('Pagina Facebook non collegata');
        await agentApi.publishFacebook(conns.fbPage, p);
        done.push('Facebook');
      } else {
        throw new Error('pubblicazione su ' + t + ' non ancora disponibile');
      }
    } catch (e) {
      const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
      failed.push(t + ': ' + msg);
    }
  }
  return { done, failed, igId };
}

async function finishPublish(post, out) {
  const update = out.done.length
    ? { status: 'published', published_at: new Date().toISOString(), ig_media_id: out.igId, error: out.failed.length ? out.failed.join(' | ') : null }
    : { status: 'failed', error: out.failed.join(' | ') || 'Pubblicazione non riuscita' };
  await supabase.from('posts').update(update).eq('id', post.id);
  return update;
}

app.post('/api/publish', async (req, res) => {
  try {
    const { postId, userId } = req.body;
    const { data: post, error: postErr } = await supabase.from('posts').select('*').eq('id', postId).eq('user_id', userId).single();
    if (postErr || !post) return res.status(404).json({ error: 'Post non trovato' });
    const out = await publishManualPost(post);
    const upd = await finishPublish(post, out);
    if (!out.done.length) return res.status(400).json({ error: upd.error });
    res.json({ success: true, published_on: out.done, errors: out.failed });
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
        const out = await publishManualPost(post);
        const upd = await finishPublish(post, out);
        console.log(upd.status === 'published' ? '✅' : '❌', 'Post', post.id, '→', out.done.join(', ') || upd.error);
      } catch (pubErr) {
        console.error('❌ Publish failed for post', post.id, ':', pubErr.message);
        await supabase.from('posts').update({ status: 'failed', error: pubErr.message }).eq('id', post.id);
      }
    }
  } catch (e) { console.error('Scheduler error:', e); }
});

// ===== AGENTE AI AUTONOMO (vedi agent.js) =====
agentApi = require('./agent')(app, { supabase, anthropic, fal, generateImage, SEEDANCE_MODEL });

// ===== START =====
app.listen(PORT, () => {
  console.log(`🚀 InPostSocial v2.0 on port ${PORT}`);
  console.log(`🤖 Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'}`);
  console.log(`🖼️  DALL-E 3: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
  console.log(`🎬 Video AI (Seedance via fal.ai): ${process.env.FAL_KEY ? '✅' : '❌'}`);
  console.log(`📊 Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`📘 Meta: ${process.env.META_APP_ID ? '✅' : '❌'}`);
});
