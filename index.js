require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const SBP_API_KEY = process.env.SBP_API_KEY; // Unesi u Render Environment
const SBP_API_SECRET = process.env.SBP_API_SECRET; // Unesi u Render Environment

app.use(express.json());

// 1. KREIRANJE PRAVE BITCOIN FAKTURE PREKO SWISS BITCOIN PAY
app.post('/create-invoice', async (req, res) => {
    const { amountSats } = req.body;
    try {
        const response = await axios.post('https://swissbitcoinpay.com', {
            apiKey: SBP_API_KEY,
            apiSecret: SBP_API_SECRET,
            amount: parseInt(amountSats),
            unit: 'sat',
            description: 'SMSNero Rental',
            extra: { tag: 'SMSNero' }
        });
        res.json({ checkoutUrl: response.data.checkoutUrl });
    } catch (error) {
        console.error('Greška sa SBP API:', error.response?.data || error.message);
        res.status(500).json({ error: 'Greška pri kreiranju uplate' });
    }
});

// 2. PRIJEM SMS PORUKE (FORWARDER)
app.post('/sms', (req, res) => {
    const { number, text } = req.body;
    const otp = text.match(/\b\d{4,6}\b/) ? text.match(/\b\d{4,6}\b/)[0] : null;
    const msg = { number, text, otp, time: new Date() };

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'SMS', data: msg }));
        }
    });
    res.sendStatus(200);
});

// 3. FRONTEND (Sve u jednom)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SMSNero | Real BTC Pay</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #000; color: #fff; font-family: 'Courier New', monospace; padding: 20px; text-align: center; }
        .card { border: 1px solid #f2a900; padding: 20px; border-radius: 12px; margin: 20px auto; max-width: 400px; background: #111; }
        .otp-window { display:none; border: 2px solid #0f0; padding: 20px; color: #0f0; margin-top: 20px; background: #001a00; }
        button { background: #f2a900; border: none; padding: 18px; font-weight: bold; cursor: pointer; width: 100%; border-radius: 8px; font-size: 1.1em; }
        #otp-val { font-size: 3.5em; display: block; margin: 15px 0; letter-spacing: 5px; color: #fff; text-shadow: 0 0 10px #0f0; }
        input { background: #222; border: 1px solid #444; color: #f2a900; padding: 10px; border-radius: 5px; text-align: center; width: 80%; font-size: 1.2em; margin-bottom: 15px; }
        .status-text { font-size: 0.8em; color: #666; margin-top: 10px; }
    </style>
</head>
<body>
    <h1>SMS<span style="color:#f2a900">NERO</span></h1>
    
    <div class="card">
        <p>Broj za rentiranje:</p>
        <input type="text" id="num" value="+46 700 000 000">
        <p>Cena (Sats):</p>
        <input type="number" id="price" value="1">
        <button onclick="pay()">PLATITE I PREUZMITE KOD</button>
        <p class="status-text">Klikom otvarate Swiss Bitcoin Pay (QR + Copy)</p>
    </div>

    <div id="otp-window" class="otp-window">
        SISTEM AKTIVAN - ČEKAM SMS...
        <span id="otp-val">------</span>
        <div id="sms-text" style="font-size: 0.9em; color: #00ff00; opacity: 0.8;"></div>
    </div>

    <script>
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host);

        async function pay() {
            const sats = document.getElementById('price').value;
            try {
                const res = await fetch('/create-invoice', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ amountSats: sats })
                });
                const data = await res.json();
                
                if(data.checkoutUrl) {
                    window.open(data.checkoutUrl, '_blank');
                    document.getElementById('otp-window').style.display = 'block';
                    document.getElementById('otp-window').scrollIntoView();
                } else {
                    alert('Greška: Proveri API ključeve na Renderu');
                }
            } catch (e) {
                alert('Sistem nije povezan.');
            }
        }

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if(msg.type === 'SMS') {
                document.getElementById('otp-val').innerText = msg.data.otp || '???';
                document.getElementById('sms-text').innerText = "Primljena poruka: " + msg.data.text;
                // Vibracija ako je na mobilnom
                if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            }
        };
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => console.log('SMSNero SBP Edition Online!'));
