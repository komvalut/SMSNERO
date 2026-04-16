const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

let lastSms = null;
let invoices = {}; 

// --- GLAVNA STRANA ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SMSNERO ⚡</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #0b0b0b; color: white; font-family: sans-serif; text-align: center; padding: 50px 20px; }
        .box { max-width: 350px; margin: auto; background: #151515; padding: 30px; border-radius: 20px; border: 1px solid #333; }
        .btn { background: #ff9500; color: black; border: none; padding: 18px; width: 100%; border-radius: 12px; font-weight: bold; cursor: pointer; font-size: 18px; }
        #status { margin-top: 20px; color: #ff9500; min-height: 50px; }
    </style>
</head>
<body>
    <div class="box">
        <h1>SMSNERO ⚡</h1>
        <button class="btn" onclick="plati()">DOBI KOD ODMAH</button>
        <div id="status"></div>
    </div>
    <script>
        let invoiceId = null;
        async function plati() {
            document.getElementById('status').innerText = "Otvaram račun...";
            try {
                const r = await fetch('/api/make-invoice', { method: 'POST' });
                const d = await r.json();
                if(d.checkoutUrl) {
                    invoiceId = d.id;
                    window.location.href = d.checkoutUrl;
                } else { document.getElementById('status').innerText = "Greška: " + d.error; }
            } catch(e) { document.getElementById('status').innerText = "Mreža koči."; }
        }
        setInterval(async () => {
            if(!invoiceId) return;
            const r = await fetch('/api/check-invoice/' + invoiceId);
            const d = await r.json();
            if(d.paid && d.code) {
                document.body.innerHTML = '<h1>TVOJ KOD:</h1><div style="font-size:40px; border:2px dashed #ff9500; padding:20px;">' + d.code + '</div>';
            }
        }, 3000);
    </script>
</body>
</html>
    `);
});

// --- TAJNA ADMIN STRANA (Ovde ubacuješ broj ručno) ---
// Pristup: tvoj-sajt.onrender.com/admin-nero
app.get('/admin-nero', (req, res) => {
    res.send(`
        <body style="background:#222; color:white; font-family:sans-serif; padding:20px;">
            <h1>ADMIN PANEL</h1>
            <p>Zadnji SMS sa telefona: <b>${lastSms || "Nema"}</b></p>
            <hr>
            <h3>Ubaci kod ručno za testiranje:</h3>
            <input type="text" id="rucniKod" placeholder="Npr. 123456" style="padding:10px;">
            <button onclick="posalji()" style="padding:10px;">PROGURAJ KOD</button>
            <script>
                async function posalji() {
                    const kod = document.getElementById('rucniKod').value;
                    await fetch('/api/incoming-sms', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({message: kod})
                    });
                    alert('Kod poslat na glavni ekran!');
                }
            </script>
        </body>
    `);
});

// --- API SEKCIJA ---
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.swiss-bitcoin-pay.ch/checkout',
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
            data: { amount: 1, unit: "sats", description: "SMS Code", webhook: BASE_URL + '/api/webhook' }
        });
        invoices[response.data.id] = { paid: false, code: null };
        res.json({ checkoutUrl: response.data.checkoutUrl, id: response.data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/webhook', (req, res) => {
    const { id, status } = req.body;
    if(status === 'confirmed' || status === 'paid') {
        if(invoices[id]) invoices[id].paid = true;
    }
    res.send("OK");
});

app.post('/api/incoming-sms', (req, res) => {
    lastSms = req.body.message || req.body.text;
    for (let id in invoices) {
        if(invoices[id].paid) invoices[id].code = lastSms;
    }
    res.send("OK");
});

app.get('/api/check-invoice/:id', (req, res) => { res.json(invoices[req.params.id] || {}); });

app.listen(process.env.PORT || 10000);
