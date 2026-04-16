const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.SWISS_API_KEY; 
let lastSms = null; 

// Početna strana
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Prijem SMS-a sa telefona (Forwarder aplikacija šalje ovde)
app.post('/api/incoming-sms', (req, res) => {
    console.log("📩 STIGAO SMS:", req.body.message);
    lastSms = req.body.message;
    res.send("OK");
});

// Pravljenje računa za Swiss Bitcoin Pay
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.swissbitcoinpay.com/checkout', {
            amount: 1, // Testna cena: 1 sat
            unit: "sats",
            description: "SMS Code Service"
        }, {
            headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' }
        });
        res.json({ id: response.data.id, payment_url: response.data.payment_url });
    } catch (e) {
        console.log("GRESKA:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "Swiss Pay Error" });
    }
});

// Provera da li je kupac platio
app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.swissbitcoinpay.com/invoice/${req.params.id}`, {
            headers: { 'api-key': API_KEY }
        });
        const paid = response.data.status === 'paid' || response.data.status === 'confirmed';
        res.json({ settled: paid });
    } catch (e) { res.json({ settled: false }); }
});

// Slanje koda na ekran kupca
app.get('/api/get-my-code', (req, res) => {
    res.json({ code: lastSms });
    // Opciono: obrisati nakon čitanja
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server je online!"));
