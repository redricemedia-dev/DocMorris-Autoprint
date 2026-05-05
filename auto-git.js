require('dotenv').config();
const { exec } = require('child_process');

function run(cmd) {
  return new Promise(resolve => {
    exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}

async function autoCommit() {
  const status = await run('git status --porcelain');

  // nichts geändert → skip
  if (!status.stdout.trim()) {
    console.log('[AUTO-GIT] Keine Änderungen');
    return;
  }

  const time = new Date().toISOString();

  await run('git add .');

  await run(`git commit -m "auto backup ${time}"`);

  await run('git push');

  console.log('[AUTO-GIT] Backup erstellt:', time);
}

setInterval(autoCommit, 5 * 60 * 1000); // alle 5 Minuten

console.log('[AUTO-GIT] läuft...');