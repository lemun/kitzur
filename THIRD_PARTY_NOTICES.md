# Third-party notices

Kitzur has no runtime dependencies. Its source and generated data include the
following upstream material. License texts in [LICENSES/](LICENSES/) ship in both
the npm archive and offline bundle. Upstream notices were checked on 2026-10-02.

| Component | Material used | License and notice |
|---|---|---|
| [gobstopper v0.7.2, e894097](https://github.com/hraness/gobstopper/tree/e894097) | Adapted grouping, digests/hash chains, prefix store, replay, pairing and summary conventions in `src/engine/` | MIT option of its dual license; Copyright (c) 2026 hraness. [Full text](LICENSES/gobstopper-MIT.txt) |
| [CliffCompaction](https://github.com/nguyenvuthientrang/cliffcompaction) | Head + mechanical summary + tail design and shared summary header, via gobstopper | MIT; Copyright (c) 2026 Trang Nguyen. [Full text](LICENSES/CliffCompaction-MIT.txt), checked against [upstream LICENSE](https://raw.githubusercontent.com/nguyenvuthientrang/cliffcompaction/main/LICENSE) |
| [Hugging Face tokenizers 0.23.2](https://github.com/huggingface/tokenizers) | Behavior reproduced by the independent reader in `src/tokenize/tokenizer.ts`; Python development oracle | Apache-2.0 upstream; no tokenizer library code bundled. [License](LICENSES/Apache-2.0.txt) |
| [unicode-normalization-alignments 0.1.12](https://crates.io/crates/unicode-normalization-alignments/0.1.12) | Adapted NFC algorithm and generated normalization data in `src/tokenize/nfc9*` and `nfc-exceptions.ts` | MIT option; LICENSE-MIT: Copyright (c) 2015 The Rust Project Developers; normalization source: Copyright 2012-2015; source tables: Copyright 2012-2018 The Rust Project Developers. [MIT](LICENSES/unicode-normalization-alignments-MIT.txt), [COPYRIGHT](LICENSES/unicode-normalization-alignments-COPYRIGHT.txt) |
| [Oniguruma 6.9.10](https://github.com/kkos/oniguruma/tree/v6.9.10) | Generated Unicode property ranges in `src/tokenize/unicode-tables.ts` | BSD-2-Clause; library: Copyright (c) 2002-2021 K.Kosako; source table: Copyright (c) 2016-2024 K.Kosako. [Library notice](LICENSES/Oniguruma-BSD-2-Clause.txt), [table notice](LICENSES/Oniguruma-Unicode-Tables.txt) |
| [onig_sys 69.9.3](https://crates.io/crates/onig_sys/69.9.3) | Distribution from which Oniguruma tables were generated; no binding binary bundled | MIT binding notice: Copyright (c) 2015 Will Speak, Ivan Ivashchenko, and contributors. Oniguruma retains its separate license. [Full notice](LICENSES/onig_sys-MIT.md) |
| [Unicode Character Database](https://www.unicode.org/ucd/) | Unicode 9.0 normalization and Unicode 16.0 property data behind generated tables | [Unicode License v3](LICENSES/Unicode-3.0.txt), SPDX `Unicode-3.0`; Copyright © 1991-2026 Unicode, Inc. See [upstream licensing policy](https://www.unicode.org/policies/licensing_policy.html) and [license](https://www.unicode.org/license.txt) |
| [Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B) | Chat template under `scripts/tokenizer/`, TS template implementations, and tokenizer-derived golden test outputs | [Apache-2.0](LICENSES/Apache-2.0.txt), confirmed by the [model repository LICENSE](https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/LICENSE). Template implementations are adaptations; the `.jinja` file is the reference template. |

The Unicode notice above is the current upstream data/software license. The
normalization crate's older source notices and Oniguruma's table notice are also
retained rather than replaced by it.

CliffCompaction is described in “CliffCompaction: Cost-Efficient Compaction for
Long-Horizon Coding Agents” by Trang Nguyen, Eulrang Cho, Bingqing Chen and Tim
Dettmers (2026), [arXiv:2609.26779](https://arxiv.org/abs/2609.26779).

The Qwen `tokenizer.json`, model weights, gobstopper executable and Python virtual
environment are external development inputs and are not distributed. Small test
fixtures contain synthetic text, token IDs, counts and rendered-template outputs;
they are kept with the applicable notices above. Local test code and sanitized
scenario/reference code are covered by the repository's [MIT license](LICENSE).
