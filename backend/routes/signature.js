// ============================================================
// 🧬 EIP-712 Signature Receiver (Backend)
// Puerto: 3002
// ============================================================
const express = require('express');
const router = express.Router();

router.post("/verify-signature", async (req, res) => {
    try {
        const { typedData, signature, address } = req.body;

        if (!typedData || !signature || !address) {
            return res.status(400).json({
                success: false,
                error: "Missing typedData, signature or address"
            });
        }

        // Guardar en la "blockchain" local
        global.DATABASE.blockchain.push({
            timestamp: new Date().toISOString(),
            action: "EIP712_SIGNATURE",
            signer: address.toLowerCase(),
            payload: typedData,
            signature,
            blockNumber: global.DATABASE.blockchain.length
        });

        await global.saveDatabase();

        return res.json({
            success: true,
            message: "Signature stored correctly",
            signature,
            address
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

module.exports = router;
