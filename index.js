const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ALBY_TOKEN = process.env.ALBY_TOKEN;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/make-invoice', async (req, res) => {
    try {
        const { amount, memo } = req.body;
        const response = await axios.post('https://api.getalby.com/invoices', 
        { amount: parseInt(amount), memo: memo }, 
        { headers: { 'Authorization': `Bearer ${ALBY_TOKEN}`, 'Content-Type': 'application/json' } });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Alby API error" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
