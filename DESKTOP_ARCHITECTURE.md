# Desktop Architecture

## Target Shape

- `Tauri` shell for drag-and-drop and native file selection
- web UI for rendering and interaction
- bundled local data service for indexed genomic access

## Why

Large local BAM and FASTA files should be opened by path, not streamed wholesale into browser memory.
The desktop shell can hand native paths to the local service, which should ship inside the app and query indexed windows without relying on external user installs.

## Current Prototype

- browser UI in `app/`
- Python local service in `server.py`
- session-based file registration by path
- reference, BAM, VCF, and GFF queries by visible locus
- prototype uses external `samtools` only as a temporary development dependency

## Planned Refactor

1. Replace HTTP polling with a Tauri command bridge.
2. Move file parsing/index validation into a dedicated bundled service layer.
3. Replace `samtools` subprocess calls with direct Rust/htslib bindings for lower latency and self-contained distribution.
4. Add session persistence and recent files.
5. Extend the annotation layer to support `GTF`, `BED`, and `GenBank`.
