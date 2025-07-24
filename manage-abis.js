#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Script to build contracts and manage ABI files
 * 
 * Expects directory structure:
 *   doc-abis/           (this directory)
 *   ../contracts/       (the contracts repository)
 *   abi-config.json     (configuration file with directory mapping and blacklist)
 * 
 * Operation:
 * - Syncs only explicitly categorized contract ABIs (updates existing, creates missing)
 * - Excludes blacklisted files (test, mock, deployment contracts)  
 * - Only processes contracts listed in directoryMapping configuration (from abi-config.json)
 * 
 * Usage:
 *   npm run abis:sync
 */

/**
 * Load configuration from external JSON file
 */
function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'abi-config.json');
    const configFile = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configFile);
  } catch (error) {
    log(`Failed to load abi-config.json: ${error.message}`, 'error');
    process.exit(1);
  }
}

// Load external configuration
const externalConfig = loadConfig();

// Configuration
const CONFIG = {
  contractsDir: path.resolve(__dirname, '../contracts'),
  abisDir: __dirname,
  outDir: path.join(__dirname, '../contracts/out'),
  
  // Directory mapping for organizing ABIs (loaded from external file)
  directoryMapping: externalConfig.directoryMapping,
  
  // Blacklist for copy mode - contracts to never copy (loaded from external file)
  blacklist: externalConfig.blacklist
};

/**
 * Utility functions
 */
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
  console.log(`${prefix} [${timestamp}] ${message}`);
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    log(`Created directory: ${dirPath}`);
  }
}

function isBlacklisted(contractName) {
  return CONFIG.blacklist.some(pattern => contractName.includes(pattern));
}

function getTargetDirectory(contractName) {
  for (const [dir, contracts] of Object.entries(CONFIG.directoryMapping)) {
    if (contracts.includes(contractName)) {
      return { directory: dir, categorized: true };
    }
  }
  
  return null; // Don't process uncategorized contracts
}

/**
 * Build contracts using Foundry
 */
function buildContracts() {
  log('Building contracts with Foundry...');
  try {
    // Use the build-extra-output script which generates ABIs
    execSync('npm run build-extra-output', { 
      cwd: CONFIG.contractsDir, 
      stdio: 'inherit' 
    });
    log('Contracts built successfully', 'success');
  } catch (error) {
    log(`Failed to build contracts: ${error.message}`, 'error');
    process.exit(1);
  }
}

/**
 * Extract ABI from build artifact
 */
function extractABI(buildArtifactPath) {
  try {
    const artifact = JSON.parse(fs.readFileSync(buildArtifactPath, 'utf8'));
    return artifact.abi || null;
  } catch (error) {
    log(`Failed to extract ABI from ${buildArtifactPath}: ${error.message}`, 'error');
    return null;
  }
}

/**
 * Get all contract build artifacts
 */
function getContractArtifacts() {
  const artifacts = [];
  
  if (!fs.existsSync(CONFIG.outDir)) {
    log('Build output directory not found. Make sure contracts are built first.', 'error');
    return artifacts;
  }
  
  function scanDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.name.endsWith('.json') && !entry.name.includes('.sol')) {
        // This is a build artifact JSON file
        const contractName = path.basename(entry.name, '.json');
        
        // Skip test and deployment scripts
        if (isBlacklisted(contractName)) {
          continue;
        }
        
        const targetInfo = getTargetDirectory(contractName);
        
        // Only include contracts that are explicitly categorized
        if (targetInfo) {
          artifacts.push({
            name: contractName,
            path: fullPath,
            targetDir: targetInfo.directory,
            categorized: targetInfo.categorized
          });
        }
      }
    }
  }
  
  scanDirectory(CONFIG.outDir);
  return artifacts;
}

/**
 * Check if ABI file exists in target location
 */
function abiFileExists(contractName, targetDir) {
  const fileName = contractName.startsWith('I') ? `${contractName}.abi.json` : `${contractName}.json`;
  const targetPath = path.join(CONFIG.abisDir, targetDir, fileName);
  return fs.existsSync(targetPath);
}

/**
 * Check if jq is available for JSON formatting
 */
function checkJqAvailable() {
  try {
    execSync('which jq', { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Format JSON using jq if available, otherwise use built-in formatting
 */
function formatJSON(obj) {
  const jsonString = JSON.stringify(obj, null, 2);
  
  if (checkJqAvailable()) {
    try {
      return execSync('jq .', { input: jsonString, encoding: 'utf8' });
    } catch (error) {
      log(`Warning: jq formatting failed, using built-in formatting`, 'warn');
      return jsonString;
    }
  }
  
  return jsonString;
}

/**
 * Check if ABI content has changed
 */
function hasABIChanged(contractName, abi, targetDir) {
  const fileName = contractName.startsWith('I') ? `${contractName}.abi.json` : `${contractName}.json`;
  const targetPath = path.join(CONFIG.abisDir, targetDir, fileName);
  
  if (!fs.existsSync(targetPath)) {
    return true; // File doesn't exist, so it's a change
  }
  
  try {
    const existingContent = fs.readFileSync(targetPath, 'utf8');
    const newContent = formatJSON(abi);
    return existingContent.trim() !== newContent.trim();
  } catch (error) {
    return true; // If we can't read the existing file, assume it needs updating
  }
}

/**
 * Write ABI to target location
 */
function writeABI(contractName, abi, targetDir, forceLog = false) {
  const fileName = contractName.startsWith('I') ? `${contractName}.abi.json` : `${contractName}.json`;
  const targetPath = path.join(CONFIG.abisDir, targetDir, fileName);
  const targetDirPath = path.join(CONFIG.abisDir, targetDir);
  
  ensureDirectoryExists(targetDirPath);
  
  const formattedContent = formatJSON(abi);
  const hasChanged = hasABIChanged(contractName, abi, targetDir);
  
  fs.writeFileSync(targetPath, formattedContent);
  
  if (hasChanged || forceLog) {
    log(`✓ ${targetDir}/${fileName}`, 'success');
    return true; // File was updated
  }
  
  return false; // File was not changed
}

/**
 * Sync mode - update existing and copy missing ABI files (only for explicitly categorized contracts)
 */
function syncMode() {
  log('Syncing ABI files for explicitly categorized contracts...');
  
  const artifacts = getContractArtifacts();
  let processed = 0;
  let updated = 0;
  let created = 0;
  
  for (const artifact of artifacts) {
    const abi = extractABI(artifact.path);
    if (!abi) continue;
    
    processed++;
    
    const fileExists = abiFileExists(artifact.name, artifact.targetDir);
    const wasUpdated = writeABI(artifact.name, abi, artifact.targetDir, !fileExists);
    
    if (wasUpdated) {
      if (fileExists) {
        updated++;
      } else {
        created++;
      }
    }
  }
  
  log(`Processed ${processed} explicitly categorized files: ${updated} updated, ${created} created`, 'success');
}

/**
 * Main execution
 */
function main() {
  const mode = process.argv[2];
  
  if (mode && mode !== 'sync') {
    console.log(`
Usage: node manage-abis.js [sync]

Operation:
  sync     - Update existing and create missing ABI files (excludes blacklisted)
           - This is the default operation when no mode is specified
           - Configuration is loaded from abi-config.json

Examples:
  node manage-abis.js
  node manage-abis.js sync
  npm run abis:sync
    `);
    if (!['sync', 'help', '--help', '-h'].includes(mode)) {
      process.exit(1);
    }
    if (mode !== 'sync') {
      process.exit(0);
    }
  }
  
  // Ensure the contracts directory exists and has foundry.toml
  if (!fs.existsSync(path.join(CONFIG.contractsDir, 'foundry.toml'))) {
    log('Could not find foundry.toml in the contracts directory', 'error');
    process.exit(1);
  }
  
  // Build contracts first
  buildContracts();
  
  // Execute sync operation
  syncMode();
  
  log('ABI management completed!', 'success');
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  buildContracts,
  syncMode,
  CONFIG
}; 