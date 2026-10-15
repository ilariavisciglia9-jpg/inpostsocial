// ===== REEL CON LA VOCE ORIGINALE DEL CLIENTE =====
// Il cliente carica un breve video in cui parla: il video e la voce restano quelli veri.
// Qui lo portiamo in formato reel 9:16 (con sfondo sfocato se serve), aggiungiamo
// sottotitoli in italiano sincronizzati e un titolo iniziale, con un carattere vero.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: timeoutMs || 300000, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg: ' + String(stderr || err.message).slice(-400)));
      resolve();
    });
  });
}

// durata del video in secondi (letta dall'output di ffmpeg)
function probeDuration(file) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file], { timeout: 30000 }, (err, stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
    });
  });
}

function tmpFile(ext) { return path.join(os.tmpdir(), 'reel-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext); }

async function extractAudio(videoPath) {
  const out = tmpFile('.mp3');
  await run(['-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out]);
  return out;
}

async function thumbnail(videoPath, atSec) {
  const out = tmpFile('.jpg');
  await run(['-ss', String(atSec || 0.5), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', '-q:v', '3', out]);
  return out;
}

function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function assEscape(t) { return String(t || '').replace(/[{}\\]/g, '').replace(/\n/g, ' ').trim(); }
// colore #rrggbb -> &H00BBGGRR (formato ASS)
function assColor(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '&H00FFFFFF';
  return `&H${alpha || '00'}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

// parole con tempi -> blocchi di sottotitoli brevi (max 4 parole / 1,8 s), come nei reel professionali
function groupWords(words) {
  const out = [];
  let cur = null;
  for (const w of words || []) {
    const text = String(w.word || '').trim();
    if (!text) continue;
    if (!cur || cur.words.length >= 4 || w.start - cur.start > 1.8 || /[.!?]$/.test(cur.words[cur.words.length - 1])) {
      if (cur) out.push(cur);
      cur = { start: w.start, end: w.end, words: [text] };
    } else { cur.words.push(text); cur.end = w.end; }
  }
  if (cur) out.push(cur);
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    out[i].end = Math.max(out[i].end, out[i].start + 0.6);
    if (next && out[i].end > next.start) out[i].end = next.start;
  }
  return out;
}

function buildAss(chunks, title, accentHex) {
  const accent = assColor(accentHex || '#6D4AFF');
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // sottotitoli: bianchi con bordo nero, sopra l'area dei pulsanti di Instagram
    'Style: Sub,Montserrat ExtraBold,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,6,2,2,90,90,520,1',
    // titolo iniziale in alto, su riquadro nel colore del brand
    `Style: Title,Montserrat ExtraBold,70,&H00FFFFFF,&H00FFFFFF,${accent},${accent},0,0,0,0,100,100,0,0,3,22,0,8,90,90,230,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  if (title && String(title).trim()) {
    lines.push(`Dialogue: 1,${assTime(0.2)},${assTime(3.6)},Title,,0,0,0,,{\\fad(200,250)}${assEscape(String(title).toUpperCase())}`);
  }
  for (const c of chunks) {
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Sub,,0,0,0,,{\\fad(60,60)}${assEscape(c.words.join(' '))}`);
  }
  return lines.join('\n') + '\n';
}

// video del cliente -> reel 1080x1920 con sottotitoli e titolo; la voce originale resta intatta
async function renderReel(inputPath, assText, maxSeconds) {
  const assPath = tmpFile('.ass');
  const out = tmpFile('.mp4');
  fs.writeFileSync(assPath, assText, 'utf8');
  const fontsDir = path.join(__dirname, 'fonts');
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const filter =
    '[0:v]split=2[bgsrc][fgsrc];' +
    '[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.08[bg];' +
    '[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease[fg];' +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,ass='${esc(assPath)}':fontsdir='${esc(fontsDir)}'[v]`;
  try {
    await run(['-i', inputPath, '-t', String(maxSeconds || 90), '-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out], 600000);
  } finally { try { fs.unlinkSync(assPath); } catch (e) {} }
  return out;
}

module.exports = { extractAudio, thumbnail, groupWords, buildAss, renderReel, probeDuration, tmpFile };
