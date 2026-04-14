const express = require('express');
const path = require('path');
const app = express();

// Služi statičke fajlove (tvoj CSS, slike itd.)
app.use(express.static(path.join(__dirname)));

// Glavna runda koja otvara tvoj sajt
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Port koji Render zahteva
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
