var BN = require('bn.js');
var Web3 = require('web3');
var Ganache = require(process.env.TEST_BUILD ? "../build/ganache.core." + process.env.TEST_BUILD + ".js" : "../index.js");
var assert = require('assert');
var to = require("../lib/utils/to.js");
var solc = require("solc");
var pify = require("pify");

// Thanks solc. At least this works!
// This removes solc's overzealous uncaughtException event handler.
process.removeAllListeners("uncaughtException");

describe("Mining", function() {
  var web3 = new Web3(Ganache.provider({
    vmErrorsOnRPCResponse: true
    //logger: console,
  }));
  var accounts;
  var snapshot_id;
  var badBytecode;
  var goodBytecode;

  before("compile solidity code that causes runtime errors", async function() {
    this.timeout(10000)
    let result = await compileSolidity("pragma solidity ^0.4.2; contract Example { function Example() {throw;} }");
    badBytecode = result.code;
  });

  before("compile solidity code that causes an event", async function() {
    this.timeout(10000)
    let result = await compileSolidity("pragma solidity ^0.4.2; contract Example { event Event(); function Example() { Event(); } }");
    goodBytecode = result.code;
  });

  beforeEach("checkpoint, so that we can revert later", async function() {
    let res = await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "evm_snapshot",
      id: new Date().getTime()
    });

    snapshot_id = res.result;
  });

  afterEach("revert back to checkpoint", async function() {
    await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "evm_revert",
      params: [snapshot_id],
      id: new Date().getTime()
    });
  });

  // Everything's a Promise to add in readibility.
  async function getBlockNumber() {
    return to.number(await web3.eth.getBlockNumber())
  };

  async function startMining() {
    await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "miner_start",
      params: [1],
      id: new Date().getTime()
    });
  }

  async function stopMining() {
    await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "miner_stop",
      id: new Date().getTime()
    });
  }

  async function checkMining() {
    let response = await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "eth_mining",
      id: new Date().getTime()
    });

    return response.result;
  }

  async function mineSingleBlock() {
    let result = await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "evm_mine",
      id: new Date().getTime()
    });
    assert.deepEqual(result.result, "0x0");
  }

  async function queueTransaction(from, to, gasLimit, value, data) {
    let response = await pify(web3.currentProvider.send)({
      jsonrpc: "2.0",
      method: "eth_sendTransaction",
      id: new Date().getTime(),
      params: [{
        from: from,
        to: to,
        gas: gasLimit,
        value: value,
        data: data
      }]
    })
    if (response.error) {
      throw new Error(response.error.message)
    }
    return response.result
  }

  async function getCode(address) {
    return await web3.eth.getCode(address);
  };

  function compileSolidity(source) {
    let result = solc.compile({sources: {"Contract.sol": source}});
    return Promise.resolve({code: "0x" + result.contracts[Object.keys(result.contracts)[0]].bytecode})
  };

  before(async function() {
    accounts = await web3.eth.getAccounts()
  });

  it("should mine a single block with two queued transactions", async function() {
    await stopMining()
    let blockNumber = await getBlockNumber();

    let tx1 = await queueTransaction(accounts[0], accounts[1], 90000, web3.utils.toWei(new BN(2), "ether"));
    let receipt1 = await web3.eth.getTransactionReceipt(tx1);
    assert.equal(receipt1, null);

    let tx2 = await queueTransaction(accounts[0], accounts[1], 90000, web3.utils.toWei(new BN(3), "ether"));
    let receipt2 = await web3.eth.getTransactionReceipt(tx2);
    assert.equal(receipt2, null);

    await startMining();

    let receipts = await Promise.all([web3.eth.getTransactionReceipt(tx1), web3.eth.getTransactionReceipt(tx2)]);

    assert.equal(receipts.length, 2);

    assert.notEqual(receipts[0], null);
    assert.equal(receipts[0].transactionHash, tx1);
    assert.notEqual(receipts[1], null);
    assert.equal(receipts[1].transactionHash, tx2);
    assert.equal(receipts[0].blockNumber, receipts[1].blockNumber, "Transactions should be mined in the same block.");

    let number = await getBlockNumber();
    assert.equal(number, blockNumber + 1);
  });

  it("should mine two blocks when two queued transactions won't fit into a single block", async function() {
    // This is a very similar test to the above, except the gas limits are much higher
    // per transaction. This means the Ganache will react differently and process
    // each transaction it its own block.

    await stopMining();
    let blockNumber = await getBlockNumber();

    let tx1 = await queueTransaction(accounts[0], accounts[1], 4000000, web3.utils.toWei(new BN(2), "ether"));
    let receipt1 = await web3.eth.getTransactionReceipt(tx1);
    assert.equal(receipt1, null);

    let tx2 = await queueTransaction(accounts[0], accounts[1], 4000000, web3.utils.toWei(new BN(3), "ether"));
    let receipt2 = await web3.eth.getTransactionReceipt(tx2);
    assert.equal(receipt2, null);

    await startMining();

    let receipts = await Promise.all([web3.eth.getTransactionReceipt(tx1), web3.eth.getTransactionReceipt(tx2)]);

    assert.equal(receipts.length, 2);

    assert.notEqual(receipts[0], null);
    assert.equal(receipts[0].transactionHash, tx1);

    assert.notEqual(receipts[1], null);
    assert.equal(receipts[1].transactionHash, tx2);

    assert.notEqual(receipts[0].blockNumber, receipts[1].blockNumber, "Transactions should not be mined in the same block.");

    let number = await getBlockNumber();
    assert.equal(number, blockNumber + 2);
  });

  it("should mine one block when requested, and only one transaction, when two queued transactions together are larger than a single block", async function() {
    // This is a very similar test to the above, except we don't start mining again,
    // we only mine one block by request.

    await stopMining()
    let blockNumber = await getBlockNumber();
    let tx1 = await queueTransaction(accounts[0], accounts[1], 4000000, web3.utils.toWei(new BN(2), "ether"));
    let receipt1 = await web3.eth.getTransactionReceipt(tx1);
    assert.equal(receipt1, null);

    let tx2 = await queueTransaction(accounts[0], accounts[1], 4000000, web3.utils.toWei(new BN(3), "ether"));
    let receipt2 = await web3.eth.getTransactionReceipt(tx2);
    assert.equal(receipt2, null);

    await mineSingleBlock();

    let receipts = await Promise.all([web3.eth.getTransactionReceipt(tx1), web3.eth.getTransactionReceipt(tx2)]);

    assert.equal(receipts.length, 2);

    assert.notEqual(receipts[0], null);
    assert.equal(receipts[0].transactionHash, tx1);

    assert.equal(receipts[1], null);

    let number = await getBlockNumber();
    assert.equal(number, blockNumber + 1);
  });

  it("should error if queued transaction exceeds the block gas limit", async function() {
    try {
      await stopMining()
      let tx1 = await queueTransaction(accounts[0], accounts[1], 10000000, web3.utils.toWei(new BN(2), "ether"));
      assert.fail("Transaction was processed without erroring; gas limit should have been too high");
    } catch (err) {
      // We caught an error like we expected. Ensure it's the right error, or rethrow.
      if (err.message.toLowerCase().indexOf("exceeds block gas limit") < 0) {
        assert.fail("Did not receive expected error; instead received: " + err);
      }
    }
  });

  it("should error via instamining when queued transaction throws a runtime errors", async function() {
    try {
      await startMining()
      // This transaction should be processed immediately.
      let tx1 = await queueTransaction(accounts[0], null, 3141592, 0, badBytecode);
      assert.fail("Execution should never get here as we expected `eth_sendTransaction` to throw an error")
    } catch (err) {
      if (err.message.indexOf("VM Exception while processing transaction") != 0) {
        assert.fail("Received error we didn't expect: " + err);
      }
    }
  });

  it("should error via evm_mine when queued transaction throws a runtime errors", async function() {
    try {
      await stopMining()
      await queueTransaction(accounts[0], null, 3141592, 0, badBytecode);
      await mineSingleBlock();
      assert.fail("Execution should never get here as we expected `evm_mine` to throw an error")
    } catch (err) {
      if (err.message.indexOf("VM Exception while processing transaction") != 0) {
        assert.fail("Received error we didn't expect: " + err);
      }
    }
  });

  it("should error via evm_mine when multiple queued transactions throw runtime errors in a single block", async function() {
    // Note: The two transactions queued in this test do not exceed the block gas limit
    // and thus should fit within a single block.

    try {
      await stopMining()
      await queueTransaction(accounts[0], null, 1000000, 0, badBytecode);
      await queueTransaction(accounts[0], null, 1000000, 0, badBytecode);
      await mineSingleBlock();
      assert.fail("Execution should never get here as we expected `evm_mine` to throw an error")
    } catch (err) {
      if (err.message.indexOf("Multiple VM Exceptions while processing transactions") != 0) {
        assert.fail("Received error we didn't expect: " + err);
      }
      // We got the error we wanted. Test passed!
    }
  });

  it("should error via miner_start when multiple queued transactions throw runtime errors in multiple blocks", async function() {
    // Note: The two transactions queued in this test together DO exceed the block gas limit
    // and thus will fit in two blocks, one block each.

    try { 
      await stopMining()
      await queueTransaction(accounts[0], null, 3141592, 0, badBytecode);
      await queueTransaction(accounts[0], null, 3141592, 0, badBytecode);
      await startMining();
      assert.fail("Execution should never get here as we expected `miner_start` to throw an error")
    } catch (err) {
      if (err.message.indexOf("Multiple VM Exceptions while processing transactions") != 0) {
        assert.fail("Received error we didn't expect: " + err);
      }
      // We got the error we wanted. Test passed!
    }
  });

  it("even if we receive a runtime error, logs for successful transactions need to be processed", async function() {
    // Note: The two transactions queued in this test should exist within the same block.
    let tx1, tx2;

    try {
      await stopMining()

      tx1 = await queueTransaction(accounts[0], null, 1000000, 0, badBytecode);
      tx2 = await queueTransaction(accounts[0], null, 1000000, 0, goodBytecode);

      await startMining();
      assert.fail("Execution should never get here as we expected `miner_start` to throw an error")
    } catch (err) {
      if (err.message.indexOf("VM Exception while processing transaction") != 0) {
        assert.fail("Received error we didn't expect: " + err);
      }

      // We got the error we wanted. Now check to see if the transaction was processed correctly.
      let receiptTx2 = await web3.eth.getTransactionReceipt(tx2)

      // We should have a receipt for the second transaction - it should have been processed.
      assert.notEqual(receiptTx2, null);
      assert.notEqual(receiptTx2, {});

      // It also should have logs.
      assert.notEqual(receiptTx2.logs.length, 0);

      // Now check that there's code at the address, which means it deployed successfully.
      let code = await getCode(receiptTx2.contractAddress);

      // Convert hex to a big number and ensure it's not zero.
      assert(web3.utils.toBN(code).eq(0) == false);

    }
  });

  it("should return the correct value for eth_mining when miner started and stopped", async function() {
    await stopMining()
    let isMining = await checkMining();
    assert(!isMining);
    await startMining();
    isMining = await checkMining();
    assert(isMining);
  });
});
