/* =========================================
   INPOSTSOCIAL — main.js
   ========================================= */

// ========== LANGUAGE SYSTEM ==========
let currentLang = 'it';

function setLang(lang) {
  currentLang = lang;
  document.querySelectorAll('[data-it]').forEach(el => {
    const text = el.getAttribute('data-' + lang);
    if (text) el.innerHTML = text;
  });
  document.querySelectorAll('[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });
  document.querySelectorAll('[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });
}

document.querySelectorAll('.lang-btn, .lang-btn-footer').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang')));
});

// ========== HEADER SCROLL ==========
window.addEventListener('scroll', () => {
  document.getElementById('header').classList.toggle('scrolled', window.scrollY > 20);
});

// ========== HAMBURGER ==========
document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('mobile-menu').classList.toggle('open');
});
document.querySelectorAll('.mobile-menu a').forEach(a => {
  a.addEventListener('click', () => document.getElementById('mobile-menu').classList.remove('open'));
});

// ========== SMOOTH SCROLL ==========
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ========== FAQ ==========
function toggleFaq(btn) {
  const answer = btn.nextElementSibling;
  const isOpen = answer.classList.contains('open');
  document.querySelectorAll('.faq-a').forEach(a => a.classList.remove('open'));
  document.querySelectorAll('.faq-q').forEach(q => q.classList.remove('open'));
  if (!isOpen) {
    answer.classList.add('open');
    btn.classList.add('open');
  }
}

// ========== TAB SYSTEM ==========
function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  document.querySelector(`.tab-btn[onclick="showTab('${tab}')"]`).classList.add('active');
  document.getElementById('tab-' + tab).style.display = 'block';
}

// ========== CONTACT FORM ==========
function submitContact(e) {
  e.preventDefault();
  const name = document.getElementById('c-name').value;
  const email = document.getElementById('c-email').value;
  const message = document.getElementById('c-message').value;
  if (!name || !email || !message) return;
  // Simulate send
  document.getElementById('form-success').style.display = 'block';
  document.getElementById('contact-form').reset();
  setTimeout(() => document.getElementById('form-success').style.display = 'none', 5000);
}

