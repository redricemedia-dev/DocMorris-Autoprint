require('dotenv').config();

const axios = require('axios');

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY?.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY?.trim();

async function main() {
  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    throw new Error('SENDCLOUD_PUBLIC_KEY oder SENDCLOUD_PRIVATE_KEY fehlt in .env');
  }

  const res = await axios.get(
    'https://panel.sendcloud.sc/api/v2/shipping_methods',
    {
      auth: {
        username: PUBLIC_KEY,
        password: PRIVATE_KEY
      },
      params: {
        is_return: true
      }
    }
  );

  const methods = res.data?.shipping_methods || res.data || [];

  console.log(JSON.stringify(methods.map(m => ({
    id: m.id,
    name: m.name,
    carrier: m.carrier,
    service_point_input: m.service_point_input,
    countries: m.countries
  })), null, 2));
}

main().catch(err => {
  console.error('❌ Fehler:', err.response?.data || err.message);
  process.exit(1);
});