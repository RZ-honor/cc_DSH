# SWE-bench local data

Place the official `princeton-nlp/SWE-bench` **test** parquet here as
`test-00000-of-00001.parquet`, or set `SWEBENCH_PARQUET` to its path.

Then:

```bash
bun swebench/convert.ts
```

`instances.jsonl` is gitignored (regenerable, ~130 MB). Gold `patch` /
`test_patch` stay on disk for local verification only and are never sent
to the model.
