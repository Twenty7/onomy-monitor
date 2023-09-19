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
 * Free Healthchecks.io Account & Ping Key (Look within project settings to define your Ping Key)

## Installation
Clone Repository & Install Dependencies
```
git clone https://github.com/Twenty7/onomy-monitor.git
cd onomy-monitor
npm install
```

## Configuration
 * Add the Etherscan.io and Healthchecks.io Keys to the config.json file
 * Add your Validator Name to config.json
 * Update any Public or Local Hostnames & Ports
```
cp config.example.json config.json
```

 * In your healthchecks.io Project, you will need to create checks for each process and node you want to monitor. One for `eth`, another for `onomy`, and another for `onomy orchestrator`. Name each check using the node `hostname` and previous process type. The monitor script uses a 'slug' based check that will create a URL from the Check Name, so they must be exact. It is recommended to set a Period of 5 minutes and Grace Time of 11 minutes, adjust as desired to be more or less sensitive.
 
 Healthchecks.io Name Examples for two sentry nodes and one validator node:
`{Hostname} {Chain} {Network}`
```
 nomsentry1 Eth Mainnet
 nomsentry1 Onomy Mainnet
 nomsentry1 Onex Mainnet
 nomsentry2 Eth Mainnet
 nomsentry2 Onomy Mainnet
 nomsentry2 Onex Mainnet
 nomvalidator Eth Mainnet
 nomvalidator Onomy Mainnet
 nomvalidator Onex Mainnet
 nomvalidator Onomy Validator Mainnet
```
The first example should result in a Healthcheck slug of `nomsentry1-eth-mainnet`

 * Add Crontab entries on each node for each process.  `crontab -e`
```
* * * * * /usr/local/onomy-monitor/monitor.js eth mainnet >> /var/log/onomy-monitor.log 2>&1
* * * * * /usr/local/onomy-monitor/monitor.js onomy mainnet >> /var/log/onomy-monitor.log 2>&1
* * * * * bash -lc '/usr/local/onomy-monitor/monitor.js onomy_validator mainnet >> /var/log/onomy-monitor.log 2>&1'
```
