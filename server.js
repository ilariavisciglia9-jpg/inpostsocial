require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { addTextOverlay } = require('./overlay');
const sharp = require('sharp');
const talking = require('./talkingreel');
const fsp = require('fs').promises;
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
// ritaglia una foto reale nel formato giusto (feed 4:5, reel 9:16) tenendo al centro la parte importante
const preparedCache = new Map();
async function prepareRealPhoto(url, mode) {
  const key = url + '|' + mode;
  if (preparedCache.has(key)) return preparedCache.get(key);
  const f = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const [W, H] = mode === 'reel' ? [1080, 1920] : [1080, 1350];
  const out = await sharp(Buffer.from(f.data)).rotate().resize(W, H, { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 90 }).toBuffer();
  const fileName = `posts/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from('post-images').upload(fileName, out, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error('Salvataggio foto: ' + error.message);
  const pub = supabase.storage.from('post-images').getPublicUrl(fileName).data.publicUrl;
  preparedCache.set(key, pub);
  if (preparedCache.size > 200) preparedCache.delete(preparedCache.keys().next().value);
  return pub;
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
// risoluzione dei video AI: 480p costa meno della metà di 720p (su Railway VIDEO_RESOLUTION=720p per tornare alla qualità più alta)
const VIDEO_RES = process.env.VIDEO_RESOLUTION === '720p' ? '720p' : '480p';
// durata del video: Seedance 2.0 fast accetta da 4 a 15 secondi
function videoSeconds(v) { const n = parseInt(v, 10); return [5, 8, 10, 15].includes(n) ? n : 5; }
async function startAdVideo(imageUrl, motion, brand, sector, style, seconds, person) {
  const sec = videoSeconds(seconds);
  // con la foto vera del titolare: volto identico, movimenti minimi (niente deformazioni)
  if (person) motion = `The real person in the photo must keep exactly the same face, identity, hairstyle, clothes and body: no changes, no morphing. Only natural, very subtle movement (soft breathing, a slight smile, a small head turn) and a slow cinematic camera push-in; the background can have gentle motion and light. The person does not speak. ${motion || ''}`;
  const { request_id } = await fal.queue.submit(SEEDANCE_MODEL, {
    // niente audio generato: la voce AI non parla bene l'italiano. La musica si aggiunge su Instagram.
    input: { prompt: adVideoPrompt(motion, brand, sector, style) + (sec > 5 ? ` The video lasts ${sec} seconds: develop the action in ${sec >= 10 ? 'three' : 'two'} smooth consecutive moments, with continuous camera movement.` : ''), image_url: imageUrl, resolution: VIDEO_RES, duration: String(sec), aspect_ratio: '9:16', generate_audio: false }
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
const PROTECTED_API = ['/api/generate', '/api/generate/status', '/api/generate-image', '/api/generate-carousel', '/api/generate-video',
  '/api/user/profile', '/api/user/save', '/api/posts/save', '/api/posts/delete', '/api/publish', '/api/social/status', '/api/social/disconnect', '/api/posts/state', '/api/media/upload', '/api/posts/update', '/api/posts/reschedule', '/api/image/overlay', '/api/posts/permalink', '/api/reel/upload-url', '/api/reel/talking', '/api/avatar', '/api/avatar/delete', '/api/reel/avatar', '/api/reel/avatar/script', '/api/reel/avatar/voice', '/api/reel/avatar/render'];
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
  if (/^\/(server\.js|agent\.js|overlay\.js|talkingreel\.js|package(-lock)?\.json|schema.*\.sql|env\.example|download|.*\.md)$/i.test(req.path) || req.path.startsWith('/node_modules')) {
    return res.status(404).end();
  }
  next();
});
// ===== VERIFICA DEL DOMINIO PER TIKTOK FOR DEVELOPERS =====
// TikTok chiede di mettere online un file tipo /tiktokAbC123.txt: su Railway imposta
// TIKTOK_VERIFY_FILE = nome del file (es. tiktokAbC123.txt) e TIKTOK_VERIFY_CONTENT = il testo contenuto nel file.
app.get(/^\/tiktok[A-Za-z0-9_-]+\.txt$/, (req, res, next) => {
  const name = (process.env.TIKTOK_VERIFY_FILE || '').trim().replace(/^\//, '');
  if (!name || req.path !== '/' + name) return next();
  res.type('text/plain').send((process.env.TIKTOK_VERIFY_CONTENT || '').trim());
});
app.use(express.static(path.join(__dirname), {
  dotfiles: 'deny',
  // le pagine HTML vengono sempre ricontrollate, così dopo un aggiornamento non resta la versione vecchia
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhook')) return next();
  const html = req.path.includes('dashboard') ? 'dashboard.html'
             : req.path.includes('login') ? 'login.html'
             : 'index.html';
  res.setHeader('Cache-Control', 'no-cache');
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
async function generateHandler(req, res) {
  try {
    const { brand, description, sector, city, usp, goal, socials, frequency, tone, style, userId, generateImages, generateVideo, refImages, useRealPhotos, textOverlay } = req.body;
    const wantText = textOverlay === true || textOverlay === 'true';
    const imgQuality = req.body.imageQuality === 'high' ? 'high' : 'medium';
    // foto del cliente: solo link del nostro storage
    // foto del cliente: link (vecchio formato) o { url, kind } con kind = work | place | person
    const okUrl = u => typeof u === 'string' && u.includes('/storage/v1/object/public/post-images/uploads/');
    const photoList = (Array.isArray(refImages) ? refImages : [])
      .map(p => typeof p === 'string' ? { url: p, kind: 'work' } : { url: p && p.url, kind: ['work', 'place', 'person'].includes(p && p.kind) ? p.kind : 'work' })
      .filter(p => okUrl(p.url)).slice(0, 8);
    const photos = photoList.filter(p => p.kind !== 'person').map(p => p.url);      // riferimenti per l'AI e foto da usare nei post
    const personPhotos = photoList.filter(p => p.kind === 'person').map(p => p.url); // volto: mai rielaborato dall'AI
    const realPhotos = (useRealPhotos === true || useRealPhotos === 'true') && photos.length > 0;
    const wantVideo = generateVideo === true || generateVideo === 'true';
    const vidSec = videoSeconds(req.body.videoDuration);
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
REEL: ogni post di tipo "reel" deve parlare di un argomento concreto e specifico di questo settore e di questa attività (un servizio, un prodotto, un lavoro tipico, un dietro le quinte, un consiglio pratico), mai generico. Il suo "image_prompt" descrive la scena di apertura verticale (9:16) con il soggetto del settore ben riconoscibile; il suo "video_prompt" va scritto IN INGLESE (${vidSec > 5 ? '80-140' : '50-90'} parole) e descrive cosa succede nei ${vidSec} secondi${vidSec > 5 ? ' (una piccola sequenza di 2-3 momenti consecutivi, sempre nella stessa scena)' : ''}: un'azione semplice e realistica del soggetto (movimenti lenti, niente mani in primo piano che fanno gesti complessi), movimento della camera, luce, atmosfera, coerente con l'immagine di apertura. Nel video non deve comparire nessuna scritta e nessuno deve parlare.${wantVideo ? ' Includi almeno 2 post di tipo "reel".' : ''}
${wantText ? `SCRITTE SULLE IMMAGINI: per ogni post aggiungi "overlay_title" (titolo d'impatto, massimo 6 parole, italiano perfetto, senza emoji e senza hashtag) e "overlay_subtitle" (frase breve di supporto, massimo 10 parole). Per ogni slide del carosello scrivi in "title" il titolo che apparirà su quella slide (massimo 6 parole) e in "subtitle" una riga di supporto (massimo 10 parole). Queste scritte verranno sovrapposte all'immagine in modo tipografico, quindi l'immagine stessa NON deve contenere testo.\n` : ''}STRATEGIA (non semplici pubblicazioni): costruisci un piano che porti le persone da "non ti conosco" a "ti contatto/compro". Mix dei post: circa 40% valore (consigli, spiegazioni, errori da evitare), 30% fiducia (lavori realizzati, dietro le quinte, risultati, prima/dopo, chi c'è dietro), 20% interazione (domande, scelte tra due opzioni, sondaggi), 10% vendita diretta con offerta chiara. Ogni post apre con un "hook" nella prima riga che ferma lo scroll (domanda, numero, affermazione forte) e chiude con una call to action adatta al suo obiettivo (salva, commenta, scrivici in DM, prenota, visita il link in bio). Orari scelti in base alle abitudini del target.
DIREZIONE VISIVA: immagini accattivanti da agenzia creativa, mai generiche o da stock. Per ogni post scegli il tipo di immagine più adatto all'attività:
- se l'attività REALIZZA qualcosa (grafica, locandine, volantini, biglietti da visita, loghi, siti web, app, packaging, arredamento, abiti, gioielli, piatti, lavori artigianali...), mostra IL LAVORO FINITO come mockup fotografico professionale e realistico: locandina stampata appesa o tenuta in mano, biglietti da visita impilati su una scrivania di design con luce morbida, sito web aperto su laptop e smartphone in uno studio luminoso, packaging in uno scatto da catalogo, prima/dopo, dettagli dei materiali. Il lavoro deve sembrare vero, curato e di alto livello (gerarchia grafica, impaginazione pulita, colori del brand, foto e forme ben composte), così che si capisca che dietro c'è un vero lavoro professionale;
- se l'attività offre un servizio alle persone, mostra persone reali in azione, l'ambiente, il risultato per il cliente;
- alterna inquadrature (dettaglio, ambiente, prodotto in mano, flat lay dall'alto) per rendere il feed vario.
CAROSELLI: ogni carosello ha esattamente 5 slide che raccontano una piccola storia (1 copertina d'impatto, 2-4 sviluppo: fasi del lavoro, dettagli, vantaggi o esempi diversi, 5 chiusura con invito all'azione). Le 5 immagini devono essere diverse tra loro ma coerenti nello stile.
IMMAGINI REALISTICHE: ogni "image_prompt" deve essere ricco e dettagliato (almeno 60 parole) e descrivere come una vera fotografia: soggetto, ambientazione, persone o prodotti, luce, inquadratura, profondità di campo, palette di colori, atmosfera. Il soggetto deve stare interamente nell'inquadratura. Niente testo, scritte, insegne o loghi nell'immagine: i messaggi vanno solo nel testo del post.
${photos.length ? `FOTO REALI DEL BRAND: ti allego foto reali di lavori, prodotti o ambienti del brand. Studiale con attenzione (stile, colori, materiali, qualità) e fai in modo che testi e image_prompt siano coerenti con ciò che vedi.\n` : ''}${personPhotos.length ? `FOTO DEL TITOLARE: ti allego anche una foto della persona che rappresenta il brand. Questa foto verrà usata COSÌ COM'È, senza modificarla, in UN SOLO post: scegli il post più adatto (presentazione, dietro le quinte, "chi sono", messaggio personale) di tipo "image" oppure "reel" e aggiungi su quel post "use_person_photo": true; scrivi quel testo in prima persona. Negli altri post NON descrivere né inserire il volto del titolare negli image_prompt (puoi usare mani al lavoro, persone generiche o dettagli).\n` : ''}Rispondi SOLO con JSON valido, niente testo fuori dal JSON:
{"strategy":{"summary":"sintesi strategia in 2 frasi","goal":"obiettivo principale e misurabile del periodo (es. 10 richieste di preventivo al mese)","funnel":"come i post accompagnano le persone dalla scoperta al contatto/acquisto, in 2-3 frasi","target":"descrizione pubblico target","content_pillars":["pillar1","pillar2","pillar3"],"best_times":"orari migliori per pubblicare e perché","tips":["consiglio pratico 1","consiglio pratico 2","consiglio pratico 3"]},"posts":[{"social":"${platforms[0]}","type":"image","day":"Lunedi","scheduled_time":"11:00","objective":"Notorietà | Fiducia | Interazione | Conversione","hook":"prima riga che ferma lo scroll","why":"perché questo post serve alla strategia, in una frase","text":"testo completo del post con emoji e call to action","hashtags":["hashtag1","hashtag2","hashtag3","hashtag4","hashtag5"],"image_prompt":"descrizione dettagliata immagine professionale"},{"social":"${platforms[0]}","type":"reel","day":"Mercoledi","scheduled_time":"19:00","objective":"...","hook":"...","why":"...","text":"testo coinvolgente per il reel su un tema specifico del settore","hashtags":["hashtag1","hashtag2","hashtag3","hashtag4","hashtag5"],"image_prompt":"scena di apertura del video","video_prompt":"english description of the 5-second action and camera movement, specific to this business"},{"social":"${platforms[0]}","type":"image","day":"Venerdi","scheduled_time":"12:00","objective":"...","hook":"...","why":"...","text":"testo dettagliato e coinvolgente","hashtags":["hashtag1","hashtag2","hashtag3"],"image_prompt":"immagine professionale"},{"social":"${platforms[0]}","type":"carousel","day":"Sabato","scheduled_time":"10:00","objective":"...","hook":"...","why":"...","text":"testo del carosello","hashtags":["hashtag1","hashtag2","hashtag3"],"carousel_slides":[{"title":"titolo slide 1 (copertina)","subtitle":"riga di supporto","image_prompt":"scena della slide 1"},{"title":"titolo slide 2","subtitle":"riga di supporto","image_prompt":"scena della slide 2"},{"title":"titolo slide 3","subtitle":"riga di supporto","image_prompt":"scena della slide 3"},{"title":"titolo slide 4","subtitle":"riga di supporto","image_prompt":"scena della slide 4"},{"title":"titolo slide 5 (chiusura con invito all'azione)","subtitle":"riga di supporto","image_prompt":"scena della slide 5"}]},{"social":"${platforms[0]}","type":"image","day":"Martedi","scheduled_time":"20:00","objective":"...","hook":"...","why":"...","text":"testo del quinto post","hashtags":["hashtag1","hashtag2","hashtag3"],"image_prompt":"descrizione immagine"}]}`;

    // le foto del cliente vengono mostrate anche all'AI che scrive post e descrizioni delle immagini
    let content = prompt;
    const visionList = photos.slice(0, 4).map(u => ({ u, label: 'Foto di un lavoro, prodotto o ambiente del brand:' }))
      .concat(personPhotos.slice(0, 1).map(u => ({ u, label: 'Foto del titolare (da usare così com\'è in un solo post):' })));
    if (visionList.length) {
      const blocks = [];
      for (const v of visionList) {
        try {
          const f = await axios.get(v.u, { responseType: 'arraybuffer', timeout: 20000 });
          const mt = (f.headers['content-type'] || 'image/jpeg').split(';')[0];
          if (['image/jpeg', 'image/png', 'image/webp'].includes(mt)) {
            blocks.push({ type: 'text', text: v.label });
            blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: Buffer.from(f.data).toString('base64') } });
          }
        } catch (e) { console.log('Foto di riferimento non leggibile:', e.message); }
      }
      if (blocks.length) content = blocks.concat([{ type: 'text', text: prompt }]);
    }
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 9000,
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

    // foto del titolare: in un solo post, usata così com'è (solo ritagliata nel formato giusto)
    if (personPhotos.length && Array.isArray(data.posts)) {
      let target = data.posts.find(p => p.use_person_photo && (p.type === 'image' || p.type === 'reel'));
      if (!target) target = data.posts.find(p => p.type === 'image') || data.posts.find(p => p.type === 'reel');
      data.posts.forEach(p => { if (p !== target) delete p.use_person_photo; });
      if (target) {
        try {
          target.image_url = await prepareRealPhoto(personPhotos[0], target.type === 'reel' ? 'reel' : 'feed');
          target.use_person_photo = true; target.person_photo = true; target.real_photo = true;
        } catch (e) { console.error('Foto del titolare non preparata:', e.message); }
      }
    }

    // "usa le mie foto": i post usano direttamente le foto reali caricate (ritagliate nel formato accettato da Instagram)
    if (realPhotos && Array.isArray(data.posts)) {
      let k = 0;
      const next = (mode) => prepareRealPhoto(photos[(k++) % photos.length], mode);
      for (const p of data.posts) {
        if (p.person_photo) continue;
        try {
          if (p.type === 'carousel') {
            const n = Math.min(Math.max(photos.length, 2), 5); // fino a 5 slide con le tue foto
            p.carousel_images = [];
            for (let j = 0; j < n; j++) p.carousel_images.push(await next('feed'));
            p.image_url = p.carousel_images[0];
          } else {
            p.image_url = await next(p.type === 'reel' ? 'reel' : 'feed');
          }
          p.real_photo = true;
        } catch (e) { console.error('Foto reale non preparata:', e.message); }
      }
    }

    const doImages = (generateImages === true || generateImages === 'true');
    const doVideo = freeLeft === null && (generateVideo === true || generateVideo === 'true');
    console.log('🖼️ generateImages:', generateImages, '→ doImages:', doImages, '| KEY:', !!process.env.OPENAI_API_KEY);
    // il video parte da un'immagine: per i reel la creiamo anche se "Immagini AI" non è spuntato
    const mediaErrors = [];
    if ((doImages || doVideo) && !process.env.OPENAI_API_KEY) mediaErrors.push('Chiave OpenAI (OPENAI_API_KEY) mancante su Railway: immagini non create');
    if ((doImages || doVideo) && process.env.OPENAI_API_KEY) {
      const styled = (p) => style && style.trim() ? `${p}. Stile e colori: ${style.trim()}` : p;
      const jobs = data.posts.map((post, i) => async () => {
        if (post.image_url || (post.carousel_images && post.carousel_images.length)) return; // ha già una foto reale
        if (!doImages && post.type !== 'reel') return;
        try {
          if (post.type === 'carousel' && post.carousel_slides) {
            const imgs = [];
            for (const sl of post.carousel_slides.slice(0, 5)) imgs.push(await generateImage(styled(sl.image_prompt || post.text), brand, { refs: photos, quality: imgQuality }));
            data.posts[i].carousel_images = imgs.filter(Boolean);
            data.posts[i].image_url = data.posts[i].carousel_images[0] || null;
          } else if (post.image_prompt || post.text) {
            data.posts[i].image_url = await generateImage(styled(post.image_prompt || post.text), brand, { refs: photos, quality: imgQuality, size: post.type === 'reel' ? '1024x1536' : '1024x1024' });
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
          data.posts[i].video_task_id = await startAdVideo(post.image_url, post.video_prompt || post.text, brand, sector, style, vidSec, !!post.person_photo);
          data.posts[i].video_seconds = vidSec;
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
}

// La generazione con immagini e video può durare minuti: la facciamo "in background"
// e il browser chiede ogni pochi secondi se è pronta (così nessun timeout interrompe la richiesta).
const genJobs = new Map();
// il risultato di ogni lavoro viene salvato anche nello storage: se il server si riavvia, non si perde
function saveJobResult(id, job) {
  const body = Buffer.from(JSON.stringify({ userId: job.userId, code: job.code, body: job.body }));
  supabase.storage.from('post-images').upload(`jobs/${id}.json`, body, { contentType: 'application/json', upsert: true })
    .then(r => { if (r.error) console.log('Risultato lavoro non salvato:', r.error.message); }).catch(() => {});
}
function runAsJob(req, res, handler) {
  const id = crypto.randomUUID();
  const job = { userId: req.body.userId, done: false, code: 200, body: null, started: Date.now() };
  genJobs.set(id, job);
  const finish = () => { job.done = true; saveJobResult(id, job); };
  const fake = {
    status(c) { job.code = c; return fake; },
    json(b) { job.body = b; finish(); return fake; }
  };
  Promise.resolve().then(() => handler(req, fake)).catch(e => { job.code = 500; job.body = { error: e.message }; finish(); });
  res.json({ job_id: id });
}
app.post('/api/generate', (req, res) => {
  if (req.query.async !== '1') return generateHandler(req, res);
  const id = crypto.randomUUID();
  const job = { userId: req.body.userId, done: false, code: 200, body: null, started: Date.now() };
  genJobs.set(id, job);
  const fake = {
    status(c) { job.code = c; return fake; },
    json(b) { job.body = b; job.done = true; saveJobResult(id, job); return fake; }
  };
  generateHandler(req, fake).catch(e => { job.code = 500; job.body = { error: 'Errore generazione', details: e.message }; job.done = true; saveJobResult(id, job); });
  res.json({ job_id: id });
});
app.get('/api/generate/status', async (req, res) => {
  const job = genJobs.get(req.query.id);
  if (!job || job.userId !== req.query.userId) {
    // non è in memoria: forse è finito prima di un riavvio del server
    if (/^[0-9a-f-]{36}$/.test(String(req.query.id || ''))) {
      try {
        const { data } = await supabase.storage.from('post-images').download(`jobs/${req.query.id}.json`);
        if (data) {
          const saved = JSON.parse(await data.text());
          if (saved.userId === req.query.userId) return res.status(saved.code || 200).json(Object.assign({ done: true }, saved.body));
        }
      } catch (e) { /* non trovato */ }
    }
    return res.status(404).json({ error: 'Lavoro interrotto: il server si è aggiornato o riavviato mentre preparavamo il contenuto. Riprova.', interrupted: true });
  }
  if (!job.done) return res.json({ done: false, seconds: Math.round((Date.now() - job.started) / 1000) });
  genJobs.delete(req.query.id);
  res.status(job.code).json(Object.assign({ done: true }, job.body));
});
// pulizia dei lavori dimenticati
setInterval(() => { const lim = Date.now() - 30 * 60000; for (const [k, j] of genJobs) if (j.started < lim) genJobs.delete(k); }, 10 * 60000);

// ===== DALL-E 3 =====
// opts.size: '1024x1024' (feed/carosello) o '1024x1536' (reel verticale)
// opts.refs: link di foto reali del cliente da usare come riferimento visivo
async function generateImage(prompt, brand, opts) {
  opts = opts || {};
  const quality = opts.quality === 'high' ? 'high' : 'medium';
  const size = opts.size || '1024x1024';
  const refs = (opts.refs || []).filter(Boolean).slice(0, 4);
  const safePrompt = (`Immagine fotografica d'impatto per i social di "${brand}", livello agenzia creativa. ${prompt}. ` +
    `Stile: foto vera scattata con fotocamera professionale, luce curata, dettagli e texture reali, composizione elegante e accattivante, ` +
    `soggetto principale ben visibile con margine sui bordi (niente tagliato), nessuna resa da cartone animato o clip art. ` +
    `Se si mostra un lavoro grafico o digitale (locandina, volantino, biglietto da visita, logo, sito web su schermo, app, packaging) è un mockup fotografico realistico: ` +
    `il design appare professionale con impaginazione, forme, foto e colori ben composti; eventuali testi del design sono piccoli, in prospettiva o sfocati e mai in primo piano. ` +
    `Nessuna scritta grande e leggibile in primo piano, nessuna insegna o logo inventato con lettere: i titoli vengono aggiunti dopo.` +
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
      form.append('quality', quality);
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
        return generateImage(prompt, brand, { size, quality });
      }
      r = { data: json };
    } else {
      // OpenAI risponde 429 sia per "troppe richieste" (si riprova dopo una pausa) sia per credito esaurito (inutile riprovare)
      for (let attempt = 1; ; attempt++) {
        try {
          r = await axios.post(
            'https://api.openai.com/v1/images/generations',
            { model: 'gpt-image-1', prompt: safePrompt, n: 1, size, quality },
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
    const { prompt, brand, userId, refImages, size, quality } = req.body;
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI non configurato' });
    const refs = (Array.isArray(refImages) ? refImages : []).filter(u => typeof u === 'string' && u.includes('/storage/v1/object/public/post-images/uploads/')).slice(0, 4);
    const url = await generateImage(prompt, brand || 'Brand', { refs, quality, size: size === '1024x1536' ? '1024x1536' : '1024x1024' });
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
    const { prompt, imageUrl, userId, brand, sector, style, duration, person } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl obbligatoria' });
    const request_id = await startAdVideo(imageUrl, prompt, brand, sector, style, duration, person === true);
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

// ===== INSTAGRAM DIRETTO (Instagram Login, senza passare da Facebook) =====
// Serve un profilo Instagram professionale (Business o Creator). Variabili su Railway:
// INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET (Meta for Developers → app → Instagram → Configurazione API con login di Instagram)
const IG_GRAPH = 'https://graph.instagram.com/v21.0';
app.get('/auth/instagram', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.redirect(`${siteUrl()}/dashboard.html?error=no_user`);
  if (!process.env.INSTAGRAM_APP_ID) return res.redirect(`${siteUrl()}/dashboard.html?error=ig_not_configured`);
  const scope = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments'].join(',');
  const state = Buffer.from(JSON.stringify({ userId })).toString('base64url');
  const url = 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID, redirect_uri: siteUrl() + '/auth/instagram/callback',
    response_type: 'code', scope, state, enable_fb_login: '0', force_reauth: 'true'
  }).toString();
  res.redirect(url);
});

app.get('/auth/instagram/callback', async (req, res) => {
  const DASH = siteUrl() + '/dashboard.html';
  try {
    const { code, state, error } = req.query;
    if (error || !code) return res.redirect(DASH + '?error=auth_denied');
    const { userId } = JSON.parse(Buffer.from(String(state), 'base64url').toString());
    if (!userId) return res.redirect(DASH + '?error=no_user');
    const form = new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID, client_secret: process.env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code', redirect_uri: siteUrl() + '/auth/instagram/callback',
      code: String(code).replace(/#_$/, '')
    });
    const t1 = await axios.post('https://api.instagram.com/oauth/access_token', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const d1 = (t1.data && Array.isArray(t1.data.data)) ? t1.data.data[0] : t1.data;
    const t2 = await axios.get('https://graph.instagram.com/access_token', {
      params: { grant_type: 'ig_exchange_token', client_secret: process.env.INSTAGRAM_APP_SECRET, access_token: d1.access_token }
    });
    const token = t2.data.access_token;
    const me = await axios.get(`${IG_GRAPH}/me`, { params: { fields: 'user_id,username,account_type', access_token: token } });
    const igId = String(me.data.user_id || me.data.id || d1.user_id);
    await supabase.from('social_connections').delete().eq('user_id', userId).eq('platform', 'instagram');
    const { error: saveErr } = await supabase.from('social_connections').insert({
      user_id: userId, platform: 'instagram', ig_account_id: igId, page_name: me.data.username ? '@' + me.data.username : null,
      access_token: token, page_access_token: token,
      pages: { via: 'instagram', expires_at: new Date(Date.now() + (t2.data.expires_in || 5184000) * 1000).toISOString() },
      connected_at: new Date().toISOString()
    });
    if (saveErr) { console.error('❌ Salvataggio Instagram fallito:', saveErr.message); return res.redirect(DASH + '?error=save_failed'); }
    console.log('📸 Instagram collegato direttamente:', igId, me.data.username);
    res.redirect(DASH + '?connected=instagram');
  } catch (e) {
    console.error('❌ Instagram OAuth error:', e.response?.data || e.message);
    res.redirect(DASH + '?error=auth_failed');
  }
});

// i token di Instagram diretto durano 60 giorni: li rinnoviamo ogni giorno (Instagram lo consente dopo 24 ore)
async function refreshInstagramTokens() {
  try {
    const { data } = await supabase.from('social_connections').select('id,access_token,pages,connected_at').eq('platform', 'instagram').is('page_id', null);
    for (const r of data || []) {
      if (!r.pages || r.pages.via !== 'instagram' || !r.access_token) continue;
      if (Date.now() - new Date(r.connected_at).getTime() < 86400000) continue;
      try {
        const t = await axios.get('https://graph.instagram.com/refresh_access_token', { params: { grant_type: 'ig_refresh_token', access_token: r.access_token } });
        await supabase.from('social_connections').update({
          access_token: t.data.access_token, page_access_token: t.data.access_token,
          pages: Object.assign({}, r.pages, { expires_at: new Date(Date.now() + (t.data.expires_in || 5184000) * 1000).toISOString() })
        }).eq('id', r.id);
      } catch (e) { console.log('Rinnovo token Instagram non riuscito:', r.id, e.response?.data?.error?.message || e.message); }
    }
  } catch (e) { console.log('refreshInstagramTokens:', e.message); }
}

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

    await supabase.from('social_connections').delete().eq('user_id', userId).eq('platform', 'facebook');
    await supabase.from('social_connections').delete().eq('user_id', userId).eq('platform', 'instagram').not('page_id', 'is', null);

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
          await supabase.from('social_connections').delete().eq('user_id', userId).eq('platform', 'instagram').eq('ig_account_id', igAccount.id);
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
    const platforms = platform === 'tiktok' ? ['tiktok'] : platform === 'instagram' ? ['instagram'] : ['facebook', 'instagram'];
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
    const { data, error } = await supabase.from('social_connections').select('platform,page_name,connected_at,page_id,pages').eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    // i token di accesso restano solo sul server
    const conns = data.map(c => ({ platform: c.platform, page_name: c.page_name, connected_at: c.connected_at,
      via: (c.platform === 'instagram' && !c.page_id && c.pages && c.pages.via === 'instagram') ? 'instagram' : 'facebook' }));
    res.json({ count: conns.length, connections: conns });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== USER =====
app.post('/api/user/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida' });
    if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri' });
    // account creato già confermato: non serve l'email di conferma (che spesso non arriva)
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) {
        // account rimasto "non confermato" da un tentativo precedente: lo confermiamo con la nuova password
        const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const ex = ((list && list.users) || []).find(u => String(u.email || '').toLowerCase() === email);
        if (ex && !ex.email_confirmed_at) {
          const { error: e2 } = await supabase.auth.admin.updateUserById(ex.id, { password, email_confirm: true, user_metadata: { name } });
          if (e2) throw e2;
          await supabase.from('users').upsert({ id: ex.id, email, name, plan: 'free', posts_this_week: 0 }, { onConflict: 'id' });
          return res.json({ success: true, userId: ex.id });
        }
        return res.status(409).json({ error: 'Esiste già un account con questa email: usa "Accedi" (o "Password dimenticata").' });
      }
      throw error;
    }
    await supabase.from('users').upsert({ id: data.user.id, email, name, plan: 'free', posts_this_week: 0, created_at: new Date().toISOString() }, { onConflict: 'id' });
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

