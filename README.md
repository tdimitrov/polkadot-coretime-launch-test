# Agile coretime runtime migration tests
The repo contains a test script based on chopsticks verifying runtime migrations for Agile Coretime
launch on Polkadot.

# How to use
1. Build a polkadot runtime binary by executing `cargo build --release -p polkadot-runtime`.
2. Create `artefacts` subdir and put `polkadot_runtime.compact.compressed.wasm` there.
3. Run `docker-compose up`
4. Inspect test logs with `docker-compose logs -f check`