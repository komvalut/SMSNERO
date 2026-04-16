const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Clean up the Token from Environment Variables
const ALBY_TOKEN = process.env.ALBY_TOKEN ? process.env.ALBY_TOKEN.trim() : null;

// Temporary database for incoming codes
let smsDatabase = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 📩 ENDPOINT FOR SMS FORWARDER APP
app.post('/api/incoming-sms', (req, res) => {
    const { from, message } = req.body; 
    console.log(`NEW SMS RECEIVED -> From: ${from}, Content: ${message}`);
    
    // We store the message globally for the "last" request
    smsDatabase["last"] = message; 
    res.status(200).send("OK");
});

// ⚡ CREATE LIGHTNING INVOICE
app.post('/api/make-invoice', async (req, res) => {
    try {
        const response = await axios.post('https://api.getalby.com/invoices', 
            { amount: parseInt(req.body.amount), memo: req.body.memo }, 
            { headers: { 'Authorization': `Bearer ${ALBY_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        res.json(response.data);
    } catch (e) { 
        console.error("Alby Error:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "Alby error" }); 
    }
});

// 🔍 CHECK PAYMENT STATUS (Improved detection)
app.get('/api/check-payment/:hash', async (req, res) => {
    try {
        const response = await axios.get(`https://api.getalby.com/invoices/${req.params.hash}`, {
            headers: { 'Authorization': `Bearer ${ALBY_TOKEN}` }
        });
        
        // Check for any sign of successful payment
        const isPaid = response.data.settled || response.data.state === 'SETTLED' || response.data.status === 'paid';
        
        console.log(`Payment Status for ${req.params.hash.substring(0,8)}: ${isPaid}`);
        res.json({ settled: isPaid });
    } catch (e) { 
        res.json({ settled: false }); 
    }
});

// 🔑 DELIVER CODE TO CUSTOMER
app.get('/api/get-my-code/:phone', (req, res) => {
    const latestCode = smsDatabase["last"]; 
    if (latestCode) {
        res.json({ code: latestCode });
        // Clear it after delivery so it's only used once
        smsDatabase["last"] = null;
    } else {
        res.json({ code: null });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("🚀 SMSNERO Server is LIVE on port " + PORT);
});
