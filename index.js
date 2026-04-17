const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY  = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || '';

let bazaBrojeva = [];
let zadnjiSms   = null;
const invoices  = {};

function parseSms(raw) {
    if (!raw) return null;
    if (raw.includes('Känsligt') || raw.includes('dolt')) return null;
    const m = raw.match(/\d{4,8}/);
    return m ? m[0] : raw.trim();
}

const HTML = () => {
    const stavke = bazaBrojeva.map(b => `
        <div class="market-item">
            <div style="text-align:left">
                <span style="font-size:10px;color:#ff9500;display:block">${b.countryCode}</span>
                <span style="font-size:15px;color:#eee;font-weight:bold">${b.broj}</span>
            </div>
            <button onclick="buy(${b.cena},'${b.id}')" class="buy-btn">${b.cena} sats</button>
        </div>`).join('');

    return `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMSNERO ⚡</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0b0b0b;color:#fff;font-family:sans-serif;text-align:center;padding:20px;min-height:100vh}
  h1{font-style:italic;font-size:32px;margin-bottom:5px;letter-spacing:-1px}
  .node{color:#0f0;font-size:13px;margin-bottom:15px;display:flex;align-items:center;justify-content:center;gap:5px}
  .dot{height:8px;width:8px;background:#0f0;border-radius:50%;display:inline-block;animation:blink 2s infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
  .nav{display:flex;justify-content:center;gap:8px;margin-bottom:25px;flex-wrap:wrap}
  .nav-btn{background:#1a1a1a;border:none;color:#666;padding:12px 20px;border-radius:12px;font-weight:bold;font-size:11px;cursor:pointer;transition:.15s}
  .nav-btn.active{background:#222!important;color:#ff9500!important;border:1px solid #333}
  .card{background:#151515;max-width:420px;margin:auto;padding:25px;border-radius:25px;border:1px solid #222;min-height:300px}
  .section{display:none}.section.show{display:block}
  .market-item{background:#1a1a1a;margin:10px 0;padding:15px;border-radius:15px;display:flex;justify-content:space-between;align-items:center;border:1px solid #2a2a2a}
  .buy-btn{background:none;border:1px solid #ff9500;color:#ff9500;padding:8px 15px;border-radius:10px;cursor:pointer;font-weight:bold;transition:.15s}
  .buy-btn:hover{background:#ff950020}
  input,select{background:#000;border:1px solid #333;color:#fff;padding:12px;width:100%;border-radius:10px;margin-bottom:10px;font-size:14px}
  .btn-main{background:#ff9500;color:#000;border:none;width:100%;padding:15px;border-radius:12px;font-weight:bold;cursor:pointer;font-size:15px;margin-top:4px;transition:.15s}
  .btn-main:hover{background:#ffaa22}
  .btn-main:disabled{background:#333;color:#666;cursor:not-allowed}

  /* MODAL */
  .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);backdrop-filter:blur(6px);z-index:200;align-items:center;justify-content:center;padding:20px}
  .overlay.show{display:flex}
  .modal{background:#151515;border:1px solid #2a2a2a;border-radius:22px;padding:28px 22px;width:100%;max-width:360px;text-align:center;position:relative;animation:pop .2s ease}
  @keyframes pop{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}
  .modal-title{color:#ff9500;margin-bottom:16px;font-size:1rem;letter-spacing:1px;font-weight:bold}
  .close-x{position:absolute;top:12px;right:16px;background:none;border:none;color:#555;font-size:1.3rem;cursor:pointer;line-height:1}
  .close-x:hover{color:#fff}

  /* QR */
  #qr-box{background:#ffffff;border-radius:14px;padding:14px;display:inline-block;margin-bottom:14px;line-height:0}
  #qr-box img{display:block}
  .inv-meta{font-size:11px;color:#555;margin-bottom:12px;line-height:1.6}
  .inv-meta b{color:#ff9500}

  /* buttons row */
  .btn-row{display:flex;gap:8px;margin-top:12px}
  .btn-row a{flex:1;text-decoration:none}
  .btn-outline{display:block;border:1px solid #ff9500;color:#ff9500;background:none;padding:11px 8px;border-radius:10px;font-size:12px;font-weight:bold;cursor:pointer;transition:.15s;width:100%;text-align:center}
  .btn-outline:hover{background:#ff950018}

  /* spinner */
  .spin{display:inline-block;width:15px;height:15px;border:2px solid #2a2a2a;border-top-color:#ff9500;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:5px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .wait-txt{color:#555;font-size:13px;margin-top:12px}

  /* OTP */
  .otp-big{font-size:2.8rem;letter-spacing:10px;color:#ff9500;background:#000;border:2px dashed #ff9500;border-radius:14px;padding:24px 10px;margin:14px 0 20px;font-family:monospace}
</style>
</head>
<body>

<h1>SMSNERO ⚡</h1>
<div class="node"><span class="dot"></span> Node: Online</div>

<div class="nav">
  <button class="nav-btn" onclick="tab('receive',this)">RECEIVE</button>
  <button class="nav-btn active" onclick="tab('market',this)">P2P MARKET</button>
  <button class="nav-btn" onclick="tab('rent',this)">RENT</button>
</div>

<div class="card">
  <div id="receive" class="section">
    <h2 style="color:#ff9500;margin-bottom:10px">Direct Receive</h2>
    <p style="color:#555;margin-bottom:16px">Enter your target number to check for SMS.</p>
    <input type="text" placeholder="Phone number...">
    <button class="btn-main" style="background:#1e1e1e;color:#eee">Check Now</button>
  </div>

  <div id="market" class="section show">
    <h3 style="margin:0 0 14px;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px">Admin Panel</h3>
    <select id="country">
      <option value="RS">🇷🇸 Serbia</option>
      <option value="SE">🇸🇪 Sweden</option>
      <option value="DE">🇩🇪 Germany</option>
      <option value="US">🇺🇸 USA</option>
      <option value="GB">🇬🇧 UK</option>
      <option value="FR">🇫🇷 France</option>
    </select>
    <input id="num" placeholder="Phone Number">
    <input id="prc" type="number" placeholder="Price in sats" min="1">
    <button class="btn-main" onclick="postToMarket()">POST TO MARKET</button>
    <hr style="border:none;border-top:1px solid #1e1e1e;margin:20px 0">
    ${stavke || '<p style="color:#333;padding:20px 0;font-size:13px">No numbers listed yet.</p>'}
  </div>

  <div id="rent" class="section">
    <h2 style="color:#ff9500;margin-bottom:12px">Rent Number</h2>
    <p style="color:#555;margin-bottom:16px">Long-term rentals (7–30 days).</p>
    <div class="market-item"><span>Private UK (+44)</span><button class="buy-btn" onclick="buy(5000,'rent-uk')">5000 sats</button></div>
    <div class="market-item"><span>Private DE (+49)</span><button class="buy-btn" onclick="buy(4500,'rent-de')">4500 sats</button></div>
  </div>
</div>

<!-- MODAL -->
<div class="overlay" id="overlay">
  <div class="modal">
    <button class="close-x" onclick="closeModal()">✕</button>

    <!-- Ekran 1: QR plaćanje -->
    <div id="sc-qr">
      <div class="modal-title">⚡ PLATI LIGHTNING</div>

      <!-- QR slika generisana serverom (uvek radi, ne zavisi od JS biblioteke) -->
      <div id="qr-box">
        <img id="qr-img" src="" width="200" height="200" alt="QR kod za plaćanje">
      </div>

      <div class="inv-meta">
        Iznos: <b id="qr-amount">-</b> sats &nbsp;·&nbsp; ID: <b id="qr-id">...</b>
      </div>

      <div class="wait-txt"><span class="spin"></span>Čekam uplatu...</div>

      <div class="btn-row">
        <!-- Wallet deeplink (radi na mobu, na desktopu ignoriše se) -->
        <a id="link-wallet" href="#" target="_blank">
          <span class="btn-outline">📱 Wallet app</span>
        </a>
        <!-- Swiss checkout stranica (radi svuda) -->
        <a id="link-web" href="#" target="_blank">
          <span class="btn-outline">🌐 Plati web</span>
        </a>
      </div>
    </div>

    <!-- Ekran 2: Čekam SMS -->
    <div id="sc-wait" style="display:none">
      <div class="modal-title">💸 UPLATA OK!</div>
      <p class="wait-txt" style="margin-top:14px"><span class="spin"></span>Čekam SMS kod...</p>
    </div>

    <!-- Ekran 3: OTP prikazan -->
    <div id="sc-otp" style="display:none">
      <div class="modal-title">✅ TVOJ KOD:</div>
      <div class="otp-big" id="otp-val">----</div>
      <button class="btn-main" onclick="closeModal()">ZATVORI</button>
    </div>
  </div>
</div>

<script>
  var pollTimer = null;

  function tab(id, btn) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('show'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('show');
    btn.classList.add('active');
  }

  function screen(name) {
    ['qr','wait','otp'].forEach(s => {
      document.getElementById('sc-'+s).style.display = (s === name) ? 'block' : 'none';
    });
    document.getElementById('overlay').classList.add('show');
  }

  function closeModal() {
    document.getElementById('overlay').classList.remove('show');
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function postToMarket() {
    const num     = document.getElementById('num').value.trim();
    const price   = document.getElementById('prc').value.trim();
    const country = document.getElementById('country').value;
    if (!num || !price) { alert('Popuni broj i cenu!'); return; }
    await fetch('/admin/add', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ broj: num, cena: price, country })
    });
    location.reload();
  }

  async function buy(amount, itemId) {
    // Odmah otvori modal sa loading stanjem
    screen('qr');
    document.getElementById('qr-amount').textContent = amount;
    document.getElementById('qr-id').textContent = '...';
    // Prazan QR dok čekamo server
    document.getElementById('qr-img').src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    try {
      const r = await fetch('/api/create-inv', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ amount, itemId })
      });
      const d = await r.json();

      if (!d.pr || !d.id) {
        alert('Greška: ' + (d.error || 'Server nije vratio invoice'));
        closeModal();
        return;
      }

      // QR generišemo SERVER-SIDE putem Google Charts API
      // → uvek radi, nema canvas problema, nema JS zavisnosti
      const qrData = encodeURIComponent('lightning:' + d.pr);
      document.getElementById('qr-img').src =
        'https://api.qrserver.com/v1/create-qr-code/?size=200x200&ecc=M&margin=2&data=' + qrData;

      document.getElementById('qr-id').textContent = d.id.slice(0,8) + '...';

      // Wallet deeplink (mobilni)
      document.getElementById('link-wallet').href = 'lightning:' + d.pr;
      // Web fallback (desktop i mobilni)
      document.getElementById('link-web').href = d.checkoutUrl || '#';

      startPoll(d.id);

    } catch(e) {
      alert('Greška veze: ' + e.message);
      closeModal();
    }
  }

  function startPoll(id) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/check-inv/' + id);
        const d = await r.json();
        if (d.paid && d.code) {
          clearInterval(pollTimer);
          document.getElementById('otp-val').textContent = d.code;
          screen('otp');
        } else if (d.paid) {
          screen('wait');
        }
      } catch(e) {}
    }, 2500);
  }
</script>
</body>
</html>`;
};

