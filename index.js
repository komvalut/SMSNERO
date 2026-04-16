const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- CONFIG ---
const API_KEY = process.env.SWISS_API_KEY; 
let smsDatabase = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 📩 SMS RECEIVER (Telefon šalje poruku ovde)
app.post('/api/incoming-sms', (req, res) => {
    const { message } = req.body;
    console.log(`📩 RECEIVED: ${message}`);
    smsDatabase["last"] = message;
    res.status(200).send("OK");
});

// ⚡ CREATE SWISS INVOICE (Cena: 1 Sat)
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1, // Samo 1 sat za testiranje
            unit: "sats",
            description: "SMS Service Test"
        }, {
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' }
        });
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        console.error("Swiss API Error:", e.message);
        res.status(500).json({ error: "Swiss Pay error" });
    }
});

// 🔍 CHECK PAYMENT
app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.swissbitcoinpay.com/invoice/${req.params.id}`, {
            headers: { 'api-key': API_KEY }
        });
        const isPaid = response.data.status === 'paid' || response.data.status === 'confirmed';
        res.json({ settled: isPaid });
    } catch (e) { res.json({ settled: false }); }
});

// 🔑 GET CODE
app.get('/api/get-my-code', (req, res) => {
    const code = smsDatabase["last"] || null;
    if(code) smsDatabase["last"] = null; // Briše kod nakon što ga isporuči
    res.json({ code: code });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Swiss Edition Live on 10000"));
