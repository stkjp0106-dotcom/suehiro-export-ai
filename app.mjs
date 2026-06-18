import './server.mjs';
import {
  getGoogleConfig,
  resolveTokenPath
} from './src/google-drive.mjs';

import {
  getGmailMonitorConfig,
  runGmailMonitor,
  validateGmailMonitorConfig
} from './src/gmail-monitor.mjs';
import {
  getProspectMonitorConfig,
  runProspectMonitor,
  validateProspectMonitorConfig
} from './src/prospect-monitor.mjs';

const sharedGoogleTokenPath = resolveTokenPath(getGoogleConfig(process.env));
const gmailConfig = getGmailMonitorConfig();
gmailConfig.google.tokenPath = sharedGoogleTokenPath;
const gmailMissing = validateGmailMonitorConfig(gmailConfig);

if (gmailMissing.length) {
  console.error(`Gmail monitor disabled; missing environment variables: ${gmailMissing.join(', ')}`);
} else {
  console.info(`Gmail worker running for ${gmailConfig.mailbox}`);
  runGmailMonitor(gmailConfig).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

const prospectConfig = getProspectMonitorConfig();
prospectConfig.google.tokenPath = sharedGoogleTokenPath;
const prospectMissing = validateProspectMonitorConfig(prospectConfig);

if (!prospectConfig.enabled) {
  console.info('Prospect monitor disabled by PROSPECT_MONITOR_ENABLED=false');
} else if (prospectMissing.length) {
  console.error(`Prospect monitor disabled; missing environment variables: ${prospectMissing.join(', ')}`);
} else {
  runProspectMonitor(prospectConfig).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
