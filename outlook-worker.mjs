import { loadDotEnv } from './src/env.mjs';
import {
  getOutlookMonitorConfig,
  pollOutlookMailbox,
  validateOutlookMonitorConfig
} from './src/outlook-monitor.mjs';

loadDotEnv();

const config = getOutlookMonitorConfig();
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
    const currentConfig = getOutlookMonitorConfig();
    const missing = validateOutlookMonitorConfig(currentConfig);
    if (missing.length) {
      console.error(`Waiting for required environment variables: ${missing.join(', ')}`);
    } else {
      await pollOutlookMailbox(currentConfig);
    }
  } catch (error) {
    console.error(error.stack || error.message);
  }

  if (!shuttingDown) {
    await sleep((Number(process.env.OUTLOOK_POLL_SECONDS || config.pollSeconds) || 60) * 1000);
  }
}

console.log('Outlook worker stopped');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