// ── ROUTES ────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.send(HTML()));

app.post('/admin/add', (req, res) => {
    bazaBrojeva.push({
        id: Date.now().toString(),
        broj: req.body.broj,
        cena: parseInt(req.body.cena),
        countryCode: req.body.country
    });
    res.sendStatus(200);
});

app.post('/api/create-inv', async (req, res) => {
    const { amount } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Nema iznosa' });

    try {
        const { data } = await axios.post(
            'https://api.swiss-bitcoin-pay.ch/checkout',
            {
                amount: parseInt(amount),
                unit: 'sat',
                title: 'SMS Kod',
                description: 'SMSNERO pristupni kod',
                delay: 15,
                webhook: { url: BASE_URL + '/api/webhook' }
            },
            {
                headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );

        const { id, pr, checkoutUrl } = data;

        if (!id || !pr) {
            console.error('[create-inv] Swiss nije vratio id/pr:', data);
            return res.status(500).json({ error: 'Swiss API nije vratio Lightning invoice' });
        }

        invoices[id] = { paid: false, code: null, createdAt: Date.now() };
        console.log('[invoice created]', id);
        res.json({ id, pr, checkoutUrl });

    } catch (e) {
        const msg = e.response?.data?.message || e.message;
        console.error('[create-inv error]', msg, e.response?.data);
        res.status(500).json({ error: msg });
    }
});

app.post('/api/webhook', (req, res) => {
    const { id, isPaid, status } = req.body;
    console.log('[webhook]', id, status, isPaid);
    if (id && invoices[id] && (isPaid === true || status === 'paid' || status === 'confirmed')) {
        invoices[id].paid = true;
        if (!invoices[id].code && zadnjiSms) invoices[id].code = zadnjiSms;
    }
    res.sendStatus(200);
});

app.get('/api/check-inv/:id', async (req, res) => {
    const { id } = req.params;
    const inv = invoices[id];
    if (!inv) return res.json({ paid: false, code: null });

    if (inv.paid) {
        if (!inv.code && zadnjiSms) inv.code = zadnjiSms;
        return res.json({ paid: true, code: inv.code });
    }

    // Fallback: pitaj Swiss direktno
    try {
        const { data } = await axios.get(
            `https://api.swiss-bitcoin-pay.ch/checkout/${id}`,
            { timeout: 8000 }
        );
        if (data.isPaid) {
            inv.paid = true;
            if (!inv.code && zadnjiSms) inv.code = zadnjiSms;
        }
    } catch (e) {
        console.error('[check-inv error]', e.message);
    }

    res.json({ paid: inv.paid, code: inv.code });
});

app.post('/api/incoming-sms', (req, res) => {
    const raw = req.body.message || req.body.text || '';
    const kod = parseSms(raw);
    if (!kod) return res.send('OK');
    zadnjiSms = kod;
    console.log('[sms]', zadnjiSms);
    for (const id in invoices) {
        if (invoices[id].paid && !invoices[id].code) invoices[id].code = zadnjiSms;
    }
    res.send('OK');
});

setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const id in invoices) {
        if (invoices[id].createdAt < cutoff) delete invoices[id];
    }
}, 30 * 60 * 1000);

app.listen(process.env.PORT || 10000, () =>
    console.log('SMSNERO ⚡ port', process.env.PORT || 10000)
);
