require('dotenv').config();
const axios = require('axios');

const DHL_API_KEY = process.env.DHL_RETOURE_API_KEY;
const DHL_API_SECRET = process.env.DHL_RETOURE_API_SECRET;
const DHL_USER = process.env.DHL_RETOURE_USERNAME;
const DHL_PASS = process.env.DHL_RETOURE_PASSWORD;

const RECEIVER_ID = process.env.DHL_RETOURE_RECEIVER_ID;
const BILLING = process.env.DHL_RETOURE_BILLING_NUMBER;

async function getToken() {
  const body = new URLSearchParams();
  body.append('grant_type', 'password');
  body.append('username', DHL_USER);
  body.append('password', DHL_PASS);
  body.append('client_id', DHL_API_KEY);
  body.append('client_secret', DHL_API_SECRET);

  const res = await axios.post(
    'https://api-eu.dhl.com/parcel/de/account/auth/ropc/v1/token',
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

async function main() {
  try {
    const token = await getToken();

    const payload = {
  receiverId: RECEIVER_ID,
  billingNumber: BILLING,
  customerReference: "TEST-RETOURE-001",
  shipmentReference: "TEST-RETOURE-001",

  shipper: {
    name: "VitaSanum GmbH",
    address: {
      streetName: "Rosenheimer Landstr.",
      streetNumber: "27",
      postalCode: "85521",
      city: "Ottobrunn",
      country: "DE"
    }
  },

  consignee: {
    name: "Test Kunde",
    address: {
      streetName: "Teststrasse",
      streetNumber: "1",
      postalCode: "10115",
      city: "Berlin",
      country: "DE"
    }
  }
};

    const res = await axios.post(
  'https://api-eu.dhl.com/parcel/de/shipping/returns/v1/orders',
  payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
         
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("✅ SUCCESS");
    console.log(JSON.stringify(res.data, null, 2));

  } catch (err) {
    console.error("❌ DHL Fehler");
    console.error(err.response?.status);
    console.error(JSON.stringify(err.response?.data || err.message, null, 2));
  }
}

main();