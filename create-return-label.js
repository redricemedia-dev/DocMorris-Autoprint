require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY?.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY?.trim();

const DEBUG_ORDER_DIR = process.env.DEBUG_ORDER_DIR || 'C:\\DocMorris-Rechnungen\\debug-orders';
const RETURN_DIR = process.env.RETURN_ARCHIVE_DIR || 'C:\\DocMorris-Druckarchiv\\retouren';

const RETURN_SHIPPING_OPTION_CODE =
  process.env.RETURN_SHIPPING_OPTION_CODE || 'dhl_de:retoure/eco_delivery,labelless';
const RETURN_WEIGHT_KG = Number(process.env.RETURN_WEIGHT_KG || 0.5);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*#]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

function splitHouseNumber(address1) {
  const raw = String(address1 || '').trim();
  const match = raw.match(/^(.+?)\s+(\d+[a-zA-Z]?(?:[-/]\d+[a-zA-Z]?)?)$/);

  if (!match) {
    return {
      street: raw,
      houseNumber: ''
    };
  }

  return {
    street: match[1],
    houseNumber: match[2]
  };
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

function getCustomerReturnFromAddress(order) {
  const a = order.shipping_address || order.billing_address;

  if (!a) {
    throw new Error('Keine Kundenadresse in der Order gefunden.');
  }

  const split = splitHouseNumber(a.address1);

  return {
    name: a.name || `${a.first_name || ''} ${a.last_name || ''}`.trim(),
    company_name: a.company || '',
    address_line_1: split.street,
    house_number: split.houseNumber || '0',
    address_line_2: a.address2 || '',
    postal_code: a.zip || '',
    city: a.city || '',
    country_code: a.country_code || 'DE',
    phone_number: a.phone || order.phone || '',
    email: order.email || 'info@redrice.biz'
  };
}

function getReturnToAddress() {
  return {
    name: process.env.RETURN_TO_NAME || 'VitaSanum GmbH',
    company_name: process.env.RETURN_TO_COMPANY || 'VitaSanum GmbH',
    address_line_1: process.env.RETURN_TO_ADDRESS || 'Königsallee',
    house_number: process.env.RETURN_TO_HOUSE_NUMBER || '27',
    postal_code: process.env.RETURN_TO_POSTAL_CODE || '40212',
    city: process.env.RETURN_TO_CITY || 'Düsseldorf',
    country_code: process.env.RETURN_TO_COUNTRY || 'DE',
    phone_number: process.env.RETURN_TO_PHONE || '',
    email: process.env.RETURN_TO_EMAIL || 'info@redrice.biz'
  };
}

function getOrderValue(order) {
  const value = Number(order.total_price || order.current_total_price || 0);
  return value > 0 ? value : 1;
}

function buildParcelItems(order) {
  return (order.line_items || []).map(item => ({
    description: String(item.name || item.title || 'Artikel').slice(0, 80),
    quantity: Number(item.quantity || 1),
    weight: {
      value: RETURN_WEIGHT_KG,
      unit: 'kg'
    },
    value: {
      value: Number(item.price || 1),
      currency: order.currency || 'EUR'
    },
    sku: item.sku || '',
    product_id: String(item.product_id || item.id || ''),
    origin_country: 'DE',
    return_reason_id: 8
  }));
}

function getAuth() {
  return {
    username: PUBLIC_KEY,
    password: PRIVATE_KEY
  };
}

async function createReturnSynchronously(order) {
const shipWith = {
  type: 'shipping_option_code',
  shipping_option_code: RETURN_SHIPPING_OPTION_CODE
};

  const payload = {
    from_address: getCustomerReturnFromAddress(order),
    to_address: getReturnToAddress(),
    ship_with: shipWith,
    dimensions: {
      height: 10,
      width: 20,
      length: 30,
      unit: 'cm'
    },
    weight: {
      value: RETURN_WEIGHT_KG,
      unit: 'kg'
    },
    collo_count: 1,
    parcel_items: buildParcelItems(order),
    send_tracking_emails: false,
    order_number: order.name,
    total_order_value: {
      value: getOrderValue(order),
      currency: order.currency || 'EUR'
    },
    external_reference: `RET-${order.name}-${Date.now()}`,
    delivery_option: 'drop_off_point',
    apply_rules: true
  };

const debugPayloadPath = path.join(
  RETURN_DIR,
  `RETURN_PAYLOAD_${sanitizeFilename(order.name)}.json`
);

fs.writeFileSync(debugPayloadPath, JSON.stringify(payload, null, 2), 'utf8');

console.log('→ Payload gespeichert:', debugPayloadPath);

  const res = await axios.post(
    'https://panel.sendcloud.sc/api/v3/returns/announce-synchronously',
    payload,
    {
      auth: getAuth(),
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );

  return {
    data: res.data,
    payload
  };
}

async function downloadReturnLabel(parcelId) {
  const res = await axios.get(
    `https://panel.sendcloud.sc/api/v3/parcels/${parcelId}/documents/label`,
    {
      auth: getAuth(),
      responseType: 'arraybuffer',
      headers: {
        Accept: 'application/pdf'
      },
      params: {
        paper_size: 'A6'
      },
      timeout: 60000
    }
  );

  return Buffer.from(res.data);
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

  console.log('→ Order geladen:', order.name);
  console.log('→ Retourenlabel wird über Sendcloud erstellt...');
 console.log('→ Return shipping option:', RETURN_SHIPPING_OPTION_CODE);
  const result = await createReturnSynchronously(order);

  console.log('→ Sendcloud Return erstellt:', JSON.stringify(result.data, null, 2));

  const parcelId = result.data.parcel_id;

  if (!parcelId) {
    throw new Error('Sendcloud hat keine parcel_id zurückgegeben.');
  }

  const pdf = await downloadReturnLabel(parcelId);

  const filePath = path.join(
    RETURN_DIR,
    `RETURN_${sanitizeFilename(order.name)}_${parcelId}.pdf`
  );

  fs.writeFileSync(filePath, pdf);

  const metaPath = path.join(
    RETURN_DIR,
    `RETURN_${sanitizeFilename(order.name)}_${parcelId}.json`
  );

  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        order_name: order.name,
        parcel_id: parcelId,
        return_id: result.data.return_id,
        response: result.data
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('✅ Retourenlabel gespeichert:', filePath);
  console.log('→ Metadaten gespeichert:', metaPath);
}

main().catch(err => {
  console.error('❌ Fehler beim Erstellen des Retourenlabels');

  if (err.response?.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(err.message || String(err));
  }

  process.exit(1);
});