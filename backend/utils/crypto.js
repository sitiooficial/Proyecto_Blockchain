const crypto = require('crypto');

const ALGO = 'aes-256-ctr';
const SECRET_HEX = process.env.CRYPTO_SECRET || null;
if (!SECRET_HEX) {
  console.warn('CRYPTO_SECRET no definido en .env — encriptación deshabilitada');
}

function encrypt(text) {
  if (!SECRET_HEX) return text;
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(SECRET_HEX, 'hex');
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text)), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(payload) {
  if (!SECRET_HEX) return payload;
  const [ivHex, encHex] = String(payload).split(':');
  if (!ivHex || !encHex) return payload;
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const key = Buffer.from(SECRET_HEX, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  const decr = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decr.toString();
}

module.exports = { encrypt, decrypt };
