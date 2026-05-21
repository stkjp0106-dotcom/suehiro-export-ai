import {
  getGmailMonitorConfig,
  runGmailMonitor,
  validateGmailMonitorConfig
} from './src/gmail-monitor.mjs';

const config = getGmailMonitorConfig();

async function main() {
  const missing = validateGmailMonitorConfig(config);
  if (missing.length) {
    console.error(`Waiting for required environment variables: ${missing.join(', ')}`);
    setInterval(() => {
      console.error(`Waiting for required environment variables: ${missing.join(', ')}`);
    }, 60_000);
    return;
  }

  console.info(`Gmail worker running for ${config.mailbox}`);
  await runGmailMonitor(config);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
