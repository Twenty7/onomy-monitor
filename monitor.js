#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const os = require("os");
const { execSync } = require('child_process');
let hostname = os.hostname();
let path = __dirname;
let config = require(`${path}/config.json`);

// Host Config
let hosts = config.hosts;
if (!hosts.eth.public) {
  hosts.eth.public = {
    mainnet: `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${config.etherscan_api_key}`,
    testnet: `https://api-goerli.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${config.etherscan_api_key}`,
  };
}
let validator_name = config.validator_name;

if (!config.etherscan_api_key) {
  console.error('Missing config.json etherscan_api_key');
  process.exit();
}
if (!config.healthchecksio_ping_key) {
  console.error('Missing config.json healthchecksio_ping_key');
  process.exit();
}


// Check / Coin / Healthcheck Type
let check = 'eth';
var args = process.argv.slice(2);
console.log('Args: ', args);
check_net = 'mainnet';
check_host = null;
if (!args.length) {
  console.error(`${path}/monitor.js eth|onomy|onomy_validator|onex mainnet|testnet [http://localhost:8545]`);
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
    let check_slug = check.replace('_', '-');
    let healthcheck_slug = `${hostname}-${check_slug}-${check_net}`;
    console.log('Healthcheck Slug', healthcheck_slug);

    // Check Block
    let healthy = false;
    if (check == 'onomy_validator') { // Check Validator
      healthy = await checkOnomyValidatorStatus(hostname);
    } else { // Check Validator
      healthy = await checkBlockStatus();
    }

    console.log('HEALTH', {check, check_net, hostname, healthcheck_slug, healthy});

    pingHealthcheck(healthcheck_slug, healthy);
  } catch (err) {
    console.error(err);
  }
}

checkOnomyValidatorStatus = async function(hostname) {
  try {
    console.log('Checking Validator Status', validator_name);
    let val_address = execSync(`omg validator show ${validator_name}`).toString().trim();
    console.log('Val Address', val_address);
    if (!val_address) {
      console.error("Cannot determine validator address");
      return false;
    }
    let json = execSync(`onomyd -o json query staking validator ${val_address}`);
    let vstatus = JSON.parse(json);
    let online = true;
    if (vstatus.jailed) {
      console.error(`Onomy Validator ${hostname} ${validator_name}`, 'JAILED');
      online = false;
    }
    if (vstatus.status != 'BOND_STATUS_BONDED') {
      console.error(`Onomy Validator ${hostname} ${validator_name} Status: ${vstatus.status}`);
      online = false;
    }

    // Record Validator Status
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

    console.log('Online', online);

    return (online ? true : false);
  } catch (err) {
    console.error(err);
    return false;
  }
}

checkBlockStatus = async function() {
  let diff = false;
  let local_block_time_valid = true;
  try {
    if (check == 'eth') { // Eth
      let eth_check = hosts.eth.public[check_net];
      pub_block = await getEthBlock(eth_check);
      if (pub_block === false) {
        console.error(`Error Fetching Public ETH Block ${check_net}`, eth_check);
        process.exit(1);
      }
      if (!check_host) check_host = hosts.eth.local[check_net];
      console.log(`Eth Local  ${check_net} Host`, check_host);
      local_block = await getEthBlock(check_host);
      if (local_block === false) {
        console.error(`Error Fetching Local Eth Block ${check_net}`, check_host);
      }
    } else { // Onomy / Onex
      let nom_check = hosts[check]['public'][check_net];
      pub_block = await getOnomyBlock(nom_check);
      if (pub_block === false) {
        console.error(`Error Fetching Public ${check} Block ${check_net}`, nom_check);
        process.exit(1);
      }
      if (!check_host) check_host = hosts[check]['local'][check_net];
      console.log(`${check} Local ${check_net} Host`, check_host);
      local_block = await getOnomyBlock(check_host);
      if (local_block === false) {
        console.error(`Error Fetching Local ${check} Block ${check_net}`, check_host);
      }
      if (local_block) {
        // Check Local Block Time
        local_block_time_valid = await getOnomyBlockTime(check_host);
        console.log('Local Block Time Valid', local_block_time_valid);
      }
    }

    console.log(`${check} Pub Block`, pub_block);
    console.log(`${check} Local Block`, local_block);
    if (pub_block && local_block && local_block_time_valid) {
      diff = pub_block - local_block;
      console.log(`${check} Diff`, diff);
    }
    let file = `${path}/${check}_${check_net}_status.json`;
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
      console.error(`${check} ${check_net} Node UNHEALTHY`, diff);
      return false;
    } else {
      console.log(`${check} ${check_net} Node HEALTHY`, diff)
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
    let ts = Math.floor(new Date().getTime() / 1000);
    let response = await axios({
      // method: 'post',
      url: `${host}/abci_info?${ts}`,
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

getOnomyBlockTime = async function(host) {
  try {
    // let params = {id: 1, jsonrpc: "2.0", method: "status", "params": []};
    let ts = Math.floor(new Date().getTime() / 1000);
    let response = await axios({
      // method: 'post',
      url: `${host}/status?${ts}`,
      // data: params,
    });

    if (response.status == 200) {
      let json = response.data.result;
      let ts = new Date(json.sync_info.latest_block_time);
      let two_min = 2*60*1000;
      if (new Date() - ts < two_min) {
        return true;
      }
      return false;
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
    let ping_url = `https://hc-ping.com/${config.healthchecksio_ping_key}/${healthcheck_slug}`;
    if (!healthy) {
      ping_url = `${ping_url}/fail`;
    }
    // console.log('URL', ping_url);
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
