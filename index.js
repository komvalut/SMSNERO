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

// Prijem SMS-a sa tvog telefona
app.post('/api/incoming-sms', (req, res) => {
    console.log("📩 New SMS:", req.body.message);
    lastSms = req.body.message;
    res.send("OK");
});

// Pravljenje fakture (1 SAT)
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1,
            unit: "sats",
            description: "SMS Test"
        }, {
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' }
        });
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        res.status(500).json({ error: "API Error" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server running"));
