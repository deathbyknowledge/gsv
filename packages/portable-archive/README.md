# @humansandmachines/gsv-portable-archive

Provider-neutral, encrypted streaming archives for moving a GSV deployment
without making a hosted service the owner of the user's data.

The package defines the canonical v1 container, manifest validation,
hash-chained logical frames, recovery-key encryption, lossless SQLite and
Durable Object KV values, and deterministic storage codecs. It uses Web APIs
and can run in browsers, Workers, and compatible JavaScript runtimes.

The `./ripgit` export is the public interoperability boundary for repository
snapshots. It decodes and authenticates ripgit's canonical manifest and page
frames, validates a complete object as a bounded manifest-first stream, and
converts fixed ripgit table counts into sorted portable SQLite inventory. Its
archive identity is only `{ owner, repo }`; live Durable Object IDs stay in the
runtime that owns them.

Provider account IDs, credentials, quotas, ownership checks, and restore
activation policy deliberately live outside this package. See the
[portable archive specification](https://github.com/deathbyknowledge/gsv/blob/main/docs/reference/portable-archive.md)
for the wire format and implementation requirements.

## License

MIT
