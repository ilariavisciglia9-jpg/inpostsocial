# InPostSocial — come attivare la pubblicazione reale e i video

Ti ho preparato tutto il backend. Tu devi solo registrarti sui 3 servizi,
prendere le chiavi e incollarle. Segui l'ordine.

## 1. Chiave Anthropic (per la generazione testi/strategia)
1. Vai su console.anthropic.com → API Keys → crea una nuova chiave.
2. Copiala, la userai al punto 4.

## 2. Account Upload-Post (per pubblicare davvero su Instagram/Facebook/TikTok)
1. Registrati su upload-post.com.
2. Dashboard → API Keys → genera la tua chiave.
3. Nota: per pubblicare su TikTok serve un piano a pagamento (non quello gratuito).
4. Non devi creare tu un'app su Meta for Developers: Upload-Post ha già la sua
   app approvata, quindi i tuoi clienti collegano l'account in pochi secondi
   senza che tu debba passare la revisione di Meta.

## 3. Video: nessun servizio a pagamento
Non serve registrarsi da nessuna parte per i video. Il backend li genera da
solo con FFmpeg (incluso gratis nel progetto), quindi zero costi esterni:
paghi solo il normale hosting Railway che hai già.

## 4. Inserisci le chiavi nel backend
Apri il file `.env.example`, fai una copia e chiamala `.env`, poi sostituisci
i valori con le tue chiavi vere:

```
ANTHROPIC_API_KEY=la-tua-chiave-anthropic
UPLOADPOST_API_KEY=la-tua-chiave-upload-post
FRONTEND_URL=https://www.inpostsocial.com
```

**Il file `.env` non va mai caricato su GitHub** (contiene le chiavi segrete).

## 5. Metti il backend online (Railway)
1. Crea un nuovo progetto su Railway.
2. Collega questa cartella (`inpostsocial-backend`) tramite GitHub, oppure
   trascina i file direttamente se Railway te lo permette.
3. Su Railway vai in "Variables" e inserisci le stesse 3 chiavi del punto 4
   (Railway non legge il file `.env`, le variabili vanno messe lì).
4. Railway ti darà un URL pubblico tipo
   `https://inpostsocial-backend-production.up.railway.app`.

## 6. Collega il sito al backend
Nel file `main.js` del tuo sito, in cima, c'è questa riga:

```js
const BACKEND_URL = 'https://TUO-BACKEND.up.railway.app';
```

Sostituisci con l'URL vero che Railway ti ha dato al punto 5. Poi carica il
`main.js` aggiornato al posto di quello vecchio.

## 7. Come collegare un cliente a Instagram (flusso reale)
Quando un cliente clicca "Connetti Instagram" nella tua dashboard, chiama:

```js
connectSocialAccount(idDelCliente); // es. l'id utente su Supabase
```

Questo lo porta sulla pagina ufficiale dove autorizza Instagram/Facebook/
TikTok. Da quel momento il suo account è collegato per sempre (finché non
lo scollega lui).

## 8. Come pubblicare un post vero
```js
await publishPost(
  idDelCliente,
  ['instagram', 'facebook'],
  'Testo del post generato dall\'AI',
  'https://url-pubblico-immagine.jpg',
  'photo'
);
```

## 9. Come generare e pubblicare un video
```js
const video = await generateVideoPost('Testo del post', 'https://url-immagine.jpg', 'Nome Brand');
if (video.success) {
  await publishPost(idDelCliente, ['instagram'], 'Didascalia', video.videoUrl, 'video');
}
```

Il video generato è verticale (1080x1920, formato Reel/Story), con
l'immagine come sfondo per 6 secondi e il testo del post sovrapposto su una
fascia semi-trasparente in basso — tutto generato gratis con FFmpeg, incluso
nel progetto (font Roboto incluso nella cartella `assets/`). Se vuoi
cambiare colori, durata o posizione del testo, si modifica nel file
`routes/video.js`.

Nota: più avanti, se vorrai animazioni più elaborate (transizioni, testo che
si muove, più scene), esistono alternative economiche a Creatomate come
Remotion (a consumo, circa 0,01$ a video) — ma per iniziare questa versione
gratuita è sufficiente.

## Nota importante sui requisiti Instagram
Ogni cliente deve avere un account Instagram **Business o Creator**,
collegato a una **Pagina Facebook**. Se ha un account personale, la
connessione o la pubblicazione falliranno finché non lo converte (è
gratis e si fa dall'app Instagram in 2 minuti — lo dici già nella tua FAQ).
