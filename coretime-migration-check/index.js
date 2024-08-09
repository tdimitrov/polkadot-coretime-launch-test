// Import
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { blake2AsHex } = require('@polkadot/util-crypto');

function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function scheduler_agenda_exists(api) {
    const agenda = await api.query.scheduler.agenda.entries();
    let agenda_found = false;
    agenda.forEach(([{ args: [key] }, value]) => {
        if (value.isEmpty) {
            return;
        }
        if (value[0].toHuman().maybeId != '0x87a871b4d621f0b973475aafcc32610bd7688f1502338acd00ee488ac3620f4c') {
            return;
        }
        agenda_found = true;
    });

    return agenda_found;
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

//
// helpers
//
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

function assert_coretime_reservations(system_chains, coretime_reservation) {
    console.assert(system_chains.length == coretime_reservation.length, "System reservation count mismatch");

    const coretime_reservation_paras = coretime_reservation.map((para) => {
        console.assert(para.length == 1, "Coretime reservation entry is not a single entry");
        console.assert(para[0].mask == '0xffffffffffffffffffff', "Coretime reservation mask mismatch");

        return parse_pjs_int(para[0].assignment.Task); // TODO: this can be a `Pool` too but not in this migration
    });

    console.assert(system_chains.length > 0, "No system chains found");

    for (let i = 0; i < system_chains.length; i++) {
        console.assert(coretime_reservation_paras.includes(system_chains[i]), "System reservation mismatch");
    }

    return false;
}

function assert_coretime_leases(now, legacy_leases, coretime_leases) {
    // TODO: could be fetched onchain
    const lease_offset = 921_600;
    const lease_period = 1_209_600;
    const lease_index = Math.floor((now - lease_offset) / lease_period);
    const time_slice_period = 80;

    const expected_leases = legacy_leases
        .filter(([para_id, leases]) => para_id >= 2000 && leases > 0)
        .map(([para_id, leases]) => {
            // calculations here are from `migrate_send_assignments_to_coretime_chain`
            const valid_until = (lease_index + leases) * lease_period;
            const round_up = (valid_until % time_slice_period > 0) ? 1 : 0;
            const time_slice = Math.floor(valid_until / time_slice_period) + round_up * time_slice_period;
            return [para_id, time_slice];
        })
        .sort();

    console.log("Legacy leases: ", legacy_leases);
    console.log("Expected leases: ", expected_leases);
    console.log("Actual leases: ", coretime_leases);

    for (let i = 0; i < expected_leases.length; i++) {
        const idx = coretime_leases.findIndex(([para_id, _]) => para_id == expected_leases[i][0]);
        if (idx == -1) {
            console.log("Entry for para id not found", expected_leases[i]);
        } else if (expected_leases[i][1] != coretime_leases[idx][1]) {
            console.log("Entry found but time slices doesn't match", expected_leases[i], coretime_leases[idx]);
        }
    }
}

function parse_pjs_int(input) {
    return parseInt(input.replace(/,/g, ''));
}

async function get_legacy_paras(relay_chain_api) {
    return (await relay_chain_api.query.paras.parachains()).toHuman().map((para_id) => parse_pjs_int(para_id));
}

//Return number of leases per para iad
async function get_legacy_leases(relay_chain_api) {
    return (await relay_chain_api.query.slots.leases.entries()).map(([key, value]) => [parse_pjs_int(key.toHuman()[0]), value.toHuman().length]).sort();
}

async function get_coretime_reservations(coretime_chain_api) {
    return (await coretime_chain_api.query.broker.reservations()).toHuman();
}

async function get_coretime_leases(coretime_chain_api) {
    return (await coretime_chain_api.query.broker.leases())
        .toHuman()
        .map((lease) => {
            return [parse_pjs_int(lease.task), parse_pjs_int(lease.until)];
        })
        .sort();
}

async function main() {
    if (process.argv.length === 2) {
        console.error('Missing input: path to runtime binary');
        process.exit(1);
    }

    const runtime_binary_path = process.argv[2];    // because node script args.... bloody js
    const relay_chain_rpc_url = process.env.RELAY_CHAIN_RPC;
    const coretime_chain_rpc_url = process.env.CORETIME_CHAIN_RPC;

    if (relay_chain_rpc_url === undefined) {
        console.error('Missing ENV: RELAY_CHAIN_RPC');
        process.exit(1);
    }

    if (coretime_chain_rpc_url === undefined) {
        console.error('Missing ENV: CORETIME_CHAIN_RPC');
        process.exit(1);
    }

    const wsRelayChainProvider = new WsProvider(relay_chain_rpc_url);
    const relay_chain_api = await ApiPromise.create({ provider: wsRelayChainProvider });

    const now = (await relay_chain_api.rpc.chain.getHeader()).number.toNumber();
    console.log("Current block number", now);

    // Agenda should exist before the migration
    console.log("Checking scheduler agenda");
    console.assert(await scheduler_agenda_exists(relay_chain_api), 'Agenda entry not found');

    console.log("Fetching state before migration");
    const legacy_paras_before_migration = await get_legacy_paras(relay_chain_api);
    const leases_before_migration = await get_legacy_leases(relay_chain_api);
    const system_chains_before_migration = legacy_paras_before_migration.filter((para_id) => parachain_id_is_system_chain(para_id));

    console.log("Upgrading runtime");
    await perform_runtime_upgrade(relay_chain_api, runtime_binary_path);
    // TODO: wait for the runtime migration to complete
    await sleep(2000);
    console.log("Upgrade complete");

    // Agenda should exist before the migration
    console.log("Checking scheduler agenda");
    console.assert(!await scheduler_agenda_exists(relay_chain_api), 'Agenda entry is not removed');

    console.log("Fetching state after migration");
    const legacy_paras_after_migration = await get_legacy_paras(relay_chain_api);
    const leases_after_migration = await get_legacy_leases(relay_chain_api);

    assert_arrays(legacy_paras_before_migration, legacy_paras_after_migration, "Legacy paras");

    const coretime_chain_api = await ApiPromise.create({ provider: new WsProvider(coretime_chain_rpc_url) });
    const coretime_reservations = await get_coretime_reservations(coretime_chain_api);
    assert_coretime_reservations(system_chains_before_migration, coretime_reservations);

    const coretime_leases = await get_coretime_leases(coretime_chain_api);
    assert_coretime_leases(now + 1, leases_before_migration, coretime_leases);

    //TODO: assert scheduler config

    console.log("DONE");
}

main().catch(console.error).finally(() => process.exit());

