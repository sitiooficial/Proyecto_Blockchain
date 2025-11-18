const { GoogleSpreadsheet } = require('google-spreadsheet');
const { logger } = require('../logger');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;

if (!SHEET_ID || !SERVICE_EMAIL || !PRIVATE_KEY) {
  logger.warn('Google Sheets no configurado (GOOGLE_SHEET_ID / GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY faltan)');
}

async function getDoc() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID no definido');
  const doc = new GoogleSpreadsheet(SHEET_ID);
  await doc.useServiceAccountAuth({ client_email: SERVICE_EMAIL, private_key: PRIVATE_KEY });
  await doc.loadInfo();
  return doc;
}

async function appendRowToSheet(sheetIndex = 0, rowObj = {}) {
  const doc = await getDoc();
  const sheet = doc.sheetsByIndex[sheetIndex];
  return sheet.addRow(rowObj);
}

async function readSheetRows(sheetIndex = 0) {
  const doc = await getDoc();
  const sheet = doc.sheetsByIndex[sheetIndex];
  const rows = await sheet.getRows();
  return rows.map(r => r._rawData ? r._rawData : r);
}

module.exports = { appendRowToSheet, readSheetRows, getDoc };
