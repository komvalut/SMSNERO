const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- CONFIGURATION ---
const API_KEY = process.env.BTCPAY_API_KEY; // Tvoj novi API Key
const STORE_ID = process.env.BTCPAY_STORE_ID; // Tvoj Store ID
const BTCPAY_URL = "https://checkout.swissbitcoinpay.com"; // Ili tvoj BTCPay URL

let smsDatabase = {}; 

// 📩 SMS RECEIVER (Ovo već provereno radi kod tebe!)
app.post('/api/incoming-sms', (req, res) => {
    const { from, message } = req.body;
    console.log(`📩 SMS RECEIVED: ${message}`);
    smsDatabase["last"] = message;
    res.status(200).send("OK");
});

// ⚡ CREATE BTCPAY INVOICE
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post(`${BTCPAY_URL}/api/v1/stores/${STORE_ID}/invoices`, {
            amount: req.body.amount,
            currency: "SATS",
            checkout: { speedPolicy: "HighSpeed" }
        }, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
        });
        
        // Vraćamo checkout link ili payment request
        res.json({ 
            id: response.data.id, 
            checkoutLink: response.data.checkoutLink 
        });
    } catch (e) {
        console.error("BTCPay Error:", e.message);
        res.status(500).json({ error: "Payment provider error" });
    }
});

// 🔍 CHECK PAYMENT
app.get('/api/check-payment/:id', async (req, res) => {
    try {
        const response = await axios.get(`${BTCPAY_URL}/api/v1/stores/${STORE_ID}/invoices/${req.params.id}`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        
        // Kod BTCPay-a status 'Settled' ili 'Processing' (za Lightning) znači uspeh
        const status = response.data.status;
        const isPaid = (status === 'Settled' || status === 'Processing');
        
        console.log(`Invoice ${req.params.id} status: ${status}`);
        res.json({ settled: isPaid });
    } catch (e) {
        res.json({ settled: false });
    }
});

// 🔑 GET CODE
app.get('/api/get-my-code/:phone', (req, res) => {
    res.json({ code: smsDatabase["last"] || null });
    if(smsDatabase["last"]) smsDatabase["last"] = null;
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 BTCPay Edition running on port ${PORT}`));
