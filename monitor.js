#!/usr/bin/env node
const exec = require('util').promisify(require('child_process').exec);
const fs = require('fs');
const axios = require('axios');
const os = require("os");
const { execSync } = require('child_process');
let hostname = os.hostname();
let path = __dirname;
process.chdir(path);
process.env.NODE_ENV = 'production';
const config = require("config");
// let default_config = require(`${path}/config.default.json`);
// let local_config = require(`${path}/config.json`);
const http = require('http');
const https = require('https');
let httpAgent = new http.Agent({ family: 4 });
let httpsAgent = new https.Agent({ family: 4 });
axios.default.httpAgent = httpAgent;
axios.default.httpsAgent = httpsAgent;

if (!config.hosts) {
  console.error("Invalid Configuration. Missing 'hosts'");
  process.exit(1);
}

// Host Config
let hosts = config.hosts;
if (hosts.eth && !hosts.eth.public) {
  hosts.eth.public = {
    mainnet: `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${config.etherscan_api_key}`,
    testnet: `https://api-goerli.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${config.etherscan_api_key}`,
  };
}
let validator_name = config.validator_name;
let valopers = config.valopers;

if (!config.healthchecksio_ping_key) {
  console.error('Missing config.json healthchecksio_ping_key');
  process.exit(1);
}


// Check / Coin / Healthcheck Type
let check = 'eth';
var args = process.argv.slice(2);
console.log('Args: ', args);
check_net = 'mainnet';
check_host = null;
if (!args.length) {
  console.error(`${path}/monitor.js eth|onomy|onomy_validator|onex_validator|onex|hermes mainnet|testnet [http://localhost:8545]`);
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
    if (check == 'eth') {
      // Random Sleep to Avoid Public API Rate Limit Issues
      let sleep_time = sleepTime();
      console.log(`Sleeping for ${sleep_time}ms`, check);
      await sleep(sleep_time);
    }

    let check_slug = check.replace('_', '-');
    let healthcheck_slug = `${hostname}-${check_slug}-${check_net}`;
    console.log('Healthcheck Slug', healthcheck_slug);

    // Check Block
    let healthy = false;
    if (check == 'onomy_validator' || check == 'onex_validator') { // Check Validator
      healthy = await checkOnomyValidatorStatus(check, hostname);
    } else if (check == 'hermes') { // Check Hermes IBC Relayer
      healthy = await checkHermes();
    } else { // Check Sentry
      healthy = await checkBlockStatus();
    }

    console.log('HEALTH', {check, check_net, hostname, healthcheck_slug, healthy});

    pingHealthcheck(healthcheck_slug, healthy);
  } catch (err) {
    console.error(err);
  }
}

