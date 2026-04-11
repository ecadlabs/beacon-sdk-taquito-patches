# `@ecadlabs/beacon-types`

Shared types used across the Beacon SDK packages.

This is a shared types package in the ECAD-maintained Beacon SDK line. Install it directly only when you need the Beacon type surface itself.

## Package provenance

This package is published from the ECAD-maintained Beacon SDK repository:
[ecadlabs/beacon-sdk-taquito-patches](https://github.com/ecadlabs/beacon-sdk-taquito-patches)

- Original Beacon lineage: [airgap-it/beacon-sdk](https://github.com/airgap-it/beacon-sdk)
- External maintenance line ECAD may selectively import from: [trilitech/octez.connect](https://github.com/trilitech/octez.connect)

## Usually install instead

- `@ecadlabs/beacon-sdk` for the general Beacon SDK surface
- `@ecadlabs/beacon-dapp` for dApp integrations
- `@ecadlabs/beacon-wallet` for wallet integrations
- `@taquito/beacon-wallet` if you are consuming Beacon through Taquito
## Notes

- ECAD publishes these packages under the neutral `@ecadlabs/beacon-*` scope
- Taquito consumes this package line directly where Beacon patches are needed
- Release notes, package policy, and the current package list live in the repository README
