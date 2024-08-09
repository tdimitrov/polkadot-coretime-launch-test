const { blake2AsHex } = require('@polkadot/util-crypto');

// Block for a certain amount of time in ms
function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

function parachain_id_is_system_chain(id) {
    return id < 2000;
}

function assert_arrays(before, after, msg) {
    if (before.length != after.length) {
        console.log(`${msg} count mismatch: ${before.length} != ${after.length}`);
    }
    for (let i = 0; i < before.length; i++) {
        if (before[i] != after[i]) {
            console.assert(false, `${msg} mismatch: ${before[i]} != ${after[i]}`);
        }
    }
}

function parse_pjs_int(input) {
    return parseInt(input.replace(/,/g, ''));
}

async function perform_runtime_upgrade(api, runtime_binary_path) {
    const fs = require('fs');

    // Grab the block number of the current head
    // api is already imported, no need to add anything but the following.
    const number = (await api.rpc.chain.getHeader()).number.toNumber()

    const code = fs.readFileSync(runtime_binary_path).toString('hex');
    const code_hash = blake2AsHex(`0x${code}`).substring(2);

    // use chopsticks dev_setStorage to inject the call into the scheduler state for the next block.
    await api.rpc('dev_setStorage', {
        scheduler: {
            agenda: [
                [
                    [number + 1], [
                        {
                            call: {
                                Inline: `0x0009${code_hash}`
                            },
                            origin: {
                                system: 'Root'
                            }
                        }
                    ]
                ]
            ]
        }
    })
    // Make a block to include the extrinsic
    await api.rpc('dev_newBlock', { count: 1 });

    await api.tx.system.applyAuthorizedUpgrade(`0x${code}`).send();
    await api.rpc('dev_newBlock', { count: 1 });
}


module.exports = { sleep, parachain_id_is_system_chain, assert_arrays, parse_pjs_int, perform_runtime_upgrade };