// ========== DEMO AI ==========
async function runDemo() {
  const brand = document.getElementById('demo-brand').value.trim();
  const desc = document.getElementById('demo-desc').value.trim();
  if (!brand || !desc) {
    alert(currentLang === 'it' ? 'Inserisci almeno nome e descrizione!' : 'Please enter at least name and description!');
    return;
  }

  const sector = document.getElementById('demo-sector').value;
  const tone = document.getElementById('demo-tone').value;

  // Show loading
  document.getElementById('demo-result').style.display = 'none';
  document.getElementById('demo-loading').style.display = 'block';
  document.getElementById('demo-btn').disabled = true;

  const steps = ['ls1', 'ls2', 'ls3', 'ls4'];
  steps.forEach((s, i) => setTimeout(() => {
    steps.forEach(x => document.getElementById(x).classList.remove('active'));
    document.getElementById(s).classList.add('active');
    if (i > 0) document.getElementById(steps[i - 1]).classList.add('done');
  }, i * 4000));

  const prompt = `Sei un esperto social media manager italiano. Crea una strategia social e dei post per questo business.

BRAND: ${brand}
SETTORE: ${sector}
DESCRIZIONE: ${desc}
TONO: ${tone}

Rispondi SOLO con JSON valido senza testo fuori:
{
  "strategy": {
    "summary": "Sintesi strategica 2-3 frasi",
    "target": "Pubblico target ideale",
    "pillars": ["Pillar 1", "Pillar 2", "Pillar 3", "Pillar 4"],
    "best_times": "Orari migliori per pubblicare"
  },
  "posts": [
    {
      "social": "Instagram",
      "day": "Lunedì",
      "text": "Testo completo del post con emoji e call to action",
      "hashtags": ["hashtag1", "hashtag2", "hashtag3", "hashtag4", "hashtag5"]
    },
    {
      "social": "Facebook",
      "day": "Mercoledì",
      "text": "Testo post Facebook ottimizzato per la piattaforma...",
      "hashtags": ["hashtag1", "hashtag2", "hashtag3"]
    },
    {
      "social": "Instagram",
      "day": "Venerdì",
      "text": "Terzo post Instagram coinvolgente...",
      "hashtags": ["hashtag1", "hashtag2", "hashtag3", "hashtag4"]
    }
  ]
}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await resp.json();
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    renderDemo(parsed, brand);
  } catch (e) {
    renderDemo(getDemoFallback(brand, sector), brand);
  }

  document.getElementById('demo-loading').style.display = 'none';
  document.getElementById('demo-result').style.display = 'block';
  document.getElementById('demo-btn').disabled = false;
  document.getElementById('demo-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderDemo(data, brand) {
  const s = data.strategy;
  const pillarsHTML = s.pillars.map(p => `<li>${p}</li>`).join('');
  document.getElementById('tab-strategy').innerHTML = `
    <div class="strategy-summary">
      <h4>🎯 Strategia per ${brand}</h4>
      <p>${s.summary}</p>
    </div>
    <div class="strategy-blocks">
      <div class="s-block">
        <h5>👥 Target Audience</h5>
        <p>${s.target}</p>
      </div>
      <div class="s-block">
        <h5>📌 Content Pillars</h5>
        <ul>${pillarsHTML}</ul>
      </div>
      <div class="s-block" style="grid-column:span 2">
        <h5>⏰ Orari migliori</h5>
        <p>${s.best_times}</p>
      </div>
    </div>`;

  const socialEmoji = { Instagram: '📸', Facebook: '📘', TikTok: '🎵', LinkedIn: '💼' };
  document.getElementById('tab-posts').innerHTML = data.posts.map(p => `
    <div class="post-card-demo">
      <div class="post-card-demo-header">
        <div class="post-social-tag">${socialEmoji[p.social] || '📱'} ${p.social}</div>
        <span class="post-day-tag">📅 ${p.day}</span>
      </div>
      <div class="post-card-demo-body">
        <div class="post-text-demo">${p.text}</div>
        <div class="hashtags-demo">${p.hashtags.map(h => `<span class="hashtag-demo">#${h.replace('#', '')}</span>`).join('')}</div>
      </div>
    </div>`).join('');
}

function getDemoFallback(brand, sector) {
  return {
    strategy: {
      summary: `Strategia social per ${brand} nel settore ${sector}. Focus su contenuti di valore, autenticità e coinvolgimento del pubblico target per costruire una community fedele.`,
      target: "Adulti 25-45 anni, interessati al settore, con potere d'acquisto medio-alto. Attivi sui social nelle fasce 12-14 e 19-22.",
      pillars: ["Educational: contenuti che informano e educano", "Behind the scenes: mostra il lavoro quotidiano", "Testimonianze: recensioni clienti soddisfatti", "Promozioni: offerte e novità del brand"],
      best_times: "Martedì, Mercoledì, Venerdì: 11:00-13:00 e 19:00-21:00. Domenica mattina per contenuti ispirazionali."
    },
    posts: [
      { social: "Instagram", day: "Lunedì", text: `✨ Ogni giorno ci impegniamo per offrirti il meglio.\n\nIn ${brand} la qualità non è mai un compromesso. Scopri perché migliaia di clienti si fidano di noi ogni giorno. 💪\n\nVisita il nostro sito → link in bio!`, hashtags: ["qualità", "eccellenza", "madeinitaly", "professionalità", brand.toLowerCase().replace(/\s/g, '')] },
      { social: "Facebook", day: "Mercoledì", text: `🌟 Ciao amici di ${brand}!\n\nOggi vogliamo raccontarvi una cosa che ci rende davvero orgogliosi: ogni giorno lavoriamo con passione per garantirvi un'esperienza unica.\n\nHai domande? Scrivici nei commenti! 😊`, hashtags: ["community", "passione", "qualità"] },
      { social: "Instagram", day: "Venerdì", text: `🎉 Venerdì = il giorno perfetto per premiarsi!\n\nE noi di ${brand} siamo qui per rendere il tuo weekend ancora più speciale. Cosa hai in programma? Diccelo nei commenti! 👇`, hashtags: ["venerdì", "weekend", "lifestyle", "felicità", sector.toLowerCase()] }
    ]
  };
}

// ========== SCROLL ANIMATIONS ==========
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.step-card, .feature-card, .review-card, .pricing-card, .faq-item').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  observer.observe(el);
});
