#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const os = require("os");
const { execSync } = require('child_process');
let hostname = os.hostname();
let path = __dirname;
let healthchecks = require(`${path}/config.json`);

// ETH
// let eth_main = 'https://nodes.mewapi.io/rpc/eth';
// todo: Check API Rate Limit
let eth_main = `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${healthchecks.etherscan_api_key}`;
let eth_goerli = `https://api-goerli.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${healthchecks.etherscan_api_key}`;
let eth_local = 'http://localhost:8545';

// Onomy
let onomy_main = 'http://44.213.44.5:26657';
// let onomy_testnet1 = 'https://api-onomy.nodes.guru';
// let onomy_testnet = 'http://testnet1.onomy.io:26657';
// let onomy_testnet = 'http://64.9.136.119:26657'
let onomy_testnet = 'http://3.88.76.0:26657'
let onomy_local = 'http://localhost:26657';

if (!healthchecks.etherscan_api_key) {
  console.error('Missing config.json etherscan_api_key');
  process.exit();
}
if (!healthchecks.healthcheckio_ping_key) {
  console.error('Missing config.json healthcheckio_ping_key');
  process.exit();
}


// Check / Coin / Healthcheck Type
let check = 'eth';
var args = process.argv.slice(2);
console.log('Args: ', args);
check_net = 'mainnet';
check_host = null;
if (!args.length) {
  console.error(`${path}/monitor.js eth|onomy|onomy_orchestrator mainnet|testnet [http://localhost:8545]`);
  process.exit();
}
if (args.length) {
  check = args[0];
}
if (args.length >= 2) {
  check_net = args[1];
}
if (args.length >= 3) {
  check_host = args[2];
}


run = async function() {
  try {

    let sleep_time = sleepTime();
    console.log(`Sleeping for ${sleep_time}ms`, check);
    // Random Sleep to Avoid API Rate Limit Issues
    await sleep(sleep_time);
    let healthcheck_slug = `${hostname}-${check}`;
    console.error('Healthcheck Slug', healthcheck_slug);

    // Check Block
    let healthy = false;
    if (check == 'eth' || check == 'onomy') {
      healthy = await checkBlockStatus();
    } else if (check == 'onomy_orchestrator') { // Check Orchestrator
      healthy = await checkOrchestratorStatus(hostname);
    }

    console.log('HEALTHY', {check, hostname, healthcheck_slug, healthy});

    pingHealthcheck(healthcheck_slug, healthy);
  } catch (err) {
    console.error(err);
  }
}

checkOrchestratorStatus = async function(hostname) {
  try {
    console.log('Checking Orchestrator Status');
    let val_address = execSync(`omg validator show Cosmos.Holdings`).toString().trim();
    console.log('Val Address', val_address);
    let json = execSync(`onomyd -o json query staking validator ${val_address}`);
    let vstatus = JSON.parse(json);
    let online = true;
    if (vstatus.jailed) {
      console.error(`Onomy Orchestrator ${hostname} JAILED`);
      online = false;
    }
    if (vstatus.status != 'BOND_STATUS_BONDED') {
      console.error(`Onomy Orchestrator ${hostname} Status: ${vstatus.status}`);
      online = false;
    }
    let running = execSync(`ps aux | grep gbt -a`);
    if (running.indexOf('cosmos') === -1 ) {
      console.error(`Onomy Orchestrator ${hostname} NOT RUNNING`);
      online = false;
    }

    // Record Orchestrator Status
    let file = `${path}/${check}_status.json`;
    let status = {vals: []};
    if (fs.existsSync(file)) {
      status = require(file);
    }
    // Add to top of array
    status.vals.unshift(online);
    // Splice to 10 (10 minutes)
    status.vals = status.vals.slice(0, 10);
    let status_str = JSON.stringify(status, null, 2);
    fs.writeFileSync(file, status_str);

    // Verify Recent Status Checks
    let bad_cnt = 0;
    for (let idx = status.vals.length; idx >= 0; idx--) {
      let cval = status.vals[idx];
      if (cval === false) {
        bad_cnt++;
      } else {
        bad_cnt = 0;
      }
    }
    console.log('Online', online);
    console.log('Bad Cnt', bad_cnt);
    if (!online && bad_cnt == 5) { // Only Restart at exactly 5 bad checks in a row
      console.error('Orchestrator NEEDS RESTART');
      // console.log('Restarting Validator...(disabled)');
      // execSync('sudo systemctl restart onomy_orchestrator.service');
    }

    return (bad_cnt >= 3 ? false : true);
  } catch (err) {
    console.error(err);
    return false;
  }
}

