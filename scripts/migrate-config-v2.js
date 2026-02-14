#!/usr/bin/env node
"use strict";

/**
 * Signal K Edge Link - Configuration Migration Tool (v1 to v2)
 *
 * Migrates v1 plugin configuration to v2 format by adding new configuration
 * fields with sensible defaults while preserving all existing settings.
 *
 * Usage:
 *   node scripts/migrate-config-v2.js [--config-path /path/to/plugin-config.json]
 *
 * If no path is provided, attempts to find the configuration in the default
 * Signal K plugin directory (~/.signalk/).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Default v2 configuration additions
const V2_DEFAULTS = {
  congestionControl: {
    enabled: false,
    targetRTT: 200,
    minDeltaTimer: 100,
    maxDeltaTimer: 5000
  },
  bonding: {
    enabled: false,
    mode: "main-backup",
    primary: {
      address: "127.0.0.1",
      port: 4446,
      interface: ""
    },
    backup: {
      address: "127.0.0.1",
      port: 4447,
      interface: ""
    },
    failover: {
      rttThreshold: 500,
      lossThreshold: 0.10,
      healthCheckInterval: 1000,
      failbackDelay: 30000
    }
  }
};

/**
 * Migrate a v1 configuration object to v2 format.
 * Preserves all existing settings and adds v2 defaults for new fields.
 *
 * @param {Object} v1Config - Existing v1 configuration
 * @returns {Object} v2-compatible configuration
 */
function migrateConfig(v1Config) {
  const v2Config = { ...v1Config };

  // Add congestion control defaults if not present
  if (!v2Config.congestionControl) {
    v2Config.congestionControl = { ...V2_DEFAULTS.congestionControl };
  } else {
    // Merge with defaults for any missing fields
    v2Config.congestionControl = {
      ...V2_DEFAULTS.congestionControl,
      ...v2Config.congestionControl
    };
  }

  // Add bonding defaults if not present
  if (!v2Config.bonding) {
    v2Config.bonding = JSON.parse(JSON.stringify(V2_DEFAULTS.bonding));
  } else {
    // Deep merge bonding config
    v2Config.bonding = {
      ...JSON.parse(JSON.stringify(V2_DEFAULTS.bonding)),
      ...v2Config.bonding
    };
    if (v2Config.bonding.primary) {
      v2Config.bonding.primary = {
        ...V2_DEFAULTS.bonding.primary,
        ...v2Config.bonding.primary
      };
    }
    if (v2Config.bonding.backup) {
      v2Config.bonding.backup = {
        ...V2_DEFAULTS.bonding.backup,
        ...v2Config.bonding.backup
      };
    }
    if (v2Config.bonding.failover) {
      v2Config.bonding.failover = {
        ...V2_DEFAULTS.bonding.failover,
        ...v2Config.bonding.failover
      };
    }
  }

  // If bonding is enabled and primary address matches the main udpAddress,
  // auto-populate the primary link settings from the main config
  if (v1Config.udpAddress && v2Config.bonding.primary.address === "127.0.0.1") {
    v2Config.bonding.primary.address = v1Config.udpAddress;
  }
  if (v1Config.udpPort && v2Config.bonding.primary.port === 4446) {
    v2Config.bonding.primary.port = v1Config.udpPort;
  }

  return v2Config;
}

/**
 * Find the Signal K plugin configuration file.
 * Searches common locations for the plugin config.
 *
 * @returns {string|null} Path to config file or null
 */
function findConfigFile() {
  const possiblePaths = [
    path.join(os.homedir(), ".signalk", "plugin-config-data", "signalk-edge-link.json"),
    path.join(os.homedir(), ".signalk", "node_modules", "signalk-edge-link", "plugin-config.json")
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Main migration function.
 */
function main() {
  const args = process.argv.slice(2);
  let configPath = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config-path" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Signal K Edge Link - Configuration Migration Tool (v1 to v2)");
      console.log("");
      console.log("Usage:");
      console.log("  node scripts/migrate-config-v2.js [--config-path /path/to/config.json]");
      console.log("");
      console.log("Options:");
      console.log("  --config-path  Path to the plugin configuration JSON file");
      console.log("  --help, -h     Show this help message");
      console.log("");
      console.log("If no --config-path is provided, the script searches for the");
      console.log("configuration in the default Signal K directory (~/.signalk/).");
      process.exit(0);
    }
  }

  // Find config file
  if (!configPath) {
    configPath = findConfigFile();
    if (!configPath) {
      console.log("No configuration file found.");
      console.log("Searched:");
      console.log("  ~/.signalk/plugin-config-data/signalk-edge-link.json");
      console.log("  ~/.signalk/node_modules/signalk-edge-link/plugin-config.json");
      console.log("");
      console.log("Use --config-path to specify the configuration file location.");
      console.log("");
      console.log("Example v2 configuration written to stdout:");
      console.log(JSON.stringify(migrateConfig({
        serverType: "client",
        udpPort: 4446,
        secretKey: "your-32-character-key-here......",
        useMsgpack: false,
        usePathDictionary: false,
        udpAddress: "127.0.0.1",
        helloMessageSender: 60,
        testAddress: "8.8.8.8",
        testPort: 80,
        pingIntervalTime: 1
      }), null, 2));
      process.exit(0);
    }
  }

  // Read existing config
  let configData;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    configData = JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading configuration file: ${err.message}`);
    process.exit(1);
  }

  // Handle Signal K plugin config wrapper format
  let pluginConfig;
  let isWrapped = false;
  if (configData.configuration) {
    // Signal K wraps plugin config in { configuration: { ... }, enabled: true }
    pluginConfig = configData.configuration;
    isWrapped = true;
  } else {
    pluginConfig = configData;
  }

  // Check if already v2
  if (pluginConfig.congestionControl && pluginConfig.bonding) {
    console.log("Configuration already has v2 fields (congestionControl and bonding).");
    console.log("No migration needed.");
    process.exit(0);
  }

  // Create backup
  const backupPath = configPath + ".v1.backup";
  try {
    fs.copyFileSync(configPath, backupPath);
    console.log(`Backup created: ${backupPath}`);
  } catch (err) {
    console.error(`Warning: Could not create backup: ${err.message}`);
  }

  // Migrate
  const v2Config = migrateConfig(pluginConfig);

  // Write migrated config
  let outputData;
  if (isWrapped) {
    outputData = { ...configData, configuration: v2Config };
  } else {
    outputData = v2Config;
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(outputData, null, 2), "utf-8");
    console.log(`Configuration migrated successfully: ${configPath}`);
    console.log("");
    console.log("Changes made:");
    if (!pluginConfig.congestionControl) {
      console.log("  + Added congestionControl (disabled by default)");
    }
    if (!pluginConfig.bonding) {
      console.log("  + Added bonding (disabled by default)");
    }
    console.log("");
    console.log("All existing settings have been preserved.");
    console.log("Restart Signal K to apply the changes.");
  } catch (err) {
    console.error(`Error writing migrated configuration: ${err.message}`);
    process.exit(1);
  }
}

// Export for testing
module.exports = { migrateConfig, V2_DEFAULTS };

// Run if called directly
if (require.main === module) {
  main();
}
