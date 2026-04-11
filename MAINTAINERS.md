# Maintainers

This repository maintains the ECAD Beacon SDK package line under the
`@ecadlabs/beacon-*` scope.

## Stewardship model

- Historical lineage: `airgap-it/beacon-sdk`
- External maintenance line we monitor: `trilitech/octez.connect`
- Supported packages from this repo: `@ecadlabs/beacon-*`
- Decision authority for releases and intake: ECAD maintainers

## Intake policy

- Prefer narrowly scoped ports from published upstream releases or pinned
  commits.
- Record the source release, `gitHead`, or commit in commit messages and pull
  requests.
- Do not treat external repos as automatic authority.
- Keep ECAD deltas explicit and reviewable.

## Release policy

- Merge via pull request into `taquito-patches`
- Require passing CI before merge
- Publish from signed tags through `.github/workflows/release.yml`
- Use npm Trusted Publishers, not long-lived automation tokens

## Operational notes

- The workflow filename configured in npm Trusted Publishers must match
  `.github/workflows/release.yml` exactly.
