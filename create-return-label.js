require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY?.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY?.trim();

const DEBUG_ORDER_DIR = process.env.DEBUG_ORDER_DIR || 'C:\\DocMorris-Rechnungen\\debug-orders';
const RETURN_DIR = process.env.RETURN_ARCHIVE_DIR || 'C:\\DocMorris-Druckarchiv\\retouren';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*#]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

function findOrderFile(orderName) {
  if (!fs.existsSync(DEBUG_ORDER_DIR)) {
    throw new Error(`Debug-Ordner nicht gefunden: ${DEBUG_ORDER_DIR}`);
  }

  const files = fs.readdirSync(DEBUG_ORDER_DIR);
  const match = files.find(file =>
    file.toLowerCase().includes(String(orderName).toLowerCase())
  );

  if (!match) {
    throw new Error(`Keine Debug-Order gefunden für: ${orderName}`);
  }

  return path.join(DEBUG_ORDER_DIR, match);
}

function getCustomerAddress(order) {
  const a = order.shipping_address || order.billing_address;

  if (!a) {
    throw new Error('Keine Kundenadresse in der Order gefunden.');
  }

  return {
    name: a.name || `${a.first_name || ''} ${a.last_name || ''}`.trim(),
    company_name: a.company || '',
    address: a.address1 || '',
    address_2: a.address2 || '',
    city: a.city || '',
    postal_code: a.zip || '',
    country: a.country_code || 'DE',
    email: order.email || '',
    telephone: a.phone || order.phone || ''
  };
}

async function main() {
  const orderName = process.argv[2];

  if (!orderName) {
    throw new Error('Keine Bestellnummer übergeben. Beispiel: node create-return-label.js 1JOC4X');
  }

  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    throw new Error('SENDCLOUD_PUBLIC_KEY oder SENDCLOUD_PRIVATE_KEY fehlt in .env');
  }

  ensureDir(RETURN_DIR);

  const orderFile = findOrderFile(orderName);
  const order = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
  const customer = getCustomerAddress(order);

  console.log('→ Order geladen:', order.name);
  console.log('→ Kunde:', customer.name);
  console.log('→ Land:', customer.country);

  /*
    STOPP:
    Die echte Sendcloud Returns-v3 Payload braucht je nach Konto eine Return-Methode,
    Absender-/Retourenadresse und ggf. Item-/Reason-Daten.
    Deshalb testen wir jetzt zuerst, ob Order-Laden + Archiv sauber funktioniert.
  */

  const testFile = path.join(
    RETURN_DIR,
    `RETURN_TEST_${sanitizeFilename(order.name || orderName)}.txt`
  );

  fs.writeFileSync(
    testFile,
    [
      `Retouren-Test für ${order.name}`,
      `Kunde: ${customer.name}`,
      `Adresse: ${customer.address}`,
      `PLZ/Ort: ${customer.postal_code} ${customer.city}`,
      `Land: ${customer.country}`,
      `E-Mail: ${customer.email}`,
      `Zeit: ${new Date().toISOString()}`
    ].join('\n'),
    'utf8'
  );

  console.log('→ Testdatei gespeichert:', testFile);
  console.log('✅ Retouren-Vorbereitung funktioniert.');
  console.log('Nächster Schritt: Sendcloud Return-Methode/Returns API Payload ergänzen.');
}

main().catch(err => {
  console.error('❌ Fehler:', err.response?.data || err.message);
  process.exit(1);
});