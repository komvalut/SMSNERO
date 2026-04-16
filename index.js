const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

let lastSms = null;
let invoices = {}; // Ovde čuvamo ko je platio a ko čeka kod

// --- 1. GLAVNA STRANA ZA KUPCE ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SMSNERO ⚡</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #0b0b0b; color: white; font-family: sans-serif; text-align: center; padding: 50px 20px; }
        .box { max-width: 350px; margin: auto; background: #151515; padding: 30px; border-radius: 20px; border: 1px solid #333; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .btn { background: #ff9500; color: black; border: none; padding: 18px; width: 100%; border-radius: 12px; font-weight: bold; cursor: pointer; font-size: 18px; }
        #status { margin-top: 20px; color: #ff9500; min-height: 50px; }
        .code-display { font-size: 32px; border: 2px dashed #ff9500; padding: 20px; margin-top: 20px; background: #000; }
    </style>
</head>
<body>
    <div class="box">
        <h1>SMSNERO ⚡</h1>
        <p id="info">Cena: 1 sat</p>
        <button class="btn" onclick="plati()">DOBI KOD ODMAH</button>
        <div id="status"></div>
    </div>

    <script>
        let invoiceId = null;

        async function plati() {
            document.getElementById('status').innerText = "Generisanje Lightning računa...";
            try {
                const r = await fetch('/api/make-invoice', { method: 'POST' });
                const d = await r.json();
                if(d.checkoutUrl) {
                    invoiceId = d.id;
                    window.location.href = d.checkoutUrl;
                } else {
                    document.getElementById('status').innerText = "Greška: " + d.error;
                }
            } catch(e) { document.getElementById('status').innerText = "Greška u konekciji."; }
        }

        // Provera da li je stigao SMS za našu uplatu
        setInterval(async () => {
            if(!invoiceId) return;
            const r = await fetch('/api/check-invoice/' + invoiceId);
            const d = await r.json();
            if(d.paid && d.code) {
                document.body.innerHTML = '<div class="box"><h1>TVOJ KOD:</h1><div class="code-display">' + d.code + '</div></div>';
            } else if(d.paid) {
                document.getElementById('status').innerText = "Uplata primljena! Čekam da SMS stigne na telefon...";
            }
        }, 3000);
    </script>
</body>
</html>
    `);
});

// --- 2. ADMIN STRANA (Za tebe) ---
app.get('/admin-monitor', (req, res) => {
    res.send(`
        <body style="background:#000; color:#0f0; font-family:monospace; padding:20px;">
            <h2>⚡ SMSNERO SISTEM MONITOR</h2>
            <hr>
            <h4>Zadnji SMS na serveru:</h4>
            <div style="background:#111; padding:15px; border:1px solid #0f0;">${lastSms || "Nema podataka"}</div>
            <h4>Aktivne fakture:</h4>
            <pre>${JSON.stringify(invoices, null, 2)}</pre>
            <button onclick="location.reload()">OSVEŽI</button>
        </body>
    `);
});

// --- 3. API LOGIKA ---

// Pravljenje fakture (Claude-ova ispravka .ch i checkoutUrl)
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.swiss-bitcoin-pay.ch/checkout',
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
            data: {
                amount: 1,
                unit: "sats",
                description: "SMS Code Service",
                webhook: `${BASE_URL}/api/webhook`
            }
        });
        
        const inv = response.data;
        invoices[inv.id] = { paid: false, code: null };
        res.json({ checkoutUrl: inv.checkoutUrl, id: inv.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Webhook koji Swiss zove kad se plati
app.post('/api/webhook', (req, res) => {
    const { id, status } = req.body;
    if(status === 'confirmed' || status === 'paid') {
        if(invoices[id]) invoices[id].paid = true;
    }
    res.send("OK");
});

// Prijem SMS-a sa telefona
app.post('/api/incoming-sms', (req, res) => {
    const msg = req.body.message || req.body.text;
    lastSms = msg;
    
    // Ako je neko platio a čeka kod, daj mu ovaj SMS
    for (let id in invoices) {
        if(invoices[id].paid && !invoices[id].code) {
            invoices[id].code = msg;
        }
    }
    res.send("OK");
});

// Provera statusa za frontend
app.get('/api/check-invoice/:id', (req, res) => {
    const inv = invoices[req.params.id];
    res.json(inv || { error: "Not found" });
});

app.listen(process.env.PORT || 10000);
