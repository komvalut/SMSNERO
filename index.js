const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;

// invoiceId -> { paid: bool, code: string | null, createdAt: number }
const invoiceMap = {};
let lastSms = null;

// ─── ČIŠĆENJE SMS ──────────────────────────────────────────────────────────
function cleanMessage(msg) {
    if (!msg) return null;
    if (msg.includes("Känsligt") || msg.includes("dolt")) return null;
    const codeMatch = msg.match(/\d{4,8}/);
    return codeMatch ? codeMatch[0] : msg.trim();
}

// ─── HTML ──────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMSNERO ⚡</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #080808; --panel: #111; --border: #222;
    --orange: #ff9500; --orange2: #ffb347; --dim: #444;
    --text: #eee; --mono: 'Share Tech Mono', monospace; --head: 'Rajdhani', sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--mono);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 18px; padding: 36px 28px 32px; box-shadow: 0 0 60px rgba(255,149,0,.07);
    position: relative; overflow: hidden; }
  .card::before { content:''; position:absolute; top:-60px; right:-60px; width:180px; height:180px;
    background: radial-gradient(circle, rgba(255,149,0,.12), transparent 70%); pointer-events:none; }
  .logo { font-family: var(--head); font-size: 2rem; letter-spacing: 3px; color: var(--orange); margin-bottom: 4px; }
  .sub { color: var(--dim); font-size: .75rem; margin-bottom: 28px; }
  .btn { display:block; width:100%; padding:16px; background:var(--orange); color:#000;
    font-family:var(--head); font-size:1.15rem; font-weight:700; letter-spacing:2px;
    border:none; border-radius:12px; cursor:pointer; transition:background .15s, transform .1s; }
  .btn:hover { background: var(--orange2); }
  .btn:active { transform: scale(.97); }
  .btn:disabled { background:#333; color:#666; cursor:not-allowed; }
  #status { margin-top:22px; font-size:.8rem; color:var(--dim); min-height:24px; text-align:center; }
  #status.ok { color: var(--orange); } #status.err { color: #e55; }
  .overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.88);
    backdrop-filter:blur(4px); z-index:100; align-items:center; justify-content:center; padding:20px; }
  .overlay.show { display:flex; }
  .modal { background:var(--panel); border:1px solid var(--border); border-radius:18px;
    padding:32px 28px; width:100%; max-width:360px; text-align:center;
    position:relative; animation:pop .2s ease; }
  @keyframes pop { from{transform:scale(.92);opacity:0} to{transform:scale(1);opacity:1} }
  .modal-title { font-family:var(--head); font-size:1.1rem; letter-spacing:2px;
    color:var(--orange); margin-bottom:20px; }
  #qr-wrap { background:#fff; border-radius:12px; padding:12px;
    display:inline-block; margin-bottom:18px; }
  #qr-wrap img { display:block; width:200px; height:200px; }
  .invoice-info { font-size:.72rem; color:var(--dim); word-break:break-all;
    margin-bottom:16px; line-height:1.5; }
  .invoice-info span { color:var(--orange); }
  .spinner { display:inline-block; width:16px; height:16px; border:2px solid var(--border);
    border-top-color:var(--orange); border-radius:50%; animation:spin .7s linear infinite;
    vertical-align:middle; margin-right:6px; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .otp-box { background:#000; border:2px dashed var(--orange); border-radius:12px;
    padding:22px 16px; font-size:2.4rem; letter-spacing:8px; color:var(--orange);
    margin:12px 0 20px; font-family:var(--mono); }
  .close-btn { position:absolute; top:14px; right:18px; background:none; border:none;
    color:var(--dim); font-size:1.4rem; cursor:pointer; line-height:1; }
  .close-btn:hover { color:var(--text); }
  .wallet-btn { margin-top:12px; font-size:.85rem; letter-spacing:1px; }
</style>
</head>
<body>

<div class="card">
  <div class="logo">SMSNERO ⚡</div>
  <div class="sub">1 sat &nbsp;·&nbsp; Lightning instant &nbsp;·&nbsp; Bitcoin</div>
  <button class="btn" id="buyBtn" onclick="startPurchase()">KUPI KOD</button>
  <div id="status"></div>
</div>

<!-- MODAL -->
<div class="overlay" id="overlay">
  <div class="modal">
    <button class="close-btn" onclick="closeModal()">✕</button>

    <!-- QR screen -->
    <div id="screen-qr" style="display:none">
      <div class="modal-title">⚡ PLATI LIGHTNING</div>
      <div id="qr-wrap">
        <img id="qrImg" src="" alt="QR">
      </div>
      <div class="invoice-info">
        Iznos: <span>1 sat</span> &nbsp;|&nbsp; ID: <span id="invId"></span>
      </div>
      <div id="waitMsg"><span class="spinner"></span> Čekam uplatu...</div>
      <a id="payLink" href="#">
        <button class="btn wallet-btn" style="margin-top:14px">Otvori u wallet ↗</button>
      </a>
    </div>

    <!-- Čekam SMS screen -->
    <div id="screen-wait" style="display:none">
      <div class="modal-title">💸 UPLATA OK!</div>
      <p style="color:var(--dim);font-size:.85rem;margin-top:10px">
        <span class="spinner"></span> Čekam SMS kod...
      </p>
    </div>

    <!-- OTP screen -->
    <div id="screen-otp" style="display:none">
      <div class="modal-title">✅ TVOJ KOD:</div>
      <div class="otp-box" id="otpCode">----</div>
      <button class="btn" onclick="closeModal()">ZATVORI</button>
    </div>

  </div>
</div>

<script>
  let pollTimer = null;

  function setStatus(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg; el.className = cls || '';
  }

  function showScreen(name) {
    ['qr','wait','otp'].forEach(s => {
      document.getElementById('screen-'+s).style.display = s === name ? 'block' : 'none';
    });
    document.getElementById('overlay').classList.add('show');
  }

  function closeModal() {
    document.getElementById('overlay').classList.remove('show');
    clearInterval(pollTimer); pollTimer = null;
    document.getElementById('buyBtn').disabled = false;
    setStatus('');
  }

  async function startPurchase() {
    document.getElementById('buyBtn').disabled = true;
    setStatus('Kreiram fakturu...', 'ok');

    try {
      const r = await fetch('/api/make-invoice', { method: 'POST' });
      const d = await r.json();

      if (!d.invoiceId || !d.pr) {
        setStatus('Greška: ' + (d.error || 'Nema odgovora sa servera'), 'err');
        document.getElementById('buyBtn').disabled = false;
        return;
      }

      // QR kod kreira se od Lightning invoice stringa (pr)
      document.getElementById('qrImg').src =
        'https://api.qrserver.com/v1/create-qr-code/?size=200x200&ecc=M&data=' +
        encodeURIComponent('lightning:' + d.pr);
      document.getElementById('invId').textContent = d.invoiceId.slice(0,8) + '...';
      document.getElementById('payLink').href = 'lightning:' + d.pr;

      showScreen('qr');
      pollInvoice(d.invoiceId);

    } catch (e) {
      setStatus('Greška veze, pokušaj ponovo.', 'err');
      document.getElementById('buyBtn').disabled = false;
    }
  }

  function pollInvoice(id) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/check-invoice/' + id);
        const d = await r.json();
        if (d.paid && d.code) {
          clearInterval(pollTimer);
          document.getElementById('otpCode').textContent = d.code;
          showScreen('otp');
          setStatus('');
        } else if (d.paid) {
          showScreen('wait');
        }
      } catch(e) {}
    }, 2500);
  }
