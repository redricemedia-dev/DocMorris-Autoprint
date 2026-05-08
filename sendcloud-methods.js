require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });

const axios = require('axios');

const WANT = ['dhl', 'deutsche', 'warenpost', 'parcel', 'paket'];

async function main() {
  const res = await axios.get('https://panel.sendcloud.sc/api/v2/shipping_methods', {
    auth: {
      username: process.env.SENDCLOUD_PUBLIC_KEY,
      password: process.env.SENDCLOUD_PRIVATE_KEY
    }
  });

  const methods = res.data.shipping_methods || [];

  const filtered = methods.filter(m => {
    const text = `${m.id} ${m.name} ${m.carrier} ${JSON.stringify(m.countries)}`.toLowerCase();
    return WANT.some(w => text.includes(w));
  });

  for (const m of filtered) {
    console.log(`ID=${m.id} | ${m.name} | carrier=${m.carrier}`);
  }
}

main().catch(err => {
  console.error(err.response?.data || err.message);
});