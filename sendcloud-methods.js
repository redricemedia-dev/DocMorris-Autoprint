require('dotenv').config();
const axios = require('axios');

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY;
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY;

async function main() {
  try {
    const res = await axios.get('https://panel.sendcloud.sc/api/v2/shipping_methods', {
      auth: {
        username: PUBLIC_KEY,
        password: PRIVATE_KEY
      }
    });

    res.data.shipping_methods.forEach(method => {
      console.log('---');
      console.log('ID:', method.id);
      console.log('Name:', method.name);
      console.log('Carrier:', method.carrier);
      console.log('Min weight:', method.min_weight);
      console.log('Max weight:', method.max_weight);
      console.log('Countries:', method.countries?.map(c => c.iso_2).join(', '));
    });
  } catch (err) {
    console.error('FEHLER:');
    console.error(err.response?.data || err.message);
  }
}

main();