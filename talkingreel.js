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
async function renderReel(inputPath, assText, maxSeconds, opts) {
  opts = opts || {};
  const assPath = assText ? tmpFile('.ass') : null;
  const out = tmpFile('.mp4');
  if (assPath) fs.writeFileSync(assPath, assText, 'utf8');
  const fontsDir = path.join(__dirname, 'fonts');
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const subs = assPath ? `,ass='${esc(assPath)}':fontsdir='${esc(fontsDir)}'` : '';
  const filter =
    '[0:v]split=2[bgsrc][fgsrc];' +
    '[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.08[bg];' +
    '[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease[fg];' +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${subs}[v]`;
  const audioArgs = opts.noAudio ? ['-an'] : ['-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000'];
  try {
    await run(['-i', inputPath, '-t', String(maxSeconds || 90), '-filter_complex', filter, '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', opts.crf || '21', '-pix_fmt', 'yuv420p', '-r', '30',
      ...audioArgs, '-movflags', '+faststart', out], 600000);
  } finally { if (assPath) { try { fs.unlinkSync(assPath); } catch (e) {} } }
  return out;
}

// campione della voce (12 secondi puliti) per clonare il timbro
async function extractVoiceRef(videoPath, startSec, lenSec) {
  const out = tmpFile('.wav');
  await run(['-ss', String(startSec || 1), '-i', videoPath, '-t', String(lenSec || 12), '-vn', '-ac', '1', '-ar', '24000', '-af', 'highpass=f=70,loudnorm=I=-18:TP=-2', out]);
  return out;
}

// unisce più pezzi audio (frasi) in un unico file, con una piccola pausa tra le frasi
async function concatAudio(files) {
  const out = tmpFile('.mp3');
  if (files.length === 1) { await run(['-i', files[0], '-ac', '1', '-ar', '44100', '-b:a', '160k', out]); return out; }
  const inputs = [];
  let chain = '';
  files.forEach((f, i) => { inputs.push('-i', f); chain += `[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=0.18[a${i}];`; });
  chain += files.map((_, i) => `[a${i}]`).join('') + `concat=n=${files.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]`;
  await run([...inputs, '-filter_complex', chain, '-map', '[out]', '-ac', '1', '-b:a', '160k', out]);
  return out;
}

// montaggio "da agenzia": avatar che parla + immagini di approfondimento (B-roll) con zoom lento,
// voce continua, sottotitoli e titolo. brolls = [{ path, start, end }] in secondi.
async function editAvatarReel(avatarPath, audioPath, brolls, assText, duration) {
  const assPath = tmpFile('.ass');
  const out = tmpFile('.mp4');
  fs.writeFileSync(assPath, assText || '', 'utf8');
  const fontsDir = path.join(__dirname, 'fonts');
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const D = Math.max(3, duration || 20);
  const inputs = ['-stream_loop', '-1', '-i', avatarPath, '-i', audioPath];
  let fc = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[base0];';
  let last = 'base0';
  (brolls || []).forEach((b, i) => {
    const idx = i + 2, dur = Math.max(1.2, b.end - b.start), frames = Math.round(dur * 30);
    inputs.push('-loop', '1', '-t', String(dur), '-i', b.path);
    // zoom lento sull'immagine, comparsa e uscita in dissolvenza
    fc += `[${idx}:v]scale=1440:2560:force_original_aspect_ratio=increase,crop=1440:2560,` +
      `zoompan=z='min(zoom+0.0012,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,` +
      `format=yuva420p,fade=t=in:st=0:d=0.25:alpha=1,fade=t=out:st=${(dur - 0.25).toFixed(2)}:d=0.25:alpha=1,` +
      `setpts=PTS-STARTPTS+${b.start.toFixed(2)}/TB[b${i}];`;
    fc += `[${last}][b${i}]overlay=0:0:enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})'[base${i + 1}];`;
    last = `base${i + 1}`;
  });
  fc += `[${last}]ass='${esc(assPath)}':fontsdir='${esc(fontsDir)}'[v]`;
  try {
    await run([...inputs, '-filter_complex', fc, '-map', '[v]', '-map', '1:a', '-t', D.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out], 600000);
  } finally { try { fs.unlinkSync(assPath); } catch (e) {} }
  return out;
}

// divide la voce in pezzi da massimo maxSeg secondi, tagliando nelle pause (silenzi) tra le frasi
function silences(file) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-32dB:d=0.15', '-f', 'null', '-'], { timeout: 120000, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      const out = [], re = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g; let m;
      while ((m = re.exec(String(stderr || '')))) out.push((parseFloat(m[1]) + parseFloat(m[2])) / 2);
      resolve(out);
    });
  });
}
async function splitAudioAtPauses(audioPath, maxSeg) {
  maxSeg = maxSeg || 55;
  const D = await probeDuration(audioPath);
  const n = Math.ceil(D / maxSeg);
  const pauses = await silences(audioPath);
  const bounds = [0];
  for (let k = 1; k < n; k++) {
    const target = (D * k) / n, prev = bounds[bounds.length - 1];
    const ok = pauses.filter(p => p > prev + 5 && p < prev + maxSeg && p < D - 5);
    let cut = ok.length ? ok.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a) : Math.min(target, prev + maxSeg);
    bounds.push(cut);
  }
  bounds.push(D);
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const out = tmpFile('.mp3');
    await run(['-i', audioPath, '-ss', bounds[i].toFixed(3), '-to', bounds[i + 1].toFixed(3), '-ac', '1', '-ar', '44100', '-b:a', '160k', out]);
    segs.push({ path: out, start: bounds[i], end: bounds[i + 1] });
  }
  return segs;
}

// unisce più video dell'avatar uno dopo l'altro (stesso formato 1080x1920, 30 fps)
async function concatVideos(files) {
  const out = tmpFile('.mp4');
  const inputs = [];
  let fc = '';
  files.forEach((f, i) => { inputs.push('-i', f); fc += `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v${i}];`; });
  fc += files.map((_, i) => `[v${i}]`).join('') + `concat=n=${files.length}:v=1:a=0[v]`;
  await run([...inputs, '-filter_complex', fc, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out], 600000);
  return out;
}

module.exports = { splitAudioAtPauses, concatVideos, extractAudio, thumbnail, groupWords, buildAss, renderReel, probeDuration, tmpFile, extractVoiceRef, concatAudio, editAvatarReel };
