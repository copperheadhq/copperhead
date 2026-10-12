#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { createProject, loadProject, Project } from './lib/project';
import { getLogger, setLogLevel } from './lib/logger';
import { createPipeline } from './lib/pipeline';
import { getModelProvider, listModelProviders } from './lib/llm';
import { checkKicadCliAvailability, setKicadCliConfig } from './lib/kicad-cli';
import { getAppConfig, loadAppConfig, saveAppConfig } from './lib/config';

const log = getLogger('cli');
const program = new Command();

program
  .name('copperhead')
  .description('A CLI tool to generate KiCad designs from natural language briefs.')
  .version(process.env.npm_package_version || '0.0.0');

program
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-d, --debug', 'Enable debug logging (most verbose)')
  .option('--log-level <level>', 'Set log level (error, warn, info, http, verbose, debug, silly)', 'info')
  .hook('preAction', (thisCommand, actionCommand) => {
    const options = thisCommand.opts();
    if (options.debug) {
      setLogLevel('debug');
    } else if (options.verbose) {
      setLogLevel('verbose');
    } else if (options.logLevel) {
      setLogLevel(options.logLevel);
    }
    log.debug(`Log level set to: ${getLogger().level}`);

    // Load application configuration
    loadAppConfig();
    const appConfig = getAppConfig();
    if (appConfig.kicadCliPath) {
      setKicadCliConfig({ kicadCliPath: appConfig.kicadCliPath });
    }
  });

program
  .command('create')
  .description('Create a new KiCad project from a brief.')
  .argument('<brief>', 'Path to the brief markdown file or a brief string.')
  .option('-m, --model <provider>', 'LLM model provider to use (e.g., "ollama:llama3", "openai:gpt-4o")', 'ollama:llama3')
  .option('-p, --project-dir <dir>', 'Specify the project directory (defaults to current directory)')
  .action(async (briefArg, options) => {
    try {
      let briefContent: string;
      if (fs.existsSync(briefArg)) {
        briefContent = fs.readFileSync(briefArg, 'utf8');
        log.info(`Loaded brief from file: ${briefArg}`);
      } else {
        briefContent = briefArg;
        log.info(`Using brief string: "${briefContent.substring(0, 50)}..."`);
      }

      const projectDir = options.projectDir ? path.resolve(options.projectDir) : process.cwd();
      let project: Project;

      // Check if .copperhead directory exists, if so, load existing project
      const copperheadDir = path.join(projectDir, '.copperhead');
      if (fs.existsSync(copperheadDir)) {
        log.info(`Found existing .copperhead directory in ${projectDir}. Attempting to resume project.`);
        project = await loadProject(projectDir);
      } else {
        log.info(`No existing .copperhead directory found. Creating new project in ${projectDir}.`);
        project = await createProject(projectDir, briefContent);
      }

      const modelProvider = getModelProvider(options.model);
      if (!modelProvider) {
        log.error(`Unknown model provider: ${options.model}. Available providers: ${listModelProviders().join(', ')}`);
        process.exit(1);
      }

      const pipeline = createPipeline(project, modelProvider);
      await pipeline.run();

      log.info('Copperhead create pipeline completed successfully!');
      process.exit(0);
    } catch (error) {
      log.error(`Copperhead create failed: ${error instanceof Error ? error.message : String(error)}`);
      log.debug(error); // Log full error in debug mode
      process.exit(1);
    }
  });

program
  .command('check')
  .description('Check environment dependencies (KiCad CLI, LLM provider).')
  .option('--kicad-cli-path <path>', 'Specify the path to kicad-cli for checking')
  .action(async (options) => {
    log.info('Checking environment dependencies...');

    if (options.kicadCliPath) {
      setKicadCliConfig({ kicadCliPath: options.kicadCliPath });
      log.info(`Using specified kicad-cli path: ${options.kicadCliPath}`);
    }

    // Check KiCad CLI
    log.info('Verifying KiCad CLI...');
    const kicadCliAvailable = checkKicadCliAvailability();
    if (kicadCliAvailable) {
      log.info('✅ KiCad CLI is available and working.');
    } else {
      log.error('❌ KiCad CLI is NOT available or not working correctly.');
      log.error('Please ensure KiCad is installed and `kicad-cli` is in your system PATH,');
      log.error('or specify its path using `--kicad-cli-path` option or in `~/.copperhead/config.json`.');
      process.exit(1);
    }

    // Check LLM providers
    log.info('Verifying LLM providers...');
    const providers = listModelProviders();
    if (providers.length === 0) {
      log.warn('No LLM providers configured. Please configure at least one provider.');
    } else {
      log.info(`Configured LLM providers: ${providers.join(', ')}`);
      // TODO: Add actual connectivity/model availability checks for each provider
      log.info('✅ LLM providers are configured (basic check).');
    }

    log.info('Environment check completed.');
    process.exit(0);
  });

program
  .command('config')
  .description('Manage Copperhead configuration.')
  .option('--set <key>=<value>', 'Set a configuration value (e.g., --set kicadCliPath=/usr/local/bin/kicad-cli)')
  .option('--get <key>', 'Get a configuration value')
  .option('--list', 'List all configuration values')
  .action((options) => {
    const appConfig = getAppConfig();

    if (options.set) {
      const [key, value] = options.set.split('=');
      if (!key || value === undefined) {
        log.error('Invalid --set format. Use --set <key>=<value>.');
        process.exit(1);
      }
      (appConfig as any)[key] = value; // Type assertion for dynamic key
      saveAppConfig(appConfig);
      log.info(`Configuration updated: ${key} = ${value}`);
    } else if (options.get) {
      const value = (appConfig as any)[options.get];
      if (value !== undefined) {
        log.info(`${options.get} = ${value}`);
      } else {
        log.warn(`Configuration key '${options.get}' not found.`);
      }
    } else if (options.list) {
      log.info('Current Copperhead Configuration:');
      if (Object.keys(appConfig).length === 0) {
        log.info('  (No custom configuration set)');
      } else {
        for (const key in appConfig) {
          log.info(`  ${key} = ${(appConfig as any)[key]}`);
        }
      }
    } else {
      program.help();
    }
  });


program.parse(process.argv);