</script>
</body>
</html>`;

// ─── ROUTES ────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.send(HTML));

app.post('/api/make-invoice', async (req, res) => {
    try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.headers.host}`;

        const { data } = await axios.post(
            'https://api.swiss-bitcoin-pay.ch/checkout',
            {
                amount: 1,
                unit: 'sat',
                title: 'SMS Kod',
                description: 'Jednokratni pristupni kod',
                delay: 15,
                webhook: { url: `${baseUrl}/api/webhook` }
            },
            {
                headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );

        const { id, checkoutUrl, pr } = data;

        if (!id || !pr) {
            console.error('[invoice] Swiss nije vratio id/pr:', data);
            return res.status(500).json({ error: 'Swiss API nije vratio pr (Lightning invoice)' });
        }

        invoiceMap[id] = { paid: false, code: null, createdAt: Date.now() };
        console.log('[invoice created]', id);

        res.json({ invoiceId: id, checkoutUrl, pr });

    } catch (e) {
        const msg = e.response?.data?.message || e.message;
        console.error('[invoice error]', msg, e.response?.data);
        res.status(500).json({ error: msg });
    }
});

app.post('/api/webhook', (req, res) => {
    const { id, isPaid, status } = req.body;
    console.log('[webhook]', id, status, isPaid);
    if (id && invoiceMap[id] && (isPaid === true || status === 'paid')) {
        invoiceMap[id].paid = true;
        if (!invoiceMap[id].code && lastSms) invoiceMap[id].code = lastSms;
    }
    res.sendStatus(200);
});

app.get('/api/check-invoice/:id', async (req, res) => {
    const { id } = req.params;
    const entry = invoiceMap[id];
    if (!entry) return res.json({ paid: false, code: null });

    if (entry.paid) {
        if (!entry.code && lastSms) entry.code = lastSms;
        return res.json({ paid: true, code: entry.code });
    }

    // Fallback: pitaj Swiss direktno
    try {
        const { data } = await axios.get(
            `https://api.swiss-bitcoin-pay.ch/checkout/${id}`,
            { timeout: 8000 }
        );
        if (data.isPaid) {
            entry.paid = true;
            if (!entry.code && lastSms) entry.code = lastSms;
        }
    } catch (e) {
        console.error('[check error]', e.message);
    }

    res.json({ paid: entry.paid, code: entry.code });
});

app.post('/api/incoming-sms', (req, res) => {
    const raw = req.body.message || req.body.text || '';
    const cleaned = cleanMessage(raw);
    if (!cleaned) return res.send('OK');

    lastSms = cleaned;
    console.log('[sms received]', lastSms);

    for (const id in invoiceMap) {
        if (invoiceMap[id].paid && !invoiceMap[id].code) {
            invoiceMap[id].code = lastSms;
        }
    }
    res.send('OK');
});

// Čišćenje starih zapisa (svakih 30 min)
setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const id in invoiceMap) {
        if (invoiceMap[id].createdAt < cutoff) delete invoiceMap[id];
    }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('SMSNERO ⚡ port', PORT));