// ===== RIPROGRAMMA UN POST GIÀ PUBBLICATO: torna in programmazione con la nuova data =====
app.post('/api/posts/reschedule', async (req, res) => {
  try {
    const { userId, postId, scheduled_at, text } = req.body;
    if (!userId || !postId || !scheduled_at || isNaN(Date.parse(scheduled_at))) return res.status(400).json({ error: 'Dati mancanti' });
    if (new Date(scheduled_at) < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Scegli una data futura' });
    const { data: orig, error } = await supabase.from('posts').select('*').eq('id', postId).eq('user_id', userId).single();
    if (error || !orig) return res.status(404).json({ error: 'Post non trovato' });
    // si riprogramma lo stesso post: torna "approvato" con la nuova data e lo scheduler lo ripubblica
    const upd = { status: 'approved', scheduled_at: new Date(scheduled_at).toISOString(), error: null };
    if (typeof text === 'string' && text.trim()) upd.text = text.slice(0, 2200);
    const { data: ins, error: updErr } = await supabase.from('posts').update(upd).eq('id', orig.id).eq('user_id', userId).select('id,status,scheduled_at').single();
    if (updErr || !ins) throw (updErr || new Error('Aggiornamento non riuscito'));
    res.json({ success: true, id: ins.id });
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
    const { userId, sid, text, status, video_url, video_task_id, image_url, carousel_images, new_text, scheduled_time, day, overlay_title, overlay_subtitle, scheduled_at } = req.body;
    const hasEdit = video_url || video_task_id || image_url || carousel_images || new_text || scheduled_time || day || scheduled_at || overlay_title !== undefined;
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
    if (scheduled_at && !isNaN(Date.parse(scheduled_at))) patch.scheduled_at = new Date(scheduled_at).toISOString();
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
    res.json({ success: true, published_on: out.done, errors: out.failed, ig_media_id: out.igId });
  } catch (e) {
    console.error('Publish error:', e.message);
    res.status(500).json({ error: 'Errore pubblicazione', details: e.message });
  }
});

// ===== LINK DEL POST PUBBLICATO (per controllare che sia online) =====
app.get('/api/posts/permalink', async (req, res) => {
  try {
    const { userId, postId } = req.query;
    const { data: post } = await supabase.from('posts').select('ig_media_id,platform,status').eq('id', postId).eq('user_id', userId).single();
    if (!post || post.status !== 'published') return res.json({ permalink: null, error: 'Il post non risulta ancora pubblicato' });
    if (post.ig_media_id) {
      const conns = await agentApi.getConnections(userId);
      if (conns.ig) {
        const m = await axios.get(`${conns.ig.graph || 'https://graph.facebook.com/v19.0'}/${post.ig_media_id}`, { params: { fields: 'permalink', access_token: conns.ig.token } });
        if (m.data.permalink) return res.json({ permalink: m.data.permalink });
      }
    }
    // pubblicato solo su Facebook: apriamo la pagina
    const conns = await agentApi.getConnections(userId);
    if (conns.fbPage) return res.json({ permalink: `https://www.facebook.com/${conns.fbPage.id}` });
    res.json({ permalink: null, error: 'Link non disponibile: controlla direttamente il profilo' });
  } catch (e) {
    res.json({ permalink: null, error: 'Link non disponibile: ' + ((e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message) });
  }
});

// ===== REEL CON LA VOCE ORIGINALE =====
async function userIsPaid(userId, authEmail) {
  if (isOwnerEmail(authEmail)) return true;
  const { data } = await supabase.from('users').select('plan,email').eq('id', userId).single();
  return !!data && (isOwnerEmail(data.email) || ['starter', 'pro', 'business'].includes(data.plan));
}

// 1) il browser chiede dove caricare il video (link firmato, il file non passa dal nostro server)
app.post('/api/reel/upload-url', async (req, res) => {
  try {
    const { userId, ext } = req.body;
    if (!(await userIsPaid(userId, req.authEmail))) return res.status(403).json({ error: 'I reel con la tua voce sono inclusi nei piani a pagamento' });
    const e = ['mp4', 'mov', 'webm', 'm4v'].includes(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : 'mp4';
    const filePath = `uploads/${userId}/videos/${crypto.randomUUID()}.${e}`;
    const { data, error } = await supabase.storage.from('post-images').createSignedUploadUrl(filePath);
    if (error) throw new Error(error.message);
    res.json({ path: filePath, token: data.token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) sottotitoli + titolo + testo del post, la voce resta quella vera
async function talkingReelHandler(req, res) {
  const tmp = [];
  try {
    const { userId, path: vPath, brand, sector, style, tone, socials, title: wantedTitle } = req.body;
    if (!(await userIsPaid(userId, req.authEmail))) return res.status(403).json({ error: 'I reel con la tua voce sono inclusi nei piani a pagamento' });
    if (!vPath || !String(vPath).startsWith(`uploads/${userId}/videos/`)) return res.status(400).json({ error: 'Video non valido' });
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'Chiave OpenAI mancante: serve per trascrivere la voce' });

    const { data: blob, error: dlErr } = await supabase.storage.from('post-images').download(vPath);
    if (dlErr || !blob) throw new Error('Video non trovato: ' + (dlErr && dlErr.message));
    const inPath = talking.tmpFile(path.extname(vPath) || '.mp4'); tmp.push(inPath);
    await fsp.writeFile(inPath, Buffer.from(await blob.arrayBuffer()));
    const dur = await talking.probeDuration(inPath);
    if (dur && dur < 3) return res.status(400).json({ error: 'Il video è troppo corto (minimo 3 secondi)' });

    // trascrizione con i tempi di ogni parola (per i sottotitoli sincronizzati)
    const audio = await talking.extractAudio(inPath); tmp.push(audio);
    const form = new FormData();
    form.append('file', new Blob([await fsp.readFile(audio)], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', 'whisper-1');
    form.append('language', 'it');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
    const tj = await tr.json();
    if (!tr.ok) throw new Error('Trascrizione: ' + ((tj.error && tj.error.message) || tr.status));
    const transcript = String(tj.text || '').trim();
    const words = (tj.words || []).filter(w => w.start < 90);

    // titolo, testo del post e hashtag scritti dall'AI partendo da quello che hai detto
    const rawSocial = Array.isArray(socials) ? socials.join(' + ') : String(socials || 'Instagram');
    let platforms = /tutti/i.test(rawSocial) ? ['Instagram', 'Facebook', 'TikTok'] : ['Instagram', 'Facebook', 'TikTok'].filter(n => new RegExp(n, 'i').test(rawSocial));
    if (!platforms.length) platforms = ['Instagram'];
    const ai = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1200,
      messages: [{ role: 'user', content: `Sei un social media manager italiano. Questo è il parlato di un reel in cui il titolare di "${brand || 'un brand'}"${sector ? ' (' + sector + ')' : ''} parla in camera:
<<<${transcript.slice(0, 4000)}>>>
Tono: ${tone || 'professionale'}. ${style ? 'Stile: ' + style + '.' : ''}
Scrivi in italiano corretto e naturale. Rispondi SOLO con JSON:
{"title":"titolo d'impatto da mostrare all'inizio del video, massimo 6 parole, senza emoji","text":"testo del post: prima riga hook che ferma lo scroll, poi 2-4 frasi che riprendono il messaggio, chiusura con call to action; qualche emoji","hashtags":["5-8 hashtag pertinenti senza #"],"objective":"Notorietà | Fiducia | Interazione | Conversione","why":"perché questo reel serve alla strategia, in una frase"}` }]
    });
    let meta = {};
    try { const t = ai.content.map(b => b.text || '').join(''); meta = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]); } catch (e) { meta = {}; }
    const title = (wantedTitle && String(wantedTitle).trim()) || meta.title || '';

    // montaggio: 9:16, sottotitoli, titolo; voce originale intatta
    const acc = accentFromStyle(style);
    const ass = talking.buildAss(talking.groupWords(words), title, acc === '#ffffff' ? '#6D4AFF' : acc);
    const outPath = await talking.renderReel(inPath, ass, 90); tmp.push(outPath);
    const thumbPath = await talking.thumbnail(outPath, Math.min(1.5, Math.max(0.3, (dur || 2) / 3))); tmp.push(thumbPath);
    const videoName = `videos/${crypto.randomUUID()}.mp4`, thumbName = `posts/${crypto.randomUUID()}.jpg`;
    const up1 = await supabase.storage.from('post-images').upload(videoName, await fsp.readFile(outPath), { contentType: 'video/mp4', upsert: false });
    if (up1.error) throw new Error('Salvataggio video: ' + up1.error.message + ' (se il video finito supera i 50 MB prova con un video più corto)');
    const up2 = await supabase.storage.from('post-images').upload(thumbName, await fsp.readFile(thumbPath), { contentType: 'image/jpeg', upsert: false });
    if (up2.error) throw new Error('Salvataggio anteprima: ' + up2.error.message);
    const video_url = supabase.storage.from('post-images').getPublicUrl(videoName).data.publicUrl;
    const image_url = supabase.storage.from('post-images').getPublicUrl(thumbName).data.publicUrl;

    const post = {
      type: 'reel', social: platforms[0], socials: platforms, talking: true, person_photo: true,
      text: meta.text || transcript.slice(0, 600), hashtags: Array.isArray(meta.hashtags) ? meta.hashtags.slice(0, 10) : [],
      objective: meta.objective || 'Fiducia', why: meta.why || 'Il volto e la voce del titolare creano fiducia.',
      overlay_title: title, transcript, video_url, image_url, video_status: 'completed',
      day: 'Giovedi', scheduled_time: '18:30', status: 'draft'
    };
    const { data: saved, error: sErr } = await supabase.from('strategies').insert({
      user_id: userId, brand: brand || '', sector: sector || '',
      strategy: { summary: 'Reel con la tua voce' }, posts: [post], created_at: new Date().toISOString()
    }).select('id').single();
    if (sErr) throw new Error('Salvataggio post: ' + sErr.message);
    supabase.storage.from('post-images').remove([vPath]).catch(() => {}); // il video originale non serve più
    res.json({ success: true, post, strategy_id: saved.id });
  } catch (e) {
    console.error('Reel parlato:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    for (const f of tmp) fsp.unlink(f).catch(() => {});
  }
}
app.post('/api/reel/talking', (req, res) => runAsJob(req, res, talkingReelHandler));

// ===== AVATAR: IL TUO VOLTO E LA TUA VOCE PER REEL CREATI DALL'AI =====
// Il cliente carica una volta un video in cui parla. Da lì: volto (video di base) e timbro di voce (campione).
// Poi l'AI inventa l'argomento, scrive il testo, lo legge con la sua voce, sincronizza le labbra e monta il reel.
const TTS_MODEL = 'fal-ai/chatterbox/text-to-speech/multilingual';
const LIPSYNC_MODEL = 'fal-ai/sync-lipsync/v2';

async function getAvatar(userId) {
  const { data: items } = await supabase.storage.from('post-images').list(`uploads/${userId}`, { limit: 100 });
  const dir = (items || []).find(i => /^avatar-[0-9a-f-]{36}$/.test(i.name));
  if (!dir) return null;
  const base = `uploads/${userId}/${dir.name}`;
  const pub = (f) => supabase.storage.from('post-images').getPublicUrl(`${base}/${f}`).data.publicUrl;
  return { dir: base, video_url: pub('source.mp4'), voice_url: pub('voice.wav'), created_at: dir.created_at || dir.updated_at || null };
}
async function removeAvatar(userId) {
  const av = await getAvatar(userId);
  if (av) await supabase.storage.from('post-images').remove(['source.mp4', 'voice.wav', 'meta.json', 'photo.jpg'].map(f => `${av.dir}/${f}`));
}

app.get('/api/avatar', async (req, res) => {
  try {
    const av = await getAvatar(req.query.userId);
    res.json(av ? { exists: true, video_url: av.video_url, created_at: av.created_at } : { exists: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/avatar/delete', async (req, res) => {
  try { await removeAvatar(req.body.userId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

async function avatarSetupHandler(req, res) {
  const tmp = [];
  try {
    const { userId, path: vPath, consent } = req.body;
    if (!(await userIsPaid(userId, req.authEmail))) return res.status(403).json({ error: 'L\'avatar è incluso nei piani a pagamento' });
    if (consent !== true) return res.status(400).json({ error: 'Serve la conferma del consenso all\'uso del volto e della voce' });
    if (!vPath || !String(vPath).startsWith(`uploads/${userId}/videos/`)) return res.status(400).json({ error: 'Video non valido' });
    const { data: blob, error: dlErr } = await supabase.storage.from('post-images').download(vPath);
    if (dlErr || !blob) throw new Error('Video non trovato');
    const inPath = talking.tmpFile(path.extname(vPath) || '.mp4'); tmp.push(inPath);
    await fsp.writeFile(inPath, Buffer.from(await blob.arrayBuffer()));
    const dur = await talking.probeDuration(inPath);
    if (dur && dur < 10) return res.status(400).json({ error: 'Il video è troppo corto: servono almeno 10 secondi in cui parli guardando la camera' });
    const source = await talking.renderReel(inPath, null, 60, { noAudio: true, crf: '20' }); tmp.push(source);
    const voice = await talking.extractVoiceRef(inPath, dur > 14 ? 1.5 : 0.5); tmp.push(voice);
    await removeAvatar(userId);
    const base = `uploads/${userId}/avatar-${crypto.randomUUID()}`;
    const up = async (name, file, type) => {
      const { error } = await supabase.storage.from('post-images').upload(`${base}/${name}`, typeof file === 'string' ? await fsp.readFile(file) : file, { contentType: type, upsert: true });
      if (error) throw new Error('Salvataggio avatar: ' + error.message);
    };
    await up('source.mp4', source, 'video/mp4');
    try { const ph = await talking.thumbnail(source, Math.min(1.2, Math.max(0.3, (dur || 2) / 4))); tmp.push(ph); await up('photo.jpg', ph, 'image/jpeg'); } catch (e) { console.log('Foto avatar non creata:', e.message); }
    await up('voice.wav', voice, 'audio/wav');
    await up('meta.json', Buffer.from(JSON.stringify({ consent: true, consent_at: new Date().toISOString(), email: req.authEmail || null, seconds: Math.round(dur || 0) })), 'application/json');
    supabase.storage.from('post-images').remove([vPath]).catch(() => {});
    const av = await getAvatar(userId);
    res.json({ success: true, video_url: av && av.video_url });
  } catch (e) {
    console.error('Avatar:', e.message);
    res.status(500).json({ error: e.message });
  } finally { for (const f of tmp) fsp.unlink(f).catch(() => {}); }
}
app.post('/api/avatar', (req, res) => runAsJob(req, res, avatarSetupHandler));

// testo -> frasi da max ~280 caratteri (limite della sintesi vocale)
function splitForTts(text) {
  const sentences = String(text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || [];
  const out = [];
  let cur = '';
  for (let s of sentences) {
    s = s.trim(); if (!s) continue;
    while (s.length > 280) { const cut = s.lastIndexOf(' ', 270); out.push(s.slice(0, cut > 0 ? cut : 270)); s = s.slice(cut > 0 ? cut + 1 : 270); }
    if ((cur + ' ' + s).trim().length <= 280) cur = (cur + ' ' + s).trim(); else { if (cur) out.push(cur); cur = s; }
  }
  if (cur) out.push(cur);
  return out;
}

async function avatarReelHandler(req, res) {
  const tmp = [];
  try {
    const { userId, topic, length, brand, description, sector, tone, style, socials, aiLabel } = req.body;
    if (!(await userIsPaid(userId, req.authEmail))) return res.status(403).json({ error: 'I reel con il tuo avatar sono inclusi nei piani a pagamento' });
    const av = await getAvatar(userId);
    if (!av) return res.status(400).json({ error: 'Prima crea il tuo avatar caricando un video in cui parli' });
    if (!process.env.FAL_KEY) return res.status(400).json({ error: 'Chiave FAL_KEY mancante su Railway' });
    const words = length === 'medium' ? '75-95 parole (circa 35 secondi)' : '45-60 parole (circa 20 secondi)';

    // 1) l'AI inventa l'argomento e scrive il testo parlato
    const ai = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
      messages: [{ role: 'user', content: `Sei un social media manager e copywriter italiano. Scrivi il testo di un reel in cui il titolare di "${brand || 'un brand'}" parla guardando la camera, come se lo registrasse lui stesso con lo smartphone.
Attività: ${description || ''}${sector ? ' — Settore: ' + sector : ''}. Tono: ${tone || 'amichevole'}. ${style ? 'Stile: ' + style + '.' : ''}
${topic && String(topic).trim() ? 'Argomento richiesto: ' + String(topic).trim() : 'Scegli tu un argomento utile e specifico per il suo pubblico (un consiglio pratico, un errore comune da evitare, un dietro le quinte, un caso reale tipico, una domanda frequente dei clienti), che porti nuovi contatti.'}
Regole del testo parlato: ${words}; italiano naturale e colloquiale in prima persona, frasi brevi; la prima frase è un gancio che ferma lo scroll; chiudi con un invito all'azione chiaro; niente emoji, niente hashtag, niente elenchi; scrivi i numeri in lettere; niente promesse esagerate.
Rispondi SOLO con JSON: {"title":"titolo da mostrare a inizio video, massimo 6 parole","script":"testo parlato","text":"testo del post: hook nella prima riga, 2-3 frasi, call to action, qualche emoji","hashtags":["5-8 hashtag senza #"],"objective":"Notorietà | Fiducia | Interazione | Conversione","why":"perché questo reel serve alla strategia, in una frase"}` }]
    });
    let meta;
    try { const t = ai.content.map(b => b.text || '').join(''); meta = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]); } catch (e) { throw new Error('Testo del reel non generato, riprova'); }
    if (!meta.script) throw new Error('Testo del reel non generato, riprova');

    // 2) il testo letto con la voce del cliente (frase per frase, stessa voce e stesso "seed")
    const parts = splitForTts(meta.script);
    const seed = Math.floor(Math.random() * 1e6) + 1;
    const audioUrls = await Promise.all(parts.map(text => fal.subscribe(TTS_MODEL, {
      input: { text, voice: av.voice_url, custom_audio_language: 'italian', exaggeration: 0.5, cfg_scale: 0.5, temperature: 0.7, seed }
    }).then(r => r.data.audio.url)));
    const partFiles = [];
    for (const u of audioUrls) {
      const f = talking.tmpFile('.wav'); tmp.push(f); partFiles.push(f);
      const a = await axios.get(u, { responseType: 'arraybuffer', timeout: 60000 });
      await fsp.writeFile(f, Buffer.from(a.data));
    }
    const speech = await talking.concatAudio(partFiles); tmp.push(speech);
    const audioName = `posts/voice-${crypto.randomUUID()}.mp3`;
    const upA = await supabase.storage.from('post-images').upload(audioName, await fsp.readFile(speech), { contentType: 'audio/mpeg', upsert: false });
    if (upA.error) throw new Error('Salvataggio audio: ' + upA.error.message);
    const audio_url = supabase.storage.from('post-images').getPublicUrl(audioName).data.publicUrl;

    // 3) labbra sincronizzate sul video vero del cliente
    const ls = await fal.subscribe(LIPSYNC_MODEL, { input: { video_url: av.video_url, audio_url, sync_mode: 'bounce' }, pollInterval: 5000 });
    const lsFile = talking.tmpFile('.mp4'); tmp.push(lsFile);
    const v = await axios.get(ls.data.video.url, { responseType: 'arraybuffer', timeout: 180000 });
    await fsp.writeFile(lsFile, Buffer.from(v.data));

    // 4) sottotitoli sincronizzati e titolo, poi salvataggio come post da approvare
    const form = new FormData();
    form.append('file', new Blob([await fsp.readFile(speech)], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', 'whisper-1'); form.append('language', 'it');
    form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
    let wordsT = [];
    try {
      const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
      const tj = await tr.json(); if (tr.ok) wordsT = tj.words || [];
    } catch (e) { console.log('Sottotitoli non disponibili:', e.message); }
    const acc = accentFromStyle(style);
    const ass = talking.buildAss(talking.groupWords(wordsT), meta.title || '', acc === '#ffffff' ? '#6D4AFF' : acc);
    const outPath = await talking.renderReel(lsFile, ass, 90); tmp.push(outPath);
    const thumbPath = await talking.thumbnail(outPath, 1.0); tmp.push(thumbPath);
    const videoName = `videos/${crypto.randomUUID()}.mp4`, thumbName = `posts/${crypto.randomUUID()}.jpg`;
    const up1 = await supabase.storage.from('post-images').upload(videoName, await fsp.readFile(outPath), { contentType: 'video/mp4', upsert: false });
    if (up1.error) throw new Error('Salvataggio video: ' + up1.error.message);
    await supabase.storage.from('post-images').upload(thumbName, await fsp.readFile(thumbPath), { contentType: 'image/jpeg', upsert: false });
    supabase.storage.from('post-images').remove([audioName]).catch(() => {});

    const rawSocial = Array.isArray(socials) ? socials.join(' + ') : String(socials || 'Instagram');
    let platforms = /tutti/i.test(rawSocial) ? ['Instagram', 'Facebook', 'TikTok'] : ['Instagram', 'Facebook', 'TikTok'].filter(n => new RegExp(n, 'i').test(rawSocial));
    if (!platforms.length) platforms = ['Instagram'];
    let caption = meta.text || meta.script;
    if (aiLabel !== false) caption += '\n\n🤖 Video realizzato con l\'AI a partire dalla mia voce e dal mio volto.';
    const post = {
      type: 'reel', social: platforms[0], socials: platforms, talking: true, ai_avatar: true, person_photo: true,
      text: caption, hashtags: Array.isArray(meta.hashtags) ? meta.hashtags.slice(0, 10) : [],
      objective: meta.objective || 'Fiducia', why: meta.why || '', overlay_title: meta.title || '', transcript: meta.script,
      video_url: supabase.storage.from('post-images').getPublicUrl(videoName).data.publicUrl,
      image_url: supabase.storage.from('post-images').getPublicUrl(thumbName).data.publicUrl,
      video_status: 'completed', day: 'Martedi', scheduled_time: '18:30', status: 'draft'
    };
    const { data: saved, error: sErr } = await supabase.from('strategies').insert({
      user_id: userId, brand: brand || '', sector: sector || '', strategy: { summary: 'Reel con il tuo avatar' }, posts: [post], created_at: new Date().toISOString()
    }).select('id').single();
    if (sErr) throw new Error('Salvataggio post: ' + sErr.message);
    res.json({ success: true, post, strategy_id: saved.id });
  } catch (e) {
    const msg = (e && (e.status || e.body)) ? falErrorMessage(e) : e.message;
    console.error('Reel avatar:', msg);
    res.status(500).json({ error: msg });
  } finally { for (const f of tmp) fsp.unlink(f).catch(() => {}); }
}
app.post('/api/reel/avatar', (req, res) => runAsJob(req, res, avatarReelHandler));

// ===== AVATAR STILE "PRESENTATORE" (come Pippit): foto del cliente che parla con gesti naturali + montaggio =====
// Passo 1 (quasi gratis): l'AI sceglie l'argomento, scrive il testo e lo legge con la tua voce -> anteprima.
// Passo 2 (solo se approvi): avatar che parla dalla tua foto + immagini di approfondimento + sottotitoli + titolo.
const AVATAR_MODEL = 'fal-ai/kling-video/ai-avatar/v2/standard';

async function ttsWithVoice(script, voiceUrl) {
  const parts = splitForTts(script);
  if (!parts.length) throw new Error('Testo vuoto');
  const seed = Math.floor(Math.random() * 1e6) + 1;
  const urls = await Promise.all(parts.map(text => fal.subscribe(TTS_MODEL, {
    input: { text, voice: voiceUrl, custom_audio_language: 'italian', exaggeration: 0.5, cfg_scale: 0.5, temperature: 0.7, seed }
  }).then(r => r.data.audio.url)));
  const files = [];
  try {
    for (const u of urls) {
      const f = talking.tmpFile('.wav'); files.push(f);
      const a = await axios.get(u, { responseType: 'arraybuffer', timeout: 60000 });
      await fsp.writeFile(f, Buffer.from(a.data));
    }
    const speech = await talking.concatAudio(files);
    const duration = await talking.probeDuration(speech);
    const name = `posts/voice-${crypto.randomUUID()}.mp3`;
    const up = await supabase.storage.from('post-images').upload(name, await fsp.readFile(speech), { contentType: 'audio/mpeg', upsert: false });
    fsp.unlink(speech).catch(() => {});
    if (up.error) throw new Error('Salvataggio audio: ' + up.error.message);
    return { audio_url: supabase.storage.from('post-images').getPublicUrl(name).data.publicUrl, duration };
  } finally { for (const f of files) fsp.unlink(f).catch(() => {}); }
}

// foto del cliente per l'avatar: un fotogramma del suo video (creato la prima volta che serve)
async function avatarPhotoUrl(av) {
  const photoPath = `${av.dir}/photo.jpg`;
  const { data } = await supabase.storage.from('post-images').download(photoPath);
  if (data) return supabase.storage.from('post-images').getPublicUrl(photoPath).data.publicUrl;
  const v = await axios.get(av.video_url, { responseType: 'arraybuffer', timeout: 120000 });
  const src = talking.tmpFile('.mp4'); await fsp.writeFile(src, Buffer.from(v.data));
  try {
    const jpg = await talking.thumbnail(src, 1.2);
    await supabase.storage.from('post-images').upload(photoPath, await fsp.readFile(jpg), { contentType: 'image/jpeg', upsert: true });
    fsp.unlink(jpg).catch(() => {});
  } finally { fsp.unlink(src).catch(() => {}); }
  return supabase.storage.from('post-images').getPublicUrl(photoPath).data.publicUrl;
}

async function avatarScriptHandler(req, res) {
  try {
    const { userId, topic, length, brand, description, sector, tone, style } = req.body;
    if (!(await userIsPaid(userId, req.authEmail))) return res.status(403).json({ error: 'I reel con il tuo avatar sono inclusi nei piani a pagamento' });
    const av = await getAvatar(userId);
    if (!av) return res.status(400).json({ error: 'Prima crea il tuo avatar caricando un video in cui parli' });
    const medium = length === 'medium';
    const ai = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
      messages: [{ role: 'user', content: `Sei un social media manager e copywriter italiano esperto di reel. Scrivi un reel in cui il titolare di "${brand || 'un brand'}" parla in camera come un presentatore.
Attività: ${description || ''}${sector ? ' — Settore: ' + sector : ''}. Tono: ${tone || 'amichevole'}. ${style ? 'Stile visivo e colori: ' + style + '.' : ''}
${topic && String(topic).trim() ? 'Argomento richiesto: ' + String(topic).trim() : 'Scegli tu un argomento utile e specifico per il suo pubblico (consiglio pratico, errore comune, dietro le quinte, caso tipico, domanda frequente) che porti nuovi contatti.'}
Testo parlato: ${medium ? '75-95 parole (circa 35 secondi)' : '45-60 parole (circa 20 secondi)'}, italiano naturale in prima persona, frasi brevi; la prima frase è un gancio forte; chiudi con un invito all'azione; niente emoji, hashtag o elenchi; numeri scritti in lettere.
Immagini di approfondimento (B-roll): ${medium ? 3 : 2} scene che compaiono mentre parla, per illustrare ciò che dice. Per ognuna: "at" = punto del testo in cui compare (numero da 0.2 a 0.85, crescente) e "prompt" = descrizione fotografica dettagliata in italiano (soggetto, ambiente, luce, inquadratura verticale), coerente con l'attività e lo stile, senza persone in primo piano e senza scritte.
Rispondi SOLO con JSON: {"title":"titolo a inizio video, massimo 6 parole","script":"testo parlato","broll":[{"at":0.3,"prompt":"..."}],"text":"testo del post: hook nella prima riga, 2-3 frasi, call to action, qualche emoji","hashtags":["5-8 hashtag senza #"],"objective":"Notorietà | Fiducia | Interazione | Conversione","why":"perché questo reel serve alla strategia, in una frase"}` }]
    });
    let meta;
    try { const t = ai.content.map(b => b.text || '').join(''); meta = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]); } catch (e) { throw new Error('Testo non generato, riprova'); }
    if (!meta.script) throw new Error('Testo non generato, riprova');
    const voice = await ttsWithVoice(meta.script, av.voice_url);
    res.json(Object.assign({ success: true }, meta, voice));
  } catch (e) {
    const msg = (e && (e.status || e.body)) ? falErrorMessage(e) : e.message;
    console.error('Testo avatar:', msg);
    res.status(500).json({ error: msg });
  }
}
app.post('/api/reel/avatar/script', (req, res) => runAsJob(req, res, avatarScriptHandler));

// nuova voce dopo che il cliente ha modificato il testo (costo minimo)
app.post('/api/reel/avatar/voice', async (req, res) => {
  try {
    const { userId, script } = req.body;
    const av = await getAvatar(userId);
    if (!av) return res.status(400).json({ error: 'Avatar non trovato' });
    if (!script || String(script).length > 1500) return res.status(400).json({ error: 'Testo mancante o troppo lungo' });
    res.json(Object.assign({ success: true }, await ttsWithVoice(String(script), av.voice_url)));
  } catch (e) { res.status(500).json({ error: (e && (e.status || e.body)) ? falErrorMessage(e) : e.message }); }
});

async function avatarRenderHandler(req, res) {
  const tmp = [];
  try {
    const { userId, script, title, text, hashtags, objective, why, broll, audio_url, brand, sector, style, socials, aiLabel } = req.body;
    if (!(await userIsPaid(userId, req.authEmail))) return res.status(403).json({ error: 'I reel con il tuo avatar sono inclusi nei piani a pagamento' });
    const av = await getAvatar(userId);
    if (!av) return res.status(400).json({ error: 'Avatar non trovato' });
    if (!audio_url || !String(audio_url).includes('/storage/v1/object/public/post-images/posts/voice-')) return res.status(400).json({ error: 'Prima prepara testo e voce' });

    // audio e foto
    const a = await axios.get(audio_url, { responseType: 'arraybuffer', timeout: 60000 });
    const audioPath = talking.tmpFile('.mp3'); tmp.push(audioPath); await fsp.writeFile(audioPath, Buffer.from(a.data));
    const D = await talking.probeDuration(audioPath);
    if (!D || D > 60) throw new Error('La voce dura ' + Math.round(D) + ' secondi: accorcia il testo (massimo 60 secondi)');
    const photo = await avatarPhotoUrl(av);

    // avatar che parla (gesti e espressioni naturali) e, in parallelo, le immagini di approfondimento
    const avatarJob = fal.subscribe(AVATAR_MODEL, { input: { image_url: photo, audio_url, prompt: 'A confident, friendly presenter talking directly to the camera for a social media reel, natural head movements and small hand gestures, the face and identity stay exactly the same as in the photo.' }, pollInterval: 5000 });
    const shots = (Array.isArray(broll) ? broll : []).slice(0, 3);
    const brollJob = Promise.all(shots.map(b => generateImage(`${b.prompt}${style ? '. Stile e colori: ' + style : ''}`, brand || 'Brand', { size: '1024x1536', quality: 'medium' }).catch(e => { console.log('B-roll non creato:', e.message); return null; })));
    const [avRes, brollUrls] = await Promise.all([avatarJob, brollJob]);
    const avPath = talking.tmpFile('.mp4'); tmp.push(avPath);
    const v = await axios.get(avRes.data.video.url, { responseType: 'arraybuffer', timeout: 180000 });
    await fsp.writeFile(avPath, Buffer.from(v.data));

    // tempi delle immagini: mai nei primi 3 secondi (gancio) né negli ultimi 4 (invito all'azione)
    const brolls = [];
    let lastEnd = 2.5;
    shots.forEach((b, i) => {
      if (!brollUrls[i]) return;
      const len = D > 28 ? 3 : 2.5;
      let start = Math.max(3, Math.min(D - 4 - len, (Number(b.at) || (0.3 + i * 0.25)) * D));
      if (start < lastEnd + 1.2) start = lastEnd + 1.2;
      if (start + len > D - 3.5) return;
      brolls.push({ url: brollUrls[i], start, end: start + len });
      lastEnd = start + len;
    });
    for (const b of brolls) {
      const f = talking.tmpFile('.png'); tmp.push(f);
      const r = await axios.get(b.url, { responseType: 'arraybuffer', timeout: 60000 });
      await fsp.writeFile(f, Buffer.from(r.data)); b.path = f;
    }

    // sottotitoli sincronizzati
    let words = [];
    try {
      const form = new FormData();
      form.append('file', new Blob([await fsp.readFile(audioPath)], { type: 'audio/mpeg' }), 'audio.mp3');
      form.append('model', 'whisper-1'); form.append('language', 'it');
      form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
      const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
      const tj = await tr.json(); if (tr.ok) words = tj.words || [];
    } catch (e) { console.log('Sottotitoli non disponibili:', e.message); }
    const acc = accentFromStyle(style);
    const ass = talking.buildAss(talking.groupWords(words), title || '', acc === '#ffffff' ? '#6D4AFF' : acc);

    const outPath = await talking.editAvatarReel(avPath, audioPath, brolls, ass, D); tmp.push(outPath);
    const thumbPath = await talking.thumbnail(outPath, 1.0); tmp.push(thumbPath);
    const videoName = `videos/${crypto.randomUUID()}.mp4`, thumbName = `posts/${crypto.randomUUID()}.jpg`;
    const up1 = await supabase.storage.from('post-images').upload(videoName, await fsp.readFile(outPath), { contentType: 'video/mp4', upsert: false });
    if (up1.error) throw new Error('Salvataggio video: ' + up1.error.message);
    await supabase.storage.from('post-images').upload(thumbName, await fsp.readFile(thumbPath), { contentType: 'image/jpeg', upsert: false });

    const rawSocial = Array.isArray(socials) ? socials.join(' + ') : String(socials || 'Instagram');
    let platforms = /tutti/i.test(rawSocial) ? ['Instagram', 'Facebook', 'TikTok'] : ['Instagram', 'Facebook', 'TikTok'].filter(n => new RegExp(n, 'i').test(rawSocial));
    if (!platforms.length) platforms = ['Instagram'];
    let caption = String(text || script || '');
    if (aiLabel !== false) caption += '\n\n🤖 Video realizzato con l\'AI a partire dalla mia voce e dalla mia immagine.';
    const post = {
      type: 'reel', social: platforms[0], socials: platforms, talking: true, ai_avatar: true, person_photo: true,
      text: caption, hashtags: Array.isArray(hashtags) ? hashtags.slice(0, 10) : [],
      objective: objective || 'Fiducia', why: why || '', overlay_title: title || '', transcript: script || '',
      video_url: supabase.storage.from('post-images').getPublicUrl(videoName).data.publicUrl,
      image_url: supabase.storage.from('post-images').getPublicUrl(thumbName).data.publicUrl,
      video_status: 'completed', day: 'Martedi', scheduled_time: '18:30', status: 'draft'
    };
    const { data: saved, error: sErr } = await supabase.from('strategies').insert({
      user_id: userId, brand: brand || '', sector: sector || '', strategy: { summary: 'Reel con il tuo avatar' }, posts: [post], created_at: new Date().toISOString()
    }).select('id').single();
    if (sErr) throw new Error('Salvataggio post: ' + sErr.message);
    res.json({ success: true, post, strategy_id: saved.id });
  } catch (e) {
    const msg = (e && (e.status || e.body)) ? falErrorMessage(e) : e.message;
    console.error('Video avatar:', msg);
    res.status(500).json({ error: msg });
  } finally { for (const f of tmp) fsp.unlink(f).catch(() => {}); }
}
app.post('/api/reel/avatar/render', (req, res) => runAsJob(req, res, avatarRenderHandler));



// ===== SCHEDULER =====
cron.schedule('20 4 * * *', refreshInstagramTokens);

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
  console.log(`📸 Instagram diretto: ${process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET ? '✅' : '❌ (manca INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET)'}`);
});
