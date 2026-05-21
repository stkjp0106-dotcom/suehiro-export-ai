import { loadDotEnv } from './src/env.mjs';
import {
  getOutlookMonitorConfig,
  pollOutlookMailbox,
  validateOutlookMonitorConfig
} from './src/outlook-monitor.mjs';

loadDotEnv();

const config = getOutlookMonitorConfig();
const missing = validateOutlookMonitorConfig(config);

if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

let shuttingDown = false;

process.on('SIGINT', () => {
  shuttingDown = true;
  console.log('Outlook worker received SIGINT');
});

process.on('SIGTERM', () => {
  shuttingDown = true;
  console.log('Outlook worker received SIGTERM');
});

console.log(`Outlook worker running for ${config.mailbox}`);
console.log(`Polling every ${config.pollSeconds}s`);

while (!shuttingDown) {
  try {
    await pollOutlookMailbox(config);
  } catch (error) {
    console.error(error.stack || error.message);
  }

  if (!shuttingDown) {
    await sleep(config.pollSeconds * 1000);
  }
}

console.log('Outlook worker stopped');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
