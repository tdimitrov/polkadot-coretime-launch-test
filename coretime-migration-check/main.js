// Import
const { ApiPromise, WsProvider } = require('@polkadot/api');
const helpers = require('./helpers');

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

function assert_coretime_reservations(system_chains, coretime_reservation) {
    console.assert(system_chains.length == coretime_reservation.length, `System reservation count mismatch - system chains len: ${system_chains.length} coretime reservation len: ${coretime_reservation.length}`);

    const coretime_reservation_paras = coretime_reservation.map((para) => {
        console.assert(para.length == 1, "Coretime reservation entry is not a single entry");
        console.assert(para[0].mask == '0xffffffffffffffffffff', "Coretime reservation mask mismatch");

        return helpers.parse_pjs_int(para[0].assignment.Task); // TODO: this can be a `Pool` too but not in this migration
    });

    console.assert(system_chains.length > 0, "No system chains found");

    for (let i = 0; i < system_chains.length; i++) {
        console.assert(coretime_reservation_paras.includes(system_chains[i]), `System reservation mismatch for para id ${system_chains[i]}`);
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

//Return number of leases per para id
async function get_legacy_leases(relay_chain_api) {
    return (await relay_chain_api.query.slots.leases.entries()).map(([key, value]) => [helpers.parse_pjs_int(key.toHuman()[0]), value.toHuman().length]).sort();
}

async function get_coretime_reservations(coretime_chain_api) {
    return (await coretime_chain_api.query.broker.reservations()).toHuman();
}

async function get_coretime_leases(coretime_chain_api) {
    return (await coretime_chain_api.query.broker.leases())
        .toHuman()
        .map((lease) => {
            return [helpers.parse_pjs_int(lease.task), helpers.parse_pjs_int(lease.until)];
        })
        .sort();
}

async function get_coretime_core_count_inbox(coretime_chain_api) {
    return helpers.parse_pjs_int((await coretime_chain_api.query.broker.coreCountInbox()).toHuman());
}

async function get_scheduler_num_cores(relay_chain_api) {
    return helpers.parse_pjs_int((await relay_chain_api.query.configuration.activeConfig()).toHuman().schedulerParams.numCores);
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
    const leases_before_migration = await get_legacy_leases(relay_chain_api);
    const system_leases_before_migration = leases_before_migration.map(([para_id, _]) => para_id).filter((para_id) => helpers.parachain_id_is_system_chain(para_id));

    console.log("Upgrading runtime");
    await helpers.perform_runtime_upgrade(relay_chain_api, runtime_binary_path);
    // TODO: wait for the runtime migration to complete
    await helpers.sleep(2000);
    console.log("Upgrade complete");

    // Agenda should not exist after the migration
    console.log("Checking scheduler agenda");
    console.assert(!await scheduler_agenda_exists(relay_chain_api), 'Agenda entry is not removed');

    console.log("Fetching state after migration");
    const leases_after_migration = await get_legacy_leases(relay_chain_api);
    helpers.assert_array_of_arrays(leases_before_migration, leases_after_migration, "Leases");

    const coretime_chain_api = await ApiPromise.create({ provider: new WsProvider(coretime_chain_rpc_url) });

    const coretime_reservations = await get_coretime_reservations(coretime_chain_api);
    assert_coretime_reservations(system_leases_before_migration, coretime_reservations);

    const coretime_leases = await get_coretime_leases(coretime_chain_api);
    assert_coretime_leases(now + 1, leases_before_migration, coretime_leases);

    const num_cores = await get_scheduler_num_cores(relay_chain_api);
    const core_count_inbox = await get_coretime_core_count_inbox(coretime_chain_api);
    console.assert(num_cores == core_count_inbox, "Core count mismatch");

    // The migration itself is not supposed to create any pools but if this changes - log it
    const active_leases_after_migration = leases_after_migration.filter(([_, leases]) => leases > 0);
    console.assert(active_leases_after_migration.length == num_cores, `Pool creation should be verified. Non zero leases: ${active_leases_after_migration.length} num_cores: ${num_cores}`);

    console.log("Done. Inspect the output for failed assertions.");
}

main().catch(console.error).finally(() => process.exit());

