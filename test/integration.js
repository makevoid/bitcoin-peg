'use strict'

const { writeFileSync, mkdirSync } = require('fs')
const { randomBytes } = require('crypto')
const { join } = require('path')
const { tmpdir } = require('os')
const test = require('ava')
const secp = require('secp256k1')
const base58 = require('bs58check')
const createBitcoind = require('bitcoind')
const lotion = require('lotion')
const tendermint = require('tendermint-node')
const coins = require('coins')
const peg = require('..')

// TODO: don't monkey patch, let us pass in regtest params to webcoin
const params = require('webcoin-bitcoin').net
params.dnsSeeds = []
params.webSeeds = []
params.staticPeers = [ 'localhost' ]
params.defaultPort = 18444
params.magic = 0xdab5bffa

const VALIDATOR_COUNT = 2

test('integration (bitcoind + lotion app + relayers)', async (t) => {
  let dataPath = join(tmpdir(), Math.random().toString(36))
  let bitcoinPath = join(dataPath, 'bitcoin')
  mkdirSync(dataPath)
  mkdirSync(bitcoinPath)
  console.log('set up data dir:', dataPath)

  let bitcoind = createBitcoind({
    regtest: true,
    datadir: bitcoinPath,
    debug: 1,
    deprecatedrpc: 'signrawtransaction',
    txindex: 1
  })
  await bitcoind.started()
  console.log('started bitcoind')

  await bitcoind.rpc.generate(200)
  let genesisHash = await bitcoind.rpc.getBlockHash(0)
  let genesisBlockRpc = await bitcoind.rpc.getBlock(genesisHash)
  let genesisBlock = {
    height: 0,
    bits: parseInt(genesisBlockRpc.bits, 16),
    nonce: genesisBlockRpc.nonce,
    version: genesisBlockRpc.version,
    merkleRoot: Buffer.from(genesisBlockRpc.merkleroot, 'hex').reverse(),
    timestamp: genesisBlockRpc.time,
    prevHash: Buffer.alloc(32)
  }
  console.log('generated bitcoin blocks')

  let validators = []
  for (let i = 0; i < VALIDATOR_COUNT; i++) {
    let privValidatorJson = tendermint.genValidator()
    let privValidator = JSON.parse(privValidatorJson)
    let privValidatorPath = join(dataPath, `priv_validator${i}.json`)
    writeFileSync(privValidatorPath, privValidatorJson)
    validators.push({ privValidator, privValidatorPath })
  }

  let genesisPath = join(dataPath, 'genesis.json')
  writeFileSync(genesisPath, createGenesis(validators))

  let startPromises = []
  for (let i = 0; i < validators.length; i++) {
    let v = validators[i]
    let app = lotion({
      initialState: {},
      keyPath: v.privValidatorPath,
      genesisPath,
      p2pPort: 10800 + i,
      rpcPort: 10900 + i,
      peers: [ 'localhost:10800' ]
    })
    app.use('bitcoin', peg(genesisBlock, 'pbtc', {
      noRetargeting: true
    }))
    app.use('pbtc', coins({
      handlers: {
        bitcoin: peg.coinsHandler('bitcoin')
      }
    }))
    startPromises.push(app.start())
  }
  let appInfo = (await Promise.all(startPromises))[0]
  console.log('started peg network nodes')

  await new Promise((resolve) => setTimeout(resolve, 1000))
  let client = await lotion.connect(appInfo.GCI)
  console.log('connected lotion client')

  // check initial peg state
  deepEqual(t, await client.state.bitcoin, {
    chain: [ genesisBlock ],
    processedTxs: {},
    signatoryKeys: {},
    signedTx: null,
    prevSignedTx: null,
    signingTx: null,
    utxos: [],
    withdrawals: []
  })

  // signatory key commitment
  t.deepEqual(await client.state.bitcoin.signatoryKeys, {})
  for (let v of validators) {
    v.signatoryPriv = randomBytes(32)
    let signatoryPub = secp.publicKeyCreate(v.signatoryPriv)
    await peg.signatory.commitPubkey(client, v.privValidator, signatoryPub)
    let signatoryKeyState = await client.state.bitcoin.signatoryKeys
    t.true(signatoryKeyState[v.privValidator.pub_key.value].equals(signatoryPub), 'signatory key is in state')
  }
  let signatoryKeyState = await client.state.bitcoin.signatoryKeys
  t.is(Object.keys(signatoryKeyState).length, VALIDATOR_COUNT)
  console.log('committed signatory keys')

  // header relay
  await peg.relay.relayHeaders(client, {
    netOpts: { numPeers: 1 },
    chainOpts: {
      maxTarget: Buffer.from('7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex'),
      noRetargeting: true
    }
  })
  t.is(await client.state.bitcoin.chain.length, 201)
  console.log('relayed bitcoin headers')

  // create coins wallet
  let privKey = randomBytes(32)
  let wallet = coins.wallet(privKey, client, { route: 'pbtc' })
  let addressHash = base58.decode(wallet.address())

  // sned deposit on bitcoin blockchain
  let utxos = (await bitcoind.rpc.listUnspent())
    .map((utxo) => ({
      vout: utxo.vout,
      txid: Buffer.from(utxo.txid, 'hex').reverse(),
      value: utxo.amount * 1e8
    }))
    .slice(0, 2)
  let depositTx = peg.deposit.createTx(
    peg.relay.convertValidatorsToLotion(client.validators),
    signatoryKeyState,
    utxos,
    addressHash
  )
  let signedDepositTx = await bitcoind.rpc.signRawTransaction(depositTx.toHex())
  let depositTxidHex = await bitcoind.rpc.sendRawTransaction(signedDepositTx.hex)
  let depositTxid = Buffer.from(depositTxidHex, 'hex')
  await bitcoind.rpc.generate(1)
  console.log('sent deposit transaction')

  // relay deposit
  await peg.relay.relayDeposits(client)
  deepEqual(t, await client.state.bitcoin.processedTxs, {
    [depositTxid.toString('base64')]: true
  })
  deepEqual(t, await client.state.bitcoin.utxos, [{
    amount: 9999990000,
    index: 0,
    txid: depositTxid
  }])
  deepEqual(t, await client.state.pbtc.accounts, {
    [wallet.address()]: {
      balance: 9999990000,
      sequence: 0
    }
  })
  console.log('relayed deposit')

  await wallet.send({
    type: 'bitcoin',
    amount: 1e8,
    script: Buffer.from([ 1, 2, 3, 4 ])
  })
  deepEqual(t, await client.state.bitcoin.utxos, [])
  deepEqual(t, await client.state.bitcoin.withdrawals, []) // (already processed and put into "signingTx")
  t.is(await client.state.bitcoin.signedTx, null)
  deepEqual(t, await client.state.bitcoin.signingTx, {
    inputs: [{
      amount: 9999990000,
      index: 0,
      txid: depositTxid
    }],
    outputs: [{
      amount: 1e8,
      script: Buffer.from([ 1, 2, 3, 4 ])
    }],
    signatures: [],
    signedVotingPower: 0
  })
  console.log('sent withdrawal transaction')

  for (let i = 0; i < Math.ceil((2 / 3) * VALIDATOR_COUNT); i++) {
    let v = validators[i]
    await peg.signatory.signDisbursal(client, v.signatoryPriv)
  }
  let signedTx = await client.state.bitcoin.signedTx
  let disbursalTx = peg.relay.buildDisbursalTransaction(
    signedTx,
    peg.relay.convertValidatorsToLotion(client.validators),
    signatoryKeyState
  )
  t.is(await client.state.bitcoin.signingTx, null)
  t.is(signedTx.signatures.length, 2)
  t.is(signedTx.signedVotingPower, 20)
  deepEqual(t, await client.state.bitcoin.utxos, [{
    amount: 9899990000,
    index: 1,
    txid: disbursalTx.getHash()
  }])
  console.log('signed disbursal transaction')

  await bitcoind.rpc.sendRawTransaction(disbursalTx.toHex())
  t.deepEqual(await bitcoind.rpc.getRawMempool(), [ disbursalTx.getId() ])
  console.log('relayed disbursal transaction')

  // cleanup
  bitcoind.kill()
})

function createGenesis (validators) {
  return `
    {
      "genesis_time": "2019-01-03T18:15:05.000Z",
      "chain_id": "bitcoin-peg",
      "consensus_params": {
        "block_size_params": {
          "max_bytes": "22020096",
          "max_gas": "-1"
        },
        "evidence_params": {
          "max_age": "100000"
        }
      },
      "validators": [
        ${validators.map((v) => `
          {
            "address": "${v.privValidator.address}",
            "pub_key": {
              "type": "tendermint/PubKeyEd25519",
              "value": "${v.privValidator.pub_key.value}"
            },
            "power": "10",
            "name": ""
          }
        `).join(',\n')}
      ],
      "app_hash": ""
    }
  `
}

// deep equal that supports Buffers
function deepEqual (t, a, b) {
  function clone (src) {
    let dest = {}
    for (let [ key, value ] in Object.entries(src)) {
      if (Buffer.isBuffer(value)) {
        dest[key] = ':Buffer:' + value.toString('hex')
      } else if (typeof value === 'object' && value != null) {
        dest[key] = clone(value)
      } else {
        dest[key] = value
      }
    }
    return dest
  }

  let a2 = clone(a)
  let b2 = clone(b)
  return t.deepEqual(a2, b2)
}
