require('dotenv').config();

console.log("Retouren-Test gestartet");

const order = process.argv[2];

if (!order) {
  console.log("Keine Order übergeben");
  process.exit(1);
}

console.log("Order:", order);
console.log("→ Hier kommt später Sendcloud API rein");