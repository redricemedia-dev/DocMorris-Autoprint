require('dotenv').config();
const axios = require('axios');

const publicKey = (process.env.SENDCLOUD_PUBLIC_KEY || '').trim();
const privateKey = (process.env.SENDCLOUD_PRIVATE_KEY || '').trim();

console.log('Public Key Länge:', publicKey.length);
console.log('Private Key Länge:', privateKey.length);
console.log('Public Key Anfang:', publicKey.slice(0, 6));
console.log('Private Key Anfang:', privateKey.slice(0, 6));

async function main() {
  try {
    const auth = Buffer.from(`${publicKey}:${privateKey}`).toString('base64');

    const res = await axios.get('https://panel.sendcloud.sc/api/v2/parcels', {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    console.log('OK');
    console.log(res.data);
  } catch (err) {
    console.error('FEHLER:');
    console.error(err.response?.status);
    console.error(err.response?.data || err.message);
  }
}

main();