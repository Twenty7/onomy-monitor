# Onomy Node Monitor
**Onomy Node Monitor** by [Cosmos.Holdings](https://cosmos.holdings/)

A Command Line / Cron tool for verifying Eth & Onomy Block Heights as well as Orchestrator Health
 - Monitors Onomy and Eth Block Heights against Public Nodes
 - Monitors Onomy Orchestrator 'gbt' Process and Validator 'Status' on the blockchain.

## Prerequisites
 * Node v16+
 * Locally running Onomy or Eth Nodes
 * Installed [omg](https://github.com/dotneko/omg)
 * onomyd & omg in PATH
 * Free Etherscan.io Account & [API Key](https://etherscan.io/myapikey)
 * Free Healthcheck.io Account & Ping Key

## Installation
Clone Repository & Install Dependencies
```
git clone https://github.com/Twenty7/onomy-monitor.git
cd onomy-monitor
npm install
```

## Configuration
 * Add the Etherscan.io and Healthchecks.io Keys to the config.json file
```
cp config.example.json config.json
```
 * In your healthchecks.io Project, you will need to create checks for each process and node you want to monitor. One for `eth`, another for `onomy`, and another for `onomy orchestrator`. Name each check using the node `hostname` and After creating each check, edit it and modify it to be a 'slug' based check that will create a URL from the Check Name. Recommended Period of 5 minutes and Grace Time of 11 minutes, adjust as desired.
 
 Healthcheck.io Name Examples for two sentry nodes and validator node:
 ```
 nomsentry1 Eth
 nomsentry1 Onomy
 nomsentry2 Eth
 nomsentry2 Onomy
 nomvalidator Eth
 nomvalidator Onomy
 nomvalidator Onomy Orchestrator