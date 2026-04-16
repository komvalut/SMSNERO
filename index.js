const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.SWISS_API_KEY; 
let smsDatabase = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/incoming-sms', (req, res) => {
    const { message } = req.body;
    console.log(`📩 SMS RECEIVED: ${message}`);
    smsDatabase["last"] = message;
    res.status(200).send("OK");
});

app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: parseInt(req.body.amount),
            unit: "sats",
            description: "SMS Service"
        }, {
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' }
        });
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        res.status(500).json({ error: "Swiss Pay error" });
    }
});

app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.swissbitcoinpay.com/invoice/${req.params.id}`, {
            headers: { 'api-key': API_KEY }
        });
        const isPaid = response.data.status === 'paid' || response.data.status === 'confirmed';
        res.json({ settled: isPaid });
    } catch (e) { res.json({ settled: false }); }
});

app.get('/api/get-my-code/:phone', (req, res) => {
    res.json({ code: smsDatabase["last"] || null });
    if(smsDatabase["last"]) smsDatabase["last"] = null;
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Swiss Edition Live"));
