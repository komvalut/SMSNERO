const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

app.post('/create-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://swissbitcoinpay.com', {
            apiKey: process.env.SWISS_API_KEY,
            apiSecret: process.env.SWISS_API_SECRET,
            amount: 1,
            unit: 'sat',
            description: 'SMSNero'
        });
        res.json({ checkoutUrl: response.data.checkoutUrl });
    } catch (error) {
        res.status(500).json({ error: error.response?.data?.message || error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
    <body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:mono;">
        <h1>SMSNERO</h1>
        <button onclick="pay()" style="background:#f2a900;padding:20px;width:100%;cursor:pointer;">PLATITE 1 SAT</button>
        <div id="otp" style="font-size:3em;margin-top:20px;color:#0f0;"></div>
        <script>
            const ws = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
            async function pay(){
                const r = await fetch('/create-invoice', {method:'POST'});
                const d = await r.json();
                if(d.checkoutUrl) window.open(d.checkoutUrl,'_blank');
                else alert('Greska: ' + (d.error || 'Proveri logove'));
            }
            ws.onmessage = (e) => {
                const m = JSON.parse(e.data);
                document.getElementById('otp').innerText = m.otp || 'Stigao SMS';
            }
        </script>
    </body>`);
});

server.listen(process.env.PORT || 10000);
