const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

// SVE JE U JEDNOM FAJLU - NEMA PROMAŠAJA
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
        .btn { background: #ff9500; color: black; border: none; padding: 15px; width: 100%; border-radius: 10px; font-weight: bold; cursor: pointer; }
    </style>
</head>
<body>
    <div class="box">
        <h1>SMSNERO ⚡</h1>
        <button class="btn" onclick="buy()">PLATI (1 sat)</button>
        <div id="res" style="margin-top:20px; color:#ff9500;"></div>
    </div>
    <script>
        async function buy() {
            document.getElementById('res').innerText = "Povezivanje...";
            try {
                const r = await fetch('/api/make-invoice', { method: 'POST' });
                const d = await r.json();
                if(d.url) window.location.href = d.url;
                else document.getElementById('res').innerText = "Greška: " + (d.error || "Nema URL-a");
            } catch(e) { document.getElementById('res').innerText = "Mreža blokira."; }
        }
        setInterval(async () => {
            const r = await fetch('/api/get-my-code');
            const d = await r.json();
            if(d.code) document.body.innerHTML = '<h1>TVOJ KOD:</h1><div style="border:2px dashed #ff9500; padding:20px; font-size:24px;">' + d.code + '</div>';
        }, 3000);
    </script>
</body>
</html>
    `);
});

// API ZA SMS
app.post('/api/incoming-sms', (req, res) => {
    lastSms = req.body.message;
    res.send("OK");
});

// API ZA RACUN
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.swissbitcoinpay.com/checkout',
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
            data: { amount: 1, unit: "sats", description: "SMS" }
        });
        res.json({ url: response.data.payment_url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/get-my-code', (req, res) => { res.json({ code: lastSms }); });

app.listen(process.env.PORT || 10000);
