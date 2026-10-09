# Provenance

This Skill is imported third-party guidance, not a repository-authored artifact. It is used as the
design checklist for MCP server and Tool work: input/output schemas, annotations, pagination, error
messages, and an evaluation question set.

- Origin: `C:\Users\61979\.codex\skills\mcp-builder` (the repository maintainer's local Codex Skill
  library), imported 2026-10-09.
- License: Apache-2.0. `LICENSE.txt` is retained unmodified and carries `Copyright 2026 Anthropic, PBC.`
- Fidelity: the ten files below are byte-identical to the imported source; the SHA-256 values were
  recomputed after the copy into this directory. `PROVENANCE.md` itself is the only addition.

| File | SHA-256 |
| --- | --- |
| `LICENSE.txt` | `bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362` |
| `SKILL.md` | `0f4592dcb53cf2b5d6b7febee6b4152018b565551a1c29e3c612f57b218ab295` |
| `reference/evaluation.md` | `8c99479f8a2d22a636c38e274537aac3610879e26f34e0709825077c4576f427` |
| `reference/mcp_best_practices.md` | `80fb4369a349447cf18ecdd7494fe7938b6065377e9f08c077cec411093a3007` |
| `reference/node_mcp_server.md` | `c3ba35a4f599dd53be9c6555ae72c19a7bf412cd5426576c2c08d42755482c66` |
| `reference/python_mcp_server.md` | `2da52f77e675191014ca2e146a4b95aa04d0ca7dd7e2b100322df15ade685e80` |
| `scripts/connections.py` | `9403668a2041568772082a8b334122c1f88daf0541fb393af4522d0094a47a6e` |
| `scripts/evaluation.py` | `49ed1d17cdce5da101b210197740713f49b935c29d4f339542a14b132658e6f7` |
| `scripts/example_evaluation.xml` | `9272b348ddcc4b06ba562367ccd0770e018158c0068ac5116d5e34aaeff8777a` |
| `scripts/requirements.txt` | `d5d7558b2368ecea9dfeed7d1fbc71ee9e0750bebd1282faa527d528a344c3c7` |

## Updating

Replace the ten upstream files from a newer source, recompute and record their SHA-256 values here,
then run `yarn skill:sync`, `yarn skill:check`, `yarn skill:test`, and `yarn skill:delivery`. Local
practice does not belong in this directory; the Skill-suite policy lives in the maintainer Skill's
`references/skill-maintenance.md`.
