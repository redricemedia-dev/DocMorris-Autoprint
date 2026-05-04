require('dotenv').config();

const axios = require('axios');

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY?.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY?.trim();

async function main() {
  const methodId = Number(process.argv[2] || process.env.RETURN_SHIPPING_METHOD_ID || 26774);

  const res = await axios.post(
    'https://panel.sendcloud.sc/api/v3/compat/shipping-options',
    {
      shipping_method_ids: [methodId]
    },
    {
      auth: {
        username: PUBLIC_KEY,
        password: PRIVATE_KEY
      },
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  console.log(JSON.stringify(res.data, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify(err.response?.data || err.message, null, 2));
  process.exit(1);
});