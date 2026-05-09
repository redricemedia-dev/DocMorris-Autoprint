require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });
const axios = require('axios');

async function main() {
  const ref = 'BE-238380400-2-A';

  const r = await axios.get(`${process.env.MIRAKL_BASE_URL}/api/orders`, {
    headers: { Authorization: process.env.MIRAKL_API_KEY },
    params: {
      paginate: false,
      max: 100
    }
  });

  const orders = r.data.orders || [];

  const hits = orders.filter(o => {
    const text = JSON.stringify(o);
    return text.includes('238380400') || text.includes(ref);
  });

  console.log('Orders geladen:', orders.length);
  console.log('Treffer:', hits.length);
  console.log(JSON.stringify(hits, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify(err.response?.data || err.message || err, null, 2));
});