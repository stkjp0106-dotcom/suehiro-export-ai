import './server.mjs';
import {
  getGmailMonitorConfig,
  runGmailMonitor,
  validateGmailMonitorConfig
} from './src/gmail-monitor.mjs';

const gmailConfig = getGmailMonitorConfig();
const missing = validateGmailMonitorConfig(gmailConfig);

if (missing.length) {
  console.error(`Gmail monitor disabled; missing environment variables: ${missing.join(', ')}`);
} else {
  console.info(`Gmail worker running for ${gmailConfig.mailbox}`);
  runGmailMonitor(gmailConfig).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
