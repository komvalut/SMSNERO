const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

app.use(express.json());

// 1. KREIRANJE BITCOIN FAKTURE
app.post('/create-invoice', async (req, res) => {
    const key = process.env.SWISS_API_KEY;
    const secret = process.env.SWISS_API_SECRET;

    if (!key || !secret) {
        return res.status(500).json({ error: 'Fale API ključevi na Renderu!' });
    }

    try {
        const response = await axios.post('https://swissbitcoinpay.com', {
            apiKey: key,
            apiSecret: secret,
            amount: 1,
            unit: 'sat',
            description: 'SMSNero Aktivacija'
        });
        res.json({ checkoutUrl: response.data.checkoutUrl });
    } catch (error) {
        res.status(500).json({ error: 'SwissBitcoinPay odbija: ' + (error.response?.data?.message || 'Nepoznata greška') });
    }
});

// 2. PRIJEM SMS PORUKE
app.post('/sms', (req, res) => {
    const { number, text } = req.body;
    const otp = text.match(/\b\d{4,6}\b/) ? text.match(/\b\d{4,6}\b/)[0] : null;
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'SMS', data: { number, text, otp } }));
        }
    });
    res.sendStatus(200);
});

// 3. KOMPLETAN INTERFEJS
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SMSNero MVP</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #000; color: #fff; font-family: monospace; text-align: center; padding: 20px; }
        .card { border: 1px solid #f2a900; padding: 20px; border-radius: 12px; max-width: 400px; margin: 20px auto; background: #111; }
        .btn { background: #f2a900; color: #000; border: none; padding: 20px; font-weight: bold; width: 100%; border-radius: 8px; cursor: pointer; font-size: 1.1em; }
        .otp-window { display: none; border: 2px solid #0f0; padding: 20px; color: #0f0; margin-top: 20px; background: #001a00; border-radius: 10px; }
        #otp-val { font-size: 3em; display: block; margin: 15px 0; letter-spacing: 5px; color: #fff; }
        .loader { color: #f2a900; font-size: 0.8em; margin-top: 10px; }
    </style>
</head>
<body>
    <h1>SMS<span style="color:#f2a900">NERO</span></h1>
    
    <div class="card">
        <p>Aktivacija broja</p>
        <h2 id="active-num">+46 700 44 55 66</h2>
        <p style="color: #f2a900;">Cena: 1 sat</p>
        <button class="btn" onclick="pay()">PLATITE I AKTIVIRAJTE</button>
        <p class="loader">Klik otvara SwissBitcoinPay (QR + Copy)</p>
    </div>

    <div id="otp-window" class="otp-window">
        SISTEM AKTIVAN - ČEKAM SMS...
        <span id="otp-val">------</span>
        <div id="sms-text" style="font-size: 0.8em; opacity: 0.8;"></div>
    </div>

    <script>
        const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
        
        async function pay() {
            try {
                const res = await fetch('/create-invoice', { method: 'POST' });
                const data = await res.json();
                
                if(data.checkoutUrl) {
                    window.open(data.checkoutUrl, '_blank');
                    document.getElementById('otp-window').style.display = 'block';
                } else {
                    alert('Greška: ' + data.error);
                }
            } catch (e) {
                alert('Server ne odgovara.');
            }
        }

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if(msg.type === 'SMS') {
                document.getElementById('otp-val').innerText = msg.data.otp || 'KOD';
                document.getElementById('sms-text').innerText = msg.data.text;
                document.getElementById('otp-window').style.borderColor = '#fff';
            }
        };
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => console.log('SMSNero Online'));