checkOnomyValidatorStatus = async function(check, hostname) {
  try {
    let chain = (check == 'onomy_validator' ? 'onomy' : 'onex');
    let node = hosts[chain]['local'][check_net];
    console.log(`Checking ${chain} Validator Status on ${check_net} ${node}`, validator_name);
    let valoper_address = null;
    if (valopers && valopers[chain] && valopers[chain][check_net]) {
      valoper_address = valopers[chain][check_net];
    } else if (chain == 'onomy') {
      valoper_address = execSync(`omg validator show ${validator_name}`).toString().trim();
    } else if (chain == 'onex') {
      // Todo: Automatically fetch valoper_address
      // valoper_address = execSync(`omg validator show ${validator_name}`).toString().trim();
    }
    console.log('Valoper Address', valoper_address);
    if (!valoper_address) {
      console.error(`Cannot determine valoper address for ${chain} on ${check_net}`);
      return false;
    }

    let jsonstr = execSync(`${chain}d --node ${node} -o json query staking validator ${valoper_address}`);
    let json = JSON.parse(jsonstr.toString());
    let vstatus = json.validator;
    let online = true;
    if (vstatus.jailed) {
      console.error(`${chain} Validator ${hostname} ${check_net} ${validator_name}`, 'JAILED');
      online = false;
    }
    if (vstatus.status != 'BOND_STATUS_BONDED') {
      console.error(`${chain} Validator ${hostname} ${check_net} ${validator_name} Status: ${vstatus.status}`);
      online = false;
    }

    // Todo: Ensure Latest Block is Signed by Validator
    // onexd q block --node http://localhost:26757 | jq '.block.last_commit.signatures'

    // Record Validator Status
    let file = `${path}/${check}_${check_net}_status.json`;
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

checkHermes = async function(host) {
  try {
    if (!check_host) {
      check_host = hosts.hermes.local[check_net];
    }
    check_host = `${check_host}/metrics`;
    console.log('Checking Hermes Status', check_host);

    let response = await axios({
      url: `${check_host}`,
    });

    let resp = null;
    if (response.status == 200) {
      resp = response.data;
    } else {
      console.error('Invalid Response from Hermes. Code: ', response.status);
      return false;
    }

    let healthy = true;

    resp = resp.split("\n");
    let counts = {
      onex_status: 0,
      onomy_status: 0,
      backlog_size: 0,
      workers: 0,
    };
    for (let i = 0; i < resp.length; i++) {
      let line = resp[i];
      let s1 = line.split('{');
      if (s1.length == 2) {
        let s2 = s1[1].split('}');
        if (s2.length == 2) {
          let key = s1[0];
          let kvp = `{${s2[0]}}`;
          let stat = s2[1].trim();
          // console.log(key, {kvp, stat});
          if (key == 'queries_total') {
            let json = this.parseKvp(kvp);
            if (['status', 'rpc_status', 'grpc_status'].includes(json.query_type)) {
              // Only Increment Once per Query Type
              // console.log(key, {json, stat});
              if (stat >= 1) {
                if (json.chain.includes('onex-')) counts.onex_status++;
                if (json.chain.includes('onomy-')) counts.onomy_status++;
              }
            }
          } else if (['backlog_size', 'workers'].includes(key)) {
            counts[key] += parseInt(stat);
          }
        }
      }
    }

    console.log('Hermes', counts);

    if (counts.backlog_size > 5) {
      console.error(`Hermes Backlog High ${hostname} ${validator_name}`, counts.backlog_size);
      healthy = false;
    }
    if (counts.workers < 2) {
      console.error(`Hermes Worker Count Low ${hostname} ${validator_name}`, counts.workers);
      healthy = false;
    }
    if (counts.onex_status < 3) {
      console.error(`Hermes Onex Connection Issue ${hostname} ${validator_name}`, counts.onex_status);
      healthy = false;
    }
    if (counts.onex_status < 3) {
      console.error(`Hermes Onomy Connection Issue ${hostname} ${validator_name}`, counts.onomy_status);
      healthy = false;
    }

    console.log('Healthy', healthy);

    // Record Validator Status
    let file = `${path}/${check}_status.json`;
    let status = {vals: []};
    if (fs.existsSync(file)) {
      status = require(file);
    }
    // Add to top of array
    status.vals.unshift(healthy);
    // Splice to 10 (10 minutes)
    status.vals = status.vals.slice(0, 10);
    let status_str = JSON.stringify(status, null, 2);
    fs.writeFileSync(file, status_str);


    return (healthy ? true : false);
  } catch (err) {
    console.error(err);
    return false;
  }
}

parseKvp = function(str) {
  const regex = /([a-z]\w*)=((?:[^"]|"[^"]+")+?)(?=,\s*[a-z]\w*=|$)/g
  let m;
  let els = [];
  while ((m = regex.exec(str)) !== null) {
    els.push(`"${m[1]}": ${m[2]}`);
  }
  const json = '{' + els.join(',') + '}';
  return JSON.parse(json);
}

checkBlockStatus = async function() {
  let diff = false;
  let local_block_time_valid = true;
  let pub_block = false;
  let pub_blocks = [];
  let local_block = false;
  try {
    if (check == 'eth') { // Eth
      if (!config.etherscan_api_key) {
        console.error('Missing config.json etherscan_api_key');
        process.exit();
      }
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

      // Build Hosts Array
      let nom_hosts = hosts[check]['public'][check_net];
      if (typeof nom_hosts == 'string') {
        nom_hosts = [nom_hosts];
        if (hosts[check]['public'][`${check_net}_backup`]) {
          nom_hosts.push(hosts[check]['public'][`${check_net}_backup`]);
        }
      }
      // Check all Hosts
      for (let c = 0; c < nom_hosts.length; c++) {
        let nom_check = nom_hosts[c];
        let check_block = await getOnomyBlock(nom_check);
        if (check_block === false) {
          console.error(`Error Fetching Public ${check} Block ${check_net}`, nom_check);
        } else {
          pub_blocks.push(check_block);
        }
      }
      pub_block = Math.max(...pub_blocks);
      // Check Local Host
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
      timeout: 15000,
    });

    if (response.status == 200) {
      let json = response.data.result;
      return json.response.last_block_height;
      // return parseInt(hex, 16);
    } else {
      return false;
    }
  } catch (err) {
    if (err.cause) {
      console.error(err.cause);
    } else {
      console.error(err);
    }
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
    healthcheck_slug = healthcheck_slug.toLowerCase();
    let ping_url = `https://hc-ping.com/${config.healthchecksio_ping_key}/${healthcheck_slug}`;
    if (!healthy) {
      ping_url = `${ping_url}/fail`;
    }
    // console.log('URL', ping_url);
    if (config.curl_for_hcio) {
      let response = await exec(`curl -s ${ping_url}`);
    } else {
      let response = await axios({
        url: ping_url,
      });
    }
  } catch (err) {
    if (err.cause) {
      console.error(err.cause);
    } else if (err.response) {
        console.error(err.response.status, err.response.statusText);
    } else {
      console.error(err);
    }
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
