require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID_LABEL);

async function main() {
  try {
    const res = await axios.post(
      'https://api.printnode.com/printjobs',
      {
        printerId: PRINTER_ID,
        title: 'DocMorris AutoPrint Test',
        contentType: 'raw_base64',
        content: Buffer.from('TESTDRUCK\nDocMorris AutoPrint\n').toString('base64'),
        source: 'DocMorris AutoPrint'
      },
      {
        auth: {
          username: API_KEY,
          password: ''
        }
      }
    );

    console.log('PrintNode Job erstellt:', res.data);
  } catch (err) {
    console.error('FEHLER:');
    console.error(err.response?.data || err.message);
  }
}

main();