const express = require('express');
const router = express.Router();
const { appendRowToSheet } = require('../utils/googleSheets');
const { logger } = require('../logger');

router.post('/connect', async (req, res) => {
  try {
    const { address, chainId } = req.body;
    if (!address) return res.status(400).json({ success: false, error: 'address required' });
    await appendRowToSheet(0, { Fecha: new Date().toLocaleString(), Wallet: address, ChainID: chainId || '' });
    logger.info(`Wallet saved: ${address}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('wallet/connect error: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
