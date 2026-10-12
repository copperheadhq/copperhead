import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from './logger';

const log = getLogger('config');

interface AppConfig {
  kicadCliPath?: string;
  // Add other global configuration options here
}

const CONFIG_DIR = path.join(os.homedir(), '.copperhead');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let appConfig: AppConfig = {};

export function loadAppConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const configContent = fs.readFileSync(CONFIG_FILE, 'utf8');
      appConfig = JSON.parse(configContent);
      log.debug(`Loaded app config from ${CONFIG_FILE}`);
    } catch (error) {
      log.error(`Failed to load app config from ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
      appConfig = {}; // Reset to empty config on error
    }
  } else {
    log.debug(`No app config file found at ${CONFIG_FILE}. Using default.`);
  }
  return appConfig;
}

export function saveAppConfig(config: AppConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    log.debug(`Saved app config to ${CONFIG_FILE}`);
  } catch (error) {
    log.error(`Failed to save app config to ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getAppConfig(): AppConfig {
  return { ...appConfig }; // Return a clone to prevent direct modification
}
