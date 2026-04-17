const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

app.use(express.json());

// RUTA ZA KREIRANJE FAKTURE
app.post('/create-invoice', async (req, res) => {
    const { amountSats } = req.body;
    
    // Čitamo direktno sa Rendera
    const apiKey = process.env.SWISS_API_KEY;
    const apiSecret = process.env.SWISS_API_SECRET;

    if (!apiKey || !apiSecret) {
        return res.status(500).json({ error: 'API ključevi nisu podešeni na Renderu!' });
    }

    try {
        const response = await axios.post('https://swissbitcoinpay.com', {
            apiKey: apiKey,
            apiSecret: apiSecret,
            amount: parseInt(amountSats),
            unit: 'sat',
            description: 'SMSNero Rental'
        });
        res.json({ checkoutUrl: response.data.checkoutUrl });
    } catch (error) {
        console.error('SBP API Greška:', error.response?.data || error.message);
        res.status(500).json({ error: 'Komunikacija sa SwissBitcoinPay neuspešna' });
    }
});

// SMS RECEIVER
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

// FRONTEND
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SMSNero | Test</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #000; color: #fff; font-family: monospace; text-align: center; padding: 20px; }
        .btn { background: #f2a900; color: #000; border: none; padding: 20px; font-weight: bold; width: 100%; border-radius: 10px; cursor: pointer; }
        .status { border: 1px solid #0f0; color: #0f0; padding: 20px; margin-top: 20px; display: none; }
    </style>
</head>
<body>
    <h1>SMSNERO</h1>
    <div style="border: 1px solid #333; padding: 20px; border-radius: 10px;">
        <p>Cena: 1 sat</p>
        <button class="btn" onclick="pay()">PLATITE I AKTIVIRAJTE</button>
    </div>
    <div id="status" class="status">SISTEM AKTIVAN... ČEKAM SMS</div>
    <div id="otp-display" style="font-size: 3em; color: #fff; margin-top: 20px;"></div>

    <script>
        const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
        
        async function pay() {
            const res = await fetch('/create-invoice', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ amountSats: 1 })
            });
            const data = await res.json();
            if(data.checkoutUrl) {
                window.open(data.checkoutUrl, '_blank');
                document.getElementById('status').style.display = 'block';
            } else {
                alert('Greška: ' + (data.error || 'Nepoznata greška'));
            }
        }

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if(msg.type === 'SMS') {
                document.getElementById('otp-display').innerText = msg.data.otp || 'Kod primljen';
            }
        };
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => console.log('Server is running...'));
