const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const API_KEY  = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || '';

// ── Podaci ────────────────────────────────────────────────────────────────
let bazaBrojeva = [];
let zadnjiSms   = null;
// invoiceId → { paid, code }
const invoices  = {};

// ── Čišćenje SMS-a ────────────────────────────────────────────────────────
function parseSms(raw) {
    if (!raw) return null;
    if (raw.includes('Känsligt') || raw.includes('dolt')) return null;
    const m = raw.match(/\d{4,8}/);
    return m ? m[0] : raw.trim();
}

// ── HTML ──────────────────────────────────────────────────────────────────
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
  .dot{height:8px;width:8px;background:#0f0;border-radius:50%;display:inline-block}
  .nav{display:flex;justify-content:center;gap:8px;margin-bottom:25px;flex-wrap:wrap}
  .nav-btn{background:#1a1a1a;border:none;color:#666;padding:12px 20px;border-radius:12px;font-weight:bold;font-size:11px;cursor:pointer}
  .nav-btn.active{background:#222!important;color:#ff9500!important;border:1px solid #333}
  .card{background:#151515;max-width:420px;margin:auto;padding:25px;border-radius:25px;border:1px solid #222;min-height:300px}
  .section{display:none}.section.show{display:block}
  .market-item{background:#1a1a1a;margin:10px 0;padding:15px;border-radius:15px;display:flex;justify-content:space-between;align-items:center;border:1px solid #2a2a2a}
  .buy-btn{background:none;border:1px solid #ff9500;color:#ff9500;padding:8px 15px;border-radius:10px;cursor:pointer;font-weight:bold}
  .buy-btn:disabled{border-color:#444;color:#444;cursor:not-allowed}
  input,select{background:#000;border:1px solid #333;color:#fff;padding:12px;width:100%;border-radius:10px;margin-bottom:10px;font-size:14px}
  .btn-main{background:#ff9500;color:#000;border:none;width:100%;padding:15px;border-radius:12px;font-weight:bold;cursor:pointer;font-size:15px;margin-top:4px}
  .btn-main:disabled{background:#333;color:#666;cursor:not-allowed}

  /* ── MODAL ── */
  .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);backdrop-filter:blur(5px);z-index:200;align-items:center;justify-content:center;padding:20px}
  .overlay.show{display:flex}
  .modal{background:#151515;border:1px solid #333;border-radius:22px;padding:28px 22px;width:100%;max-width:350px;text-align:center;position:relative;animation:pop .2s ease}
  @keyframes pop{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}
  .modal h3{color:#ff9500;margin-bottom:16px;font-size:1rem;letter-spacing:1px}
  .close-x{position:absolute;top:12px;right:16px;background:none;border:none;color:#555;font-size:1.3rem;cursor:pointer}
  .close-x:hover{color:#fff}

  /* QR */
  #qr-wrap{background:#fff;border-radius:12px;padding:12px;display:inline-block;margin-bottom:14px}
  #qr-wrap canvas,#qr-wrap img{display:block;width:190px!important;height:190px!important}
  .inv-small{font-size:10px;color:#444;word-break:break-all;margin-bottom:12px;line-height:1.5}
  .inv-small span{color:#ff9500}
  .wallet-link{display:block;margin-top:10px;color:#ff9500;font-size:13px;text-decoration:none;border:1px solid #ff9500;padding:10px;border-radius:10px}
  .wallet-link:hover{background:#ff950015}

  /* spinner */
  .spin{display:inline-block;width:16px;height:16px;border:2px solid #333;border-top-color:#ff9500;border-radius:50%;animation:s .7s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
  #wait-msg{color:#666;font-size:13px;margin-top:10px}

  /* OTP */
  .otp-big{font-size:2.6rem;letter-spacing:8px;color:#ff9500;background:#000;border:2px dashed #ff9500;border-radius:14px;padding:22px 10px;margin:12px 0 20px;font-family:monospace}
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
  <!-- RECEIVE -->
  <div id="receive" class="section">
    <h2 style="color:#ff9500;margin-bottom:10px">Direct Receive</h2>
    <p style="color:#666;margin-bottom:16px">Enter your target number to check for SMS.</p>
    <input type="text" placeholder="Check SMS for number...">
    <button class="btn-main" style="background:#222;color:#eee">Check Now</button>
  </div>

  <!-- MARKET -->
  <div id="market" class="section show">
    <h3 style="margin:0 0 14px;color:#888;font-size:12px">Admin: Post to Market</h3>
    <select id="country">
      <option value="RS">🇷🇸 Serbia</option>
      <option value="SE">🇸🇪 Sweden</option>
      <option value="DE">🇩🇪 Germany</option>
      <option value="US">🇺🇸 USA</option>
    </select>
    <input id="num" placeholder="Phone Number">
    <input id="prc" type="number" placeholder="Price in sats">
    <button class="btn-main" onclick="postToMarket()">POST TO MARKET</button>
    <hr style="border:none;border-top:1px solid #222;margin:20px 0">
    ${stavke || '<p style="color:#444;padding:20px 0">No numbers available.</p>'}
  </div>

  <!-- RENT -->
  <div id="rent" class="section">
    <h2 style="color:#ff9500;margin-bottom:12px">Rent Number</h2>
    <p style="color:#666;margin-bottom:16px">Long-term rentals (7–30 days).</p>
    <div class="market-item"><span>Private UK (+44)</span><button class="buy-btn" onclick="buy(5000,'rent-uk')">5000 sats</button></div>
    <div class="market-item"><span>Private DE (+49)</span><button class="buy-btn" onclick="buy(4500,'rent-de')">4500 sats</button></div>
  </div>
</div>

<!-- ── MODAL ── -->
<div class="overlay" id="overlay">
  <div class="modal">
    <button class="close-x" onclick="closeModal()">✕</button>

    <!-- Ekran 1: QR -->
    <div id="sc-qr">
      <h3>⚡ PLATI LIGHTNING</h3>
      <div id="qr-wrap"><canvas id="qr-canvas"></canvas></div>
      <div class="inv-small">
        Iznos: <span id="qr-amount"></span> sats &nbsp;|&nbsp; ID: <span id="qr-id"></span>
      </div>
      <div id="wait-msg"><span class="spin"></span> Čekam uplatu...</div>
      <a id="wallet-link" href="#" class="wallet-link">↗ Otvori u wallet aplikaciji</a>
    </div>

    <!-- Ekran 2: Čekam SMS -->
    <div id="sc-wait" style="display:none">
      <h3>💸 UPLATA OK!</h3>
      <p style="color:#666;margin-top:10px"><span class="spin"></span> Čekam SMS kod...</p>
    </div>

    <!-- Ekran 3: OTP -->
    <div id="sc-otp" style="display:none">
      <h3>✅ TVOJ KOD:</h3>
      <div class="otp-big" id="otp-val">----</div>
      <button class="btn-main" onclick="closeModal()">ZATVORI</button>
    </div>
  </div>
</div>

<!-- qrcode.js -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  var pollTimer = null;
  var qrObj = null;

  function tab(id, btn) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('show'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('show');
    btn.classList.add('active');
  }

  function screen(name) {
    ['qr','wait','otp'].forEach(s => {
      document.getElementById('sc-'+s).style.display = s===name ? 'block' : 'none';
    });
    document.getElementById('overlay').classList.add('show');
  }

  function closeModal() {
    document.getElementById('overlay').classList.remove('show');
    clearInterval(pollTimer); pollTimer = null;
  }

  async function postToMarket() {
    const num     = document.getElementById('num').value.trim();
    const price   = document.getElementById('prc').value.trim();
    const country = document.getElementById('country').value;
    if (!num || !price) return alert('Popuni broj i cenu!');
    await fetch('/admin/add', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({broj: num, cena: price, country})
    });
    location.reload();
  }

  async function buy(amount, itemId) {
    screen('qr');
    document.getElementById('qr-amount').textContent = amount;
    document.getElementById('qr-id').textContent = '...';
    document.getElementById('qr-canvas').getContext('2d').clearRect(0,0,200,200);
    document.getElementById('wallet-link').href = '#';

    try {
      const r = await fetch('/api/create-inv', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({amount, itemId})
      });
      const d = await r.json();

      if (!d.pr || !d.id) {
        alert('Greška: ' + (d.error || 'Server nije vratio invoice'));
        closeModal(); return;
      }

      // Generiši QR od Lightning invoice stringa
      if (qrObj) { qrObj.clear(); qrObj.makeCode('lightning:' + d.pr); }
      else {
        qrObj = new QRCode(document.getElementById('qr-canvas'), {
          text: 'lightning:' + d.pr,
          width: 190, height: 190,
          colorDark: '#000000', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }

      document.getElementById('qr-id').textContent = d.id.slice(0,8) + '...';
      document.getElementById('wallet-link').href = 'lightning:' + d.pr;

      // Počni da pratiš uplatu
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
          screen('wait'); // Plaćeno, ali SMS još nije stigao
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

// Admin: dodaj broj na market
app.post('/admin/add', (req, res) => {
    bazaBrojeva.push({
        id: Date.now().toString(),
        broj: req.body.broj,
        cena: parseInt(req.body.cena),
        countryCode: req.body.country
    });
    res.sendStatus(200);
});

// Kreiraj invoice
app.post('/api/create-inv', async (req, res) => {
    const { amount } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Nema iznosa' });

    try {
        const { data } = await axios.post(
            'https://api.swiss-bitcoin-pay.ch/checkout',
            {
                amount: parseInt(amount),
                unit: 'sat',                          // ← ispravno (ne "sats")
                title: 'SMS Kod',
                description: 'SMSNERO pristupni kod',
                delay: 15,
                webhook: {
                    url: BASE_URL + '/api/webhook'    // ← Swiss traži objekt, ne string
                }
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
        console.log('[invoice]', id);

        res.json({ id, pr, checkoutUrl });

    } catch (e) {
        const msg = e.response?.data?.message || e.message;
        console.error('[create-inv error]', msg, e.response?.data);
        res.status(500).json({ error: msg });
    }
});

// Webhook od Swiss (instant po uplati)
app.post('/api/webhook', (req, res) => {
    const { id, isPaid, status } = req.body;
    console.log('[webhook]', id, status, isPaid);
    if (id && invoices[id] && (isPaid === true || status === 'paid' || status === 'confirmed')) {
        invoices[id].paid = true;
        if (!invoices[id].code && zadnjiSms) invoices[id].code = zadnjiSms;
    }
    res.sendStatus(200);
});

// Polling od frontenda – prati konkretan invoice
app.get('/api/check-inv/:id', async (req, res) => {
    const { id } = req.params;
    const inv = invoices[id];
    if (!inv) return res.json({ paid: false, code: null });

    if (inv.paid) {
        if (!inv.code && zadnjiSms) inv.code = zadnjiSms;
        return res.json({ paid: true, code: inv.code });
    }

    // Fallback: pitaj Swiss direktno ako webhook nije stigao
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

// Dolazni SMS
app.post('/api/incoming-sms', (req, res) => {
    const raw = req.body.message || req.body.text || '';
    const kod = parseSms(raw);
    if (!kod) return res.send('OK');

    zadnjiSms = kod;
    console.log('[sms]', zadnjiSms);

    // Popuni plaćene invoice koji čekaju SMS
    for (const id in invoices) {
        if (invoices[id].paid && !invoices[id].code) {
            invoices[id].code = zadnjiSms;
        }
    }
    res.send('OK');
});

// Čišćenje starih invoice-a (> 2h)
setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const id in invoices) {
        if (invoices[id].createdAt < cutoff) delete invoices[id];
    }
}, 30 * 60 * 1000);

app.listen(process.env.PORT || 10000, () =>
    console.log('SMSNERO ⚡ started on port', process.env.PORT || 10000)
);
