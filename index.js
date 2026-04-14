const express = require('express');
const path = require('path');
const app = express();

// Render automatski dodeljuje port preko process.env.PORT
const PORT = process.env.PORT || 3000;

// Govorimo Express-u da koristi fajlove iz trenutnog foldera (za CSS i slike)
app.use(express.static(__dirname));

// Glavna ruta koja šalje tvoj index.html korisniku
app.get('/', (req, res) => {