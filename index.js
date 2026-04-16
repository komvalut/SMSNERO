const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Prijem SMS-a
app.post('/api/incoming-sms', (req, res) => {
    lastSms = req.body.message;
    console.log("📩 SMS STIGAO!");
    res.send("OK");
});

// Pravljenje racuna - DIREKTAN URL
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.swissbitcoinpay.com/checkout',
            headers: { 
                'api-key': API_KEY,
                'Content-Type': 'application/json'
            },
            data: {
                amount: 1,
                unit: "sats",
                description: "SMS Code"
            }
        });
        res.json({ url: response.data.payment_url });
    } catch (e) {
        console.log("❌ DETALJNA GRESKA:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/get-my-code', (req, res) => {
    res.json({ code: lastSms });
});

app.listen(process.env.PORT || 10000, () => console.log("🚀 Server spreman"));