checkBlockStatus = async function() {
  let diff = false;
  try {
    if (check == 'eth') {
      let eth_check = ( check_net == 'mainnet' ? eth_main : eth_goerli);
      pub_block = await getEthBlock(eth_check);
      if (pub_block === false) {
        console.error('Error Fetching Public ETH Block');
        process.exit(1);
      }
      if (!check_host) check_host = eth_local;
      console.log('Eth Local Host', check_host);
      local_block = await getEthBlock(check_host);
    } else {
      let nom_check = ( check_net == 'mainnet' ? onomy_main : onomy_testnet);
      pub_block = await getOnomyBlock(nom_check);
      if (pub_block === false) {
        console.error('Error Fetching Public Onomy Block');
        process.exit(1);
      }
      if (!check_host) check_host = onomy_local;
      console.log('Onomy Local Host', check_host);
      local_block = await getOnomyBlock(check_host);
    }

    console.log(`${check} Pub Block`, pub_block);
    console.log(`${check} Local Block`, local_block);
    if (pub_block && local_block) {
      diff = pub_block - local_block;
      console.log(`${check} Diff`, diff);
    }
    let file = `${path}/${check}_status.json`;
    let status = {diffs: []};
    if (fs.existsSync(file)) {
      status = require(file);
    }
    // Add to top of array
    status.diffs.unshift(diff);
    // Splice to 10 (10 minutes)
    status.diffs = status.diffs.slice(0, 10);
    let status_str = JSON.stringify(status, null, 2);
    fs.writeFileSync(file, status_str);


    // Verify Recent Status Checks
    let bad_cnt = 0;
    for (let idx = status.diffs.length; idx >= 0; idx--) {
      let cval = status.diffs[idx];
      if (cval === false) {
        bad_cnt++;
      } else {
        bad_cnt = 0;
      }
    }

    // console.log('Bad Count', bad_cnt);
    if (bad_cnt >= 5 || diff >= 20) {
      // Unhealthy after 5 bad checks in a row
      console.error(`${check} Node UNHEALTHY`, diff);
      return false;
    } else {
      console.log(`${check} Node HEALTHY`, diff)
      return true;
    }
  } catch (err) {
    console.error(err);
    return false;
  }
}

getEthBlock = async function(host) {
  try {
    let params = {id: 1, jsonrpc: "2.0", method: "eth_blockNumber", "params": []};
    let response = await axios({
      method: 'post',
      url: host,
      data: params,
    });

    // console.log('Response Status', response.status);
    if (response.status == 200 && response.data.result && response.data.result != 'Invalid API Key') {
      let hex = response.data.result;
      let val = parseInt(hex, 16);
      if (isNaN(val)) return false;
      return val;
    } else {
      return false;
    }
  } catch (err) {
    console.error(err);
    return false;
  }
}

getOnomyBlock = async function(host) {
  try {
    // let params = {id: 1, jsonrpc: "2.0", method: "abci_info", "params": []};
    let response = await axios({
      // method: 'post',
      url: `${host}/abci_info?`,
      // data: params,
    });

    if (response.status == 200) {
      let json = response.data.result;
      return json.response.last_block_height;
      // return parseInt(hex, 16);
    } else {
      return false;
    }
  } catch (err) {
    console.error(err);
    return false;
  }
}

pingHealthcheck = async function(healthcheck_slug, healthy) {
  try {
    let ping_url = `https://hc-ping.com/${healthchecks.healthcheckio_ping_key}/${healthcheck_slug}`;
    if (!healthy) {
      ping_url = `${ping_url}/fail`;
    }
    console.log('URL', ping_url);
    let response = await axios({
      url: ping_url,
    });
  } catch (err) {
    console.error(err);
  }
}

sleep = function(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

sleepTime = function(min = 0, max = 10) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

run();
