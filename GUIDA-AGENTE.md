# InPostSocial.ai — Attivare l'Agente AI

## 0. URGENTE — sicurezza
La chiave Supabase che era in `dashboard.html` e `login.html` era la **service_role**
(accesso totale al database, token Meta compresi). Era pubblica sul sito e su GitHub.
1. Supabase → Project Settings → API → **rigenera** la chiave service_role (JWT secret / "Roll").
2. Metti la nuova service_role SOLO su Railway (`SUPABASE_SERVICE_KEY`).
3. Copia la chiave **anon public** e incollala in `dashboard.html` e `login.html`
   al posto di `INCOLLA_QUI_LA_ANON_KEY`.

## 1. Database
Supabase → SQL Editor → incolla tutto `schema-agent.sql` → Run.
Nel bucket Storage `post-images` controlla che siano ammessi anche i file `video/mp4`.

## 2. Stripe — 3 prezzi mensili ricorrenti
Prodotti → crea Starter 29€, Pro 79€, Business 199€ (mensili). Copia i 3 `price_...`.
Webhook: aggiungi l'evento `customer.subscription.updated` (oltre a quelli già presenti).

## 3. Railway → Variables
Aggiungi/aggiorna (vedi `.env.example`):
`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`,
`OPENAI_API_KEY`, `FAL_KEY`, `AGENT_MODEL` (facoltativo), `OWNER_EMAIL`.

## 4. Carica i file su GitHub
Nuovi: `agent.js`, `schema-agent.sql`, `GUIDA-AGENTE.md`.
Modificati: `server.js`, `dashboard.html`, `login.html`, `index.html`, `.env.example`.
Railway fa il deploy da solo.

## 5. Meta — App Review (per i clienti veri)
Finché l'app Meta è in modalità sviluppo funziona solo per gli account tester.
Per aprirla al pubblico chiedi in App Review questi permessi:
`instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
`instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
Serve un video che mostra il flusso (collega → agente crea → pubblica → risponde).

## 6. Passaggio a inpostsocial.ai
Quando compri il dominio:
- Railway → Settings → Domains → aggiungi `inpostsocial.ai` e imposta i DNS indicati.
- `FRONTEND_URL=https://inpostsocial.ai` su Railway.
- Meta → Facebook Login → Redirect URI validi: `https://inpostsocial.ai/auth/callback`.
- Supabase → Authentication → URL Configuration: Site URL e Redirect URLs col nuovo dominio.
- Stripe → webhook con il nuovo dominio.

## Come lavora l'agente (orari di Roma)
| Quando | Cosa fa |
|---|---|
| Ogni giorno alle 6:00 | Riempie i prossimi 7 giorni di post secondo il piano |
| Ogni 5 minuti | Crea immagini/video e pubblica i post arrivati all'orario |
| Ogni 30 minuti | Risponde ai commenti (Pro ogni 2 ore, Business ogni 30 min) |
| Lunedì alle 8:15 | Report (Starter il primo lunedì del mese) |

I limiti dei piani si cambiano in cima ad `agent.js` (oggetto `PLANS`).
