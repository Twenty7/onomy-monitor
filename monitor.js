#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const os = require("os");
const { execSync } = require('child_process');
let hostname = os.hostname();
let path = '/usr/local/lila-coin-scripts';
// path = '/Volumes/devhd/crypto_projects/lila-coin-scripts';
let healthchecks = require(`${path}/configs/healthchecks.json`);

// ETH
// let eth_main = 'https://nodes.mewapi.io/rpc/eth';
// todo: Check API Rate Limit
let eth_main = `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${healthchecks.etherscan_api_key}`;
// let eth_rinkeby = 'https://rinkeby-light.eth.linkpool.io';
let eth_rinkeby = `https://api-rinkeby.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${healthchecks.etherscan_api_key}`;
let eth_goerli = `https://api-goerli.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${healthchecks.etherscan_api_key}`;
let eth_local = 'http://localhost:8545';

// Onomy
let onomy_main = 'http://44.213.44.5:26657';
// let onomy_testnet1 = 'https://api-onomy.nodes.guru';
// let onomy_testnet = 'http://testnet1.onomy.io:26657';
// let onomy_testnet = 'http://64.9.136.119:26657'
let onomy_testnet = 'http://3.88.76.0:26657'
let onomy_local = 'http://localhost:26657';

// Coin / Healthcheck Type
let coin = 'eth';
var args = process.argv.slice(2);
console.log('Args: ', args);
if (args.length) {
  coin = args[0];
}

// Node Type
let node_type = execSync(`${path}/scripts/node_type.sh`).toString().trim();
console.log('Node Type', node_type);


run = async function() {
  try {
    let pub_block = null;
    let local_block = null;

    let sleep_time = sleepTime();
    console.log(`Sleeping for ${sleep_time}ms`, coin);
    await sleep(sleep_time);

    let healthcheck_uid = null;
    if (healthchecks[coin] && healthchecks[coin][hostname]) {
      healthcheck_uid = healthchecks[coin][hostname];
    } else {
      console.error('Invalid Health Check UID', {coin, hostname});
      throw Error(`Invalid Health Check UID - coin: ${coin} - host: ${hostname}`);
    }

    // Check Block
    let healthy = false;
    if (coin == 'eth' || coin == 'onomy') {
      healthy = await checkBlockStatus();
    } else if (coin == 'onomy_orchestrator') { // Check Orchestrator
      healthy = await checkOrchestratorStatus(hostname);
    }

    console.log('HEALTHY', {coin, hostname, healthcheck_uid, healthy});

    pingHealthcheck(healthcheck_uid, healthy);
  } catch (err) {
    console.error(err);
  }
}

checkOrchestratorStatus = async function(hostname) {
  try {
    let json = execSync(`cd ${path}/scripts && ./onomy_validator_status.sh`);
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
    let file = `${path}/${coin}_status.json`;
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
      console.log('Orchestrator NEEDS RESTART');
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
    if (coin == 'eth') {
      let eth_check = ( (hostname == 'nomsentry1' || hostname == 'nomsentry2' || hostname == 'beluga') ? eth_main : eth_goerli);
      pub_block = await getEthBlock(eth_check);
      if (pub_block === false) {
        console.error('Error Fetching Public ETH Block');
        process.exit(1);
      }
      if (coin == 'eth' && node_type == 'sentry') {
        let iname = 'vlan411';
        let vlan_ip = execSync(`/usr/sbin/ip -4 -o addr show ${iname} | tr -s ' ' | cut -d ' ' -f 4 | cut -d '/' -f 1`).toString().trim();
        eth_local = `http://${vlan_ip}:8545`;
      }
      console.log('Eth Local Host', eth_local);
      local_block = await getEthBlock(eth_local);
    } else {
      let nom_check = ( (hostname == 'nomsentry1' || hostname == 'nomsentry2' || hostname == 'beluga') ? onomy_main : onomy_testnet);
      pub_block = await getOnomyBlock(nom_check);
      if (pub_block === false) {
        console.error('Error Fetching Public Onomy Block');
        process.exit(1);
      }
      local_block = await getOnomyBlock(onomy_local);
    }

    console.log(`${coin} Pub`, pub_block);
    console.log(`${coin} Local`, local_block);
    if (pub_block && local_block) {
      diff = pub_block - local_block;
      console.log(`${coin} Diff`, diff);
    }
    let file = `${path}/${coin}_status.json`;
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
      console.error(`${coin} Node UNHEALTHY`, diff);
      return false;
    } else {
      console.log(`${coin} Node HEALTHY`, diff)
      return true;
    }
  } catch (err) {
    console.error(err);
    return false;
  }
  if (diff === false) {
    throw Error('Error checking Block Status', );
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

pingHealthcheck = async function(healthcheck_uid, healthy) {
  try {
    let ping_url = `https://hc-ping.com/${healthcheck_uid}`;
    if (!healthy) {
      ping_url = `${ping_url}/fail`;
    }
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
