#!/usr/bin/env python3

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Set

try:
    import pysam
except ImportError:
    pysam = None


ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
DATA_DIR = ROOT / "data"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))


def read_manifest() -> Dict:
    manifest_path = DATA_DIR / "manifest.json"
    if not manifest_path.exists():
        return {
            "reference": None,
            "bam": None,
            "bams": [],
            "vcf": None,
            "contigs": [],
        }
    return json.loads(manifest_path.read_text())


def read_fasta_index(path: Path) -> List[Dict]:
    fai = Path(f"{path}.fai")
    if not fai.exists():
        raise ValueError(f"Missing FASTA index: {fai}")

    contigs = []
    with fai.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            fields = line.split("\t")
            if len(fields) < 2:
                continue
            contigs.append({"name": fields[0], "length": int(fields[1])})
    return contigs


def resolve_configured_path(value: Optional[str]) -> Optional[Path]:
    if not value:
        return None
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate
    return (DATA_DIR / value).resolve()


def parse_alignment_payload(payload: Dict) -> List[Path]:
    if "bams" in payload:
        raw_values = payload.get("bams") or []
        if not isinstance(raw_values, list):
            raise ValueError("Alignment file list must be an array of paths")
        values = [str(item).strip() for item in raw_values if str(item).strip()]
    else:
        raw_value = str(payload.get("bam") or "")
        values = [chunk.strip() for chunk in raw_value.replace("\r", "\n").replace(",", "\n").split("\n") if chunk.strip()]
    return [Path(value).expanduser() for value in values]


def parse_info_string(info: str) -> Dict[str, str]:
    if not info or info == ".":
        return {}
    parsed: Dict[str, str] = {}
    for fragment in info.split(";"):
        if not fragment:
            continue
        if "=" in fragment:
            key, value = fragment.split("=", 1)
            parsed[key] = value
        else:
            parsed[fragment] = "true"
    return parsed


def parse_effect_schema_from_header(line: str, field_id: str) -> Optional[List[str]]:
    if not line.startswith(f"##INFO=<ID={field_id},"):
        return None
    match = re.search(r"(?:Format|Functional annotations):\s*['\"]([^'\"]+)['\"]", line)
    if not match:
        return None
    return [part.strip() for part in match.group(1).split("|")]


def default_effect_schema(field_id: str) -> List[str]:
    if field_id == "ANN":
        return [
            "Allele",
            "Annotation",
            "Impact",
            "Gene_Name",
            "Gene_ID",
            "Feature_Type",
            "Feature_ID",
            "Transcript_BioType",
            "Rank",
            "HGVS.c",
            "HGVS.p",
            "cDNA.pos",
            "CDS.pos",
            "AA.pos",
            "Distance",
            "Warnings",
        ]
    return [
        "Allele",
        "Consequence",
        "Impact",
        "Symbol",
        "Gene",
        "Feature_type",
        "Feature",
        "Biotype",
        "Exon",
        "Intron",
        "HGVSc",
        "HGVSp",
    ]


def summarize_effect(effect: Dict) -> Dict:
    consequence = (
        effect.get("Annotation")
        or effect.get("Consequence")
        or effect.get("Effect")
        or effect.get("annotation")
        or effect.get("consequence")
    )
    gene = (
        effect.get("Gene_Name")
        or effect.get("SYMBOL")
        or effect.get("Symbol")
        or effect.get("Gene")
        or effect.get("gene")
    )
    feature = (
        effect.get("Feature_ID")
        or effect.get("Feature")
        or effect.get("Transcript")
        or effect.get("feature")
    )
    impact = (
        effect.get("Impact")
        or effect.get("IMPACT")
        or effect.get("impact")
    )
    protein_change = (
        effect.get("HGVS.p")
        or effect.get("HGVSp")
        or effect.get("Protein_position")
        or effect.get("protein_change")
    )
    coding_change = (
        effect.get("HGVS.c")
        or effect.get("HGVSc")
        or effect.get("coding_change")
    )
    return {
        "consequence": consequence or "NA",
        "gene": gene or "NA",
        "feature": feature or "NA",
        "impact": impact or "NA",
        "proteinChange": protein_change or "NA",
        "codingChange": coding_change or "NA",
    }


def parse_effect_entries(raw_value: str, schema: List[str], source: str) -> List[Dict]:
    if not raw_value:
        return []
    fields = schema or default_effect_schema(source)
    effects = []
    for raw_entry in raw_value.split(","):
        entry = raw_entry.strip()
        if not entry:
            continue
        parts = entry.split("|")
        effect = {
            fields[index] if index < len(fields) else f"Field_{index + 1}": parts[index]
            for index in range(len(parts))
        }
        effect["source"] = source
        effect["summary"] = summarize_effect(effect)
        effects.append(effect)
    return effects


def run_command(args: List[str]) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=True)
    return result.stdout


def samtools_executable() -> str:
    candidates = ["samtools.exe", "samtools"] if sys.platform.startswith("win") else ["samtools"]
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    display = " or ".join(candidates)
    raise ValueError(
        f"samtools was not found on PATH. Install {display} or use the future bundled desktop build."
    )


def run_samtools(args: List[str]) -> str:
    return run_command([samtools_executable(), *args])


def available_backend() -> str:
    configured = os.environ.get("GENOME_EXPLORER_BACKEND", "auto").strip().lower()
    if configured not in {"auto", "pysam", "samtools"}:
        raise ValueError("GENOME_EXPLORER_BACKEND must be one of: auto, pysam, samtools")
    if configured == "pysam":
        if pysam is None:
            raise ValueError("GENOME_EXPLORER_BACKEND=pysam was requested, but pysam is not installed")
        return "pysam"
    if configured == "samtools":
        samtools_executable()
        return "samtools"
    if pysam is not None:
        return "pysam"
    samtools_executable()
    return "samtools"


def backend_health() -> Dict:
    health = {
        "platform": sys.platform,
        "backend": None,
        "pysam_available": pysam is not None,
        "samtools_found": False,
        "samtools_path": None,
    }
    try:
        health["backend"] = available_backend()
    except ValueError as exc:
        health["backend"] = f"error: {exc}"
    try:
        health["samtools_path"] = samtools_executable()
        health["samtools_found"] = True
    except ValueError:
        pass
    return health


def configured_alphagenome_api_key(payload_api_key: Optional[str] = None) -> str:
    if payload_api_key and str(payload_api_key).strip():
        return str(payload_api_key).strip()
    return (
        os.environ.get("ALPHAGENOME_API_KEY")
        or os.environ.get("ALPHA_GENOME_API_KEY")
        or ""
    ).strip()


def run_alphagenome_variant_prediction(variant: Dict, api_key: str, ontology_terms: Optional[List[str]] = None) -> Dict:
    try:
        from alphagenome.data import genome
        from alphagenome.models import dna_client
    except ImportError as exc:
        raise ValueError(
            "AlphaGenome Python package is not installed. Install it with `pip install -U alphagenome` before running predictions."
        ) from exc

    model = dna_client.create(api_key)
    variant_obj = genome.Variant(
        chromosome=variant["contig"],
        position=int(variant["position"]),
        reference_bases=variant["ref"],
        alternate_bases=variant["alt"],
    )
    sequence_length = getattr(dna_client, "SEQUENCE_LENGTH_1MB", 1_000_000)
    interval = variant_obj.reference_interval.resize(sequence_length)
    requested_outputs = [dna_client.OutputType.RNA_SEQ]
    requested_output_names = [
        getattr(output, "name", str(output))
        for output in requested_outputs
    ]
    requested_ontology_terms = ontology_terms or ["UBERON:0001157"]

    outputs = model.predict_variant(
        interval=interval,
        variant=variant_obj,
        ontology_terms=requested_ontology_terms,
        requested_outputs=requested_outputs,
    )

    output_type_name = type(outputs).__name__
    return {
        "status": "success",
        "configured": True,
        "provider": "AlphaGenome",
        "message": "AlphaGenome prediction completed. Raw outputs were computed but are not yet visualized in this UI.",
        "request": {
            "contig": variant["contig"],
            "position": int(variant["position"]),
            "ref": variant["ref"],
            "alt": variant["alt"],
            "window": {
                "start": interval.start,
                "end": interval.end,
            },
            "ontologyTerms": requested_ontology_terms,
            "requestedOutputs": requested_output_names,
        },
        "result": {
            "outputContainerType": output_type_name,
            "requestedOutputs": requested_output_names,
            "ontologyTerms": requested_ontology_terms,
        },
    }


def ensure_file_exists(path: Optional[Path], label: str) -> Path:
    if not path:
        raise ValueError(f"{label} is required")
    if not path.exists():
        raise ValueError(f"{label} does not exist: {path}")
    if not path.is_file():
        raise ValueError(f"{label} is not a file: {path}")
    return path


def bam_index_candidates(path: Path) -> List[Path]:
    if path.suffix.lower() == ".cram":
        return [Path(f"{path}.crai"), path.with_suffix(".crai")]
    return [Path(f"{path}.bai"), path.with_suffix(".bai")]


def ensure_alignment_index(path: Path) -> Path:
    for candidate in bam_index_candidates(path):
        if candidate.exists():
            return candidate
    expected = ", ".join(str(candidate) for candidate in bam_index_candidates(path))
    raise ValueError(f"Missing alignment index for {path.name}. Expected one of: {expected}")


def create_fasta_index(path: Path):
    ensure_file_exists(path, "Reference FASTA")
    fai = Path(f"{path}.fai")
    if fai.exists():
        return None
    if available_backend() == "pysam":
        pysam.faidx(str(path))
    else:
        run_samtools(["faidx", str(path)])
    return fai


def create_alignment_index(path: Path):
    ensure_file_exists(path, "Alignment file")
    existing = next((candidate for candidate in bam_index_candidates(path) if candidate.exists()), None)
    if existing:
        return None
    if available_backend() == "pysam":
        pysam.index(str(path))
    else:
        run_samtools(["index", str(path)])
    return next((candidate for candidate in bam_index_candidates(path) if candidate.exists()), None)


def create_missing_indexes(session: "SessionConfig") -> List[str]:
    created: List[str] = []
    if session.reference:
        created_path = create_fasta_index(session.reference)
        if created_path:
            created.append(str(created_path))
    for bam in session.bams or []:
        created_path = create_alignment_index(bam)
        if created_path:
            created.append(str(created_path))
    return created


def parse_sequence_headers_from_sam(header_text: str) -> Dict[str, int]:
    contigs: Dict[str, int] = {}
    for line in header_text.splitlines():
        if not line.startswith("@SQ\t"):
            continue
        fields = line.split("\t")[1:]
        values = {}
        for field in fields:
            if ":" not in field:
                continue
            key, value = field.split(":", 1)
            values[key] = value
        if "SN" in values and "LN" in values:
            contigs[values["SN"]] = int(values["LN"])
    return contigs


def read_alignment_contigs(path: Path) -> Dict[str, int]:
    if available_backend() == "pysam":
        with pysam.AlignmentFile(str(path), "rb") as handle:
            if not handle.references:
                raise ValueError(f"No sequence dictionary found in alignment header: {path}")
            return {
                str(name): int(length)
                for name, length in zip(handle.references, handle.lengths)
            }
    header_text = run_samtools(["view", "-H", str(path)])
    contigs = parse_sequence_headers_from_sam(header_text)
    if not contigs:
        raise ValueError(f"No sequence dictionary found in alignment header: {path}")
    return contigs


def read_variant_contigs(path: Path, max_records: int = 2000) -> Set[str]:
    contigs: Set[str] = set()
    records_seen = 0
    with path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("##contig=<ID="):
                fragment = line.split("ID=", 1)[1]
                contig = fragment.split(",", 1)[0].split(">", 1)[0]
                contigs.add(contig)
                continue
            if line.startswith("#"):
                continue
            fields = line.split("\t")
            if fields:
                contigs.add(fields[0])
                records_seen += 1
            if records_seen >= max_records:
                break
    return contigs


def read_gff_contigs(path: Path, max_records: int = 2000) -> Set[str]:
    contigs: Set[str] = set()
    records_seen = 0
    with path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < 9:
                raise ValueError(f"GFF record does not have 9 fields: {path}")
            if "=" not in fields[8]:
                raise ValueError(f"Only GFF-style attributes are supported right now; unsupported annotation format: {path}")
            contigs.add(fields[0])
            records_seen += 1
            if records_seen >= max_records:
                break
    return contigs


def validate_contig_compatibility(kind: str, observed: Dict[str, int], reference: Dict[str, int]):
    overlap = set(observed) & set(reference)
    if not overlap:
        observed_preview = ", ".join(sorted(list(observed))[:5])
        reference_preview = ", ".join(sorted(list(reference))[:5])
        raise ValueError(
            f"{kind} contigs do not match the reference. {kind} starts with [{observed_preview}] but reference starts with [{reference_preview}]"
        )
    for contig in overlap:
        if observed[contig] != reference[contig]:
            raise ValueError(
                f"{kind} contig length mismatch for {contig}: {observed[contig]} vs reference {reference[contig]}"
            )


def validate_contig_names(kind: str, observed: Set[str], reference: Dict[str, int]):
    if not observed:
        return
    overlap = observed & set(reference)
    if not overlap:
        observed_preview = ", ".join(sorted(list(observed))[:5])
        reference_preview = ", ".join(sorted(list(reference))[:5])
        raise ValueError(
            f"{kind} contigs do not match the reference. {kind} starts with [{observed_preview}] but reference starts with [{reference_preview}]"
        )


def build_validated_snapshot(session: "SessionConfig") -> Dict:
    reference_path = ensure_file_exists(session.reference, "Reference FASTA")
    contig_entries = read_fasta_index(reference_path)
    if not contig_entries:
        raise ValueError(f"Reference FASTA index is empty: {reference_path}.fai")
    reference_contigs = {entry["name"]: entry["length"] for entry in contig_entries}

    bam_paths: List[Path] = []
    for index, configured_bam in enumerate(session.bams or [], start=1):
        label = f"Alignment file {index}"
        bam_path = ensure_file_exists(configured_bam, label)
        ensure_alignment_index(bam_path)
        validate_contig_compatibility(label, read_alignment_contigs(bam_path), reference_contigs)
        bam_paths.append(bam_path)

    vcf_path = None
    if session.vcf:
        vcf_path = ensure_file_exists(session.vcf, "Variant file")
        if vcf_path.suffix.lower() == ".gz":
            raise ValueError("Compressed VCF (.vcf.gz) is not supported yet. Use an uncompressed .vcf for now.")
        validate_contig_names("Variant file", read_variant_contigs(vcf_path), reference_contigs)

    gff_path = None
    if session.gff:
        gff_path = ensure_file_exists(session.gff, "Annotation file")
        if gff_path.suffix.lower() == ".gtf":
            raise ValueError("GTF is not supported yet. Use GFF/GFF3 for now.")
        validate_contig_names("Annotation file", read_gff_contigs(gff_path), reference_contigs)

    return {
        "reference": str(reference_path),
        "bam": str(bam_paths[0]) if bam_paths else None,
        "bams": [str(path) for path in bam_paths],
        "vcf": str(vcf_path) if vcf_path else None,
        "gff": str(gff_path) if gff_path else None,
        "contigs": contig_entries,
    }


def build_lightweight_snapshot(session: "SessionConfig") -> Dict:
    reference_path = ensure_file_exists(session.reference, "Reference FASTA")
    contig_entries = read_fasta_index(reference_path)
    if not contig_entries:
        raise ValueError(f"Reference FASTA index is empty: {reference_path}.fai")

    # Keep session load lightweight for large/remote datasets. Validate only
    # the reference (needed for contigs) and defer BAM/VCF/GFF file checks
    # until the first locus query touches those resources.
    bam_paths = [configured_bam for configured_bam in (session.bams or []) if configured_bam]

    vcf_path = session.vcf
    if vcf_path:
        if vcf_path.suffix.lower() == ".gz":
            raise ValueError("Compressed VCF (.vcf.gz) is not supported yet. Use an uncompressed .vcf for now.")

    gff_path = session.gff
    if gff_path:
        if gff_path.suffix.lower() == ".gtf":
            raise ValueError("GTF is not supported yet. Use GFF/GFF3 for now.")

    return {
        "reference": str(reference_path),
        "bam": str(bam_paths[0]) if bam_paths else None,
        "bams": [str(path) for path in bam_paths],
        "vcf": str(vcf_path) if vcf_path else None,
        "gff": str(gff_path) if gff_path else None,
        "contigs": contig_entries,
    }


def parse_cigar_tokens(cigar: str) -> List[tuple]:
    if not cigar or cigar == "*":
        return []
    tokens = re.findall(r"(\d+)([MIDNSHP=X])", cigar)
    if not tokens or "".join(f"{length}{op}" for length, op in tokens) != cigar:
        raise ValueError(f"Unsupported CIGAR string: {cigar}")
    return [(int(length), op) for length, op in tokens]


def build_read_layout(cigar: str, start: int, sequence: str) -> tuple:
    if cigar == "*":
        end = start + max(len(sequence) - 1, 0)
        layout = [
            {
                "position": start + index,
                "base": base,
                "op": "M",
                "covers": True,
            }
            for index, base in enumerate(sequence)
        ]
        return layout, end

    layout = []
    read_index = 0
    reference_position = start

    for length, op in parse_cigar_tokens(cigar):
        if op in {"M", "=", "X"}:
            for _ in range(length):
                base = sequence[read_index] if read_index < len(sequence) else "N"
                layout.append(
                    {
                        "position": reference_position,
                        "base": base,
                        "op": op,
                        "covers": True,
                    }
                )
                read_index += 1
                reference_position += 1
            continue

        if op == "I":
            inserted_bases = sequence[read_index:read_index + length]
            anchor_position = max(start, reference_position - 1)
            layout.append(
                {
                    "position": anchor_position,
                    "base": inserted_bases,
                    "op": "I",
                    "covers": False,
                }
            )
            read_index += length
            continue

        if op == "S":
            read_index += length
            continue

        if op in {"D", "N"}:
            for _ in range(length):
                layout.append(
                    {
                        "position": reference_position,
                        "base": "-" if op == "D" else "",
                        "op": op,
                        "covers": False,
                    }
                )
                reference_position += 1
            continue

        if op in {"H", "P"}:
            continue

        raise ValueError(f"Unsupported CIGAR operation: {op}")

    return layout, max(start, reference_position) - 1


def parse_optional_sam_tags(tag_fields: List[str]) -> Dict[str, object]:
    tags: Dict[str, object] = {}
    for field in tag_fields:
        parts = field.split(":", 2)
        if len(parts) != 3:
            continue
        key, value_type, value = parts
        if value_type == "i":
            try:
                tags[key] = int(value)
                continue
            except ValueError:
                pass
        tags[key] = value
    return tags


def parse_sam_line(line: str) -> Dict:
    fields = line.rstrip("\n").split("\t")
    if len(fields) < 11:
        raise ValueError("Malformed SAM record")

    qname = fields[0]
    flag = int(fields[1])
    rname = fields[2]
    pos = int(fields[3])
    mapq = int(fields[4])
    cigar = fields[5]
    insert_size = int(fields[8])
    seq = fields[9]
    qual = fields[10]
    tags = parse_optional_sam_tags(fields[11:])
    layout, end = build_read_layout(cigar, pos, seq)
    read_group = tags.get("RG")

    return {
        "name": qname,
        "flag": flag,
        "contig": rname,
        "start": pos,
        "end": end,
        "mapq": mapq,
        "cigar": cigar,
        "insertSize": insert_size,
        "sequence": seq,
        "quality": qual,
        "layout": layout,
        "tags": tags,
        "readGroup": read_group,
        "haplotype": tags.get("HP"),
        "sample": tags.get("SM") or tags.get("LB") or (f"RG:{read_group}" if read_group else None),
        "reverse": bool(flag & 16),
        "secondary": bool(flag & 256),
        "supplementary": bool(flag & 2048),
    }


def parse_aligned_segment(segment, rg_samples: Optional[Dict[str, str]] = None) -> Dict:
    sequence = segment.query_sequence or ""
    quality = (
        "".join(chr(score + 33) for score in segment.query_qualities)
        if segment.query_qualities
        else ""
    )
    start = int(segment.reference_start) + 1
    cigar = segment.cigarstring or "*"
    tags = {key: value for key, value in segment.get_tags()}
    layout, end = build_read_layout(cigar, start, sequence)
    read_group = tags.get("RG")
    return {
        "name": segment.query_name or "(unnamed)",
        "flag": int(segment.flag),
        "contig": segment.reference_name or "",
        "start": start,
        "end": end,
        "mapq": int(segment.mapping_quality),
        "cigar": cigar,
        "insertSize": int(segment.template_length),
        "sequence": sequence,
        "quality": quality,
        "layout": layout,
        "tags": tags,
        "readGroup": read_group,
        "haplotype": tags.get("HP"),
        "sample": tags.get("SM") or (rg_samples or {}).get(read_group) or tags.get("LB") or (f"RG:{read_group}" if read_group else None),
        "reverse": bool(segment.is_reverse),
        "secondary": bool(segment.is_secondary),
        "supplementary": bool(segment.is_supplementary),
    }


def read_alignment_records(path: Path, contig: str, start: int, end: int) -> List[Dict]:
    if available_backend() == "pysam":
        with pysam.AlignmentFile(str(path), "rb") as handle:
            rg_samples = {}
            for record in handle.header.to_dict().get("RG", []):
                if isinstance(record, dict) and record.get("ID") and record.get("SM"):
                    rg_samples[str(record["ID"])] = str(record["SM"])
            return [
                parse_aligned_segment(segment, rg_samples)
                for segment in handle.fetch(contig, max(start - 1, 0), end)
            ]
    region = f"{contig}:{start}-{end}"
    output = run_samtools(["view", str(path), region])
    return [parse_sam_line(line) for line in output.splitlines() if line.strip()]


def empty_base_counts() -> Dict[str, int]:
    return {
        "A": 0,
        "C": 0,
        "G": 0,
        "T": 0,
        "N": 0,
    }


def compute_coverage(reads: List[Dict], start: int, end: int) -> List[Dict]:
    width = max(end - start + 1, 0)
    counts = [0] * width
    base_counts = [empty_base_counts() for _ in range(width)]
    for read in reads:
        for base in read.get("layout", []):
            if not base["covers"]:
                continue
            position = base["position"]
            if position < start or position > end:
                continue
            index = position - start
            counts[index] += 1
            normalized_base = (base.get("base") or "N").upper()
            if normalized_base not in base_counts[index]:
                normalized_base = "N"
            base_counts[index][normalized_base] += 1
    return [
        {
            "position": start + idx,
            "depth": depth,
            "counts": base_counts[idx],
        }
        for idx, depth in enumerate(counts)
    ]


def read_depth_coverage(path: Path, contig: str, start: int, end: int) -> List[Dict]:
    if available_backend() == "pysam":
        with pysam.AlignmentFile(str(path), "rb") as handle:
            counts = handle.count_coverage(contig, max(start - 1, 0), end)
        depths = [sum(base_counts) for base_counts in zip(*counts)] if counts else []
        return [
            {
                "position": position,
                "depth": (depths[position - start] if position - start < len(depths) else 0),
                "counts": {
                    "A": counts[0][position - start] if counts and position - start < len(counts[0]) else 0,
                    "C": counts[1][position - start] if counts and position - start < len(counts[1]) else 0,
                    "G": counts[2][position - start] if counts and position - start < len(counts[2]) else 0,
                    "T": counts[3][position - start] if counts and position - start < len(counts[3]) else 0,
                    "N": 0,
                },
            }
            for position in range(start, end + 1)
        ]
    region = f"{contig}:{start}-{end}"
    output = run_samtools(["depth", "-a", "-r", region, str(path)])
    depths_by_position: Dict[int, int] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        try:
            position = int(fields[1])
            depth = int(fields[2])
        except ValueError:
            continue
        depths_by_position[position] = depth
    return [
        {
            "position": position,
            "depth": depths_by_position.get(position, 0),
            "counts": empty_base_counts(),
        }
        for position in range(start, end + 1)
    ]


def parse_sam_span(line: str) -> Dict:
    fields = line.rstrip("\n").split("\t")
    if len(fields) < 10:
        raise ValueError("Malformed SAM record")
    pos = int(fields[3])
    cigar = fields[5]
    seq = fields[9]
    reference_span = 0
    if cigar == "*":
        reference_span = len(seq)
    else:
        for length, op in parse_cigar_tokens(cigar):
            if op in {"M", "D", "N", "=", "X"}:
                reference_span += length
    end = pos + max(reference_span - 1, 0)
    return {
        "start": pos,
        "end": end,
    }


def summarize_coverage_points(coverage: List[Dict], start: int, end: int, bins: int) -> List[Dict]:
    width = max(end - start + 1, 1)
    bin_count = max(1, min(bins, width))
    totals = [0] * bin_count
    counts = [0] * bin_count

    for point in coverage:
        position = point["position"]
        bin_index = ((position - start) * bin_count) // width
        bin_index = max(0, min(bin_index, bin_count - 1))
        totals[bin_index] += point["depth"]
        counts[bin_index] += 1

    summary = []
    for index in range(bin_count):
        bin_start = start + (index * width) // bin_count
        if index == bin_count - 1:
            bin_end = end
        else:
            bin_end = start + ((index + 1) * width) // bin_count - 1
        point_count = max(counts[index], 1)
        summary.append(
            {
                "start": bin_start,
                "end": max(bin_start, bin_end),
                "depth": round(totals[index] / point_count),
            }
        )
    return summary


def summarize_coverage_from_sam(output: str, start: int, end: int, bins: int) -> List[Dict]:
    width = max(end - start + 1, 1)
    bin_count = max(1, min(bins, width))
    totals = [0.0] * bin_count
    bin_ranges = []

    for index in range(bin_count):
        bin_start = start + (index * width) // bin_count
        if index == bin_count - 1:
            bin_end = end
        else:
            bin_end = start + ((index + 1) * width) // bin_count - 1
        bin_ranges.append((bin_start, max(bin_start, bin_end)))

    for line in output.splitlines():
        if not line.strip():
            continue
        span = parse_sam_span(line)
        overlap_start = max(start, span["start"])
        overlap_end = min(end, span["end"])
        if overlap_end < overlap_start:
            continue
        first_bin = ((overlap_start - start) * bin_count) // width
        last_bin = ((overlap_end - start) * bin_count) // width
        first_bin = max(0, min(first_bin, bin_count - 1))
        last_bin = max(0, min(last_bin, bin_count - 1))
        for bin_index in range(first_bin, last_bin + 1):
            bin_start, bin_end = bin_ranges[bin_index]
            overlap = min(overlap_end, bin_end) - max(overlap_start, bin_start) + 1
            if overlap > 0:
                totals[bin_index] += overlap

    summary = []
    for index, (bin_start, bin_end) in enumerate(bin_ranges):
        bin_width = max(bin_end - bin_start + 1, 1)
        summary.append(
            {
                "start": bin_start,
                "end": bin_end,
                "depth": round(totals[index] / bin_width),
            }
        )
    return summary


def sample_reads_for_display(reads: List[Dict], limit: int) -> List[Dict]:
    if len(reads) <= limit:
        return reads
    if limit <= 0:
        return []

    sampled: List[Dict] = []
    max_index = len(reads) - 1
    for slot in range(limit):
        source_index = round((slot * max_index) / max(limit - 1, 1))
        sampled.append(reads[source_index])
    return sampled


@dataclass
class VariantStore:
    variants_by_contig: Dict[str, List[Dict]]
    effect_schemas: Dict[str, List[str]]

    @classmethod
    def load(cls, path: Path):
        if not path or not path.exists():
            return cls(variants_by_contig={}, effect_schemas={})

        variants_by_contig: Dict[str, List[Dict]] = {}
        effect_schemas: Dict[str, List[str]] = {}
        with path.open() as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                if line.startswith("##"):
                    for field_id in ("ANN", "CSQ"):
                        schema = parse_effect_schema_from_header(line, field_id)
                        if schema:
                            effect_schemas[field_id] = schema
                    continue
                if line.startswith("#"):
                    continue
                fields = line.split("\t")
                if len(fields) < 8:
                    continue
                contig, pos, var_id, ref, alt, qual, flt, info = fields[:8]
                fmt = fields[8] if len(fields) > 8 else ""
                sample = fields[9] if len(fields) > 9 else ""
                info_map = parse_info_string(info)
                effect_key = "ANN" if "ANN" in info_map else "CSQ" if "CSQ" in info_map else None
                effects = parse_effect_entries(
                    info_map.get(effect_key, ""),
                    effect_schemas.get(effect_key, default_effect_schema(effect_key)) if effect_key else [],
                    effect_key or "",
                ) if effect_key else []
                record = {
                    "contig": contig,
                    "position": int(pos),
                    "id": var_id if var_id != "." else f"{contig}:{pos}{ref}>{alt}",
                    "ref": ref,
                    "alt": alt,
                    "qual": None if qual == "." else float(qual),
                    "filter": flt,
                    "info": info,
                    "infoMap": info_map,
                    "format": fmt,
                    "sample": sample,
                    "effects": effects,
                    "effectSource": effect_key,
                }
                variants_by_contig.setdefault(contig, []).append(record)
        for records in variants_by_contig.values():
            records.sort(key=lambda item: item["position"])
        return cls(variants_by_contig=variants_by_contig, effect_schemas=effect_schemas)

    def query(self, contig: str, start: int, end: int) -> List[Dict]:
        records = self.variants_by_contig.get(contig, [])
        return [record for record in records if start <= record["position"] <= end]

    def nearby(self, contig: str, start: int, end: int) -> List[Dict]:
        records = self.variants_by_contig.get(contig, [])
        if not records:
            return []
        before = None
        after = None
        for record in records:
            if record["position"] < start:
                before = record
                continue
            if record["position"] > end:
                after = record
                break
        nearby = []
        if before:
            nearby.append(before)
        if after:
            nearby.append(after)
        return nearby


@dataclass
class AnnotationStore:
    features_by_contig: Dict[str, List[Dict]]

    @classmethod
    def load_gff(cls, path: Optional[Path]):
        if not path or not path.exists():
            return cls(features_by_contig={})

        features_by_contig: Dict[str, List[Dict]] = {}
        with path.open() as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                fields = line.split("\t")
                if len(fields) < 9:
                    continue
                contig, source, feature_type, start, end, score, strand, phase, attributes = fields[:9]
                attr_map = {}
                for fragment in attributes.split(";"):
                    if not fragment:
                        continue
                    if "=" in fragment:
                        key, value = fragment.split("=", 1)
                        attr_map[key] = value
                features_by_contig.setdefault(contig, []).append(
                    {
                        "contig": contig,
                        "source": source,
                        "type": feature_type,
                        "start": int(start),
                        "end": int(end),
                        "score": score,
                        "strand": strand,
                        "phase": phase,
                        "attributes": attr_map,
                        "label": attr_map.get("Name") or attr_map.get("gene_name") or attr_map.get("ID") or feature_type,
                    }
                )
        for records in features_by_contig.values():
            records.sort(key=lambda item: (item["start"], item["end"]))
        return cls(features_by_contig=features_by_contig)

    def query(self, contig: str, start: int, end: int) -> List[Dict]:
        records = self.features_by_contig.get(contig, [])
        return [record for record in records if record["end"] >= start and record["start"] <= end]


@dataclass
class SessionConfig:
    reference: Optional[Path] = None
    bams: List[Path] = None
    vcf: Optional[Path] = None
    gff: Optional[Path] = None

    @classmethod
    def from_manifest(cls):
        manifest = read_manifest()
        configured_bams = manifest.get("bams")
        if configured_bams is None:
            configured_bams = [manifest.get("bam")] if manifest.get("bam") else []
        return cls(
            reference=resolve_configured_path(manifest.get("reference")),
            bams=[resolve_configured_path(path) for path in configured_bams if path],
            vcf=resolve_configured_path(manifest.get("vcf")),
            gff=resolve_configured_path(manifest.get("gff")),
        )

    def with_updates(self, payload: Dict) -> "SessionConfig":
        next_session = SessionConfig(
            reference=self.reference,
            bams=list(self.bams or []),
            vcf=self.vcf,
            gff=self.gff,
        )
        for key in ("reference", "vcf", "gff"):
            if key in payload:
                setattr(next_session, key, Path(payload[key]).expanduser() if payload[key] else None)
        if "bam" in payload or "bams" in payload:
            next_session.bams = parse_alignment_payload(payload)
        return next_session

    @property
    def bam(self) -> Optional[Path]:
        return self.bams[0] if self.bams else None

    def snapshot(self) -> Dict:
        if not self.reference:
            return {
                "reference": None,
                "bam": str(self.bam) if self.bam else None,
                "bams": [str(path) for path in (self.bams or [])],
                "vcf": str(self.vcf) if self.vcf else None,
                "gff": str(self.gff) if self.gff else None,
                "contigs": [],
            }
        return build_validated_snapshot(self)


DEFAULT_SESSION = SessionConfig.from_manifest()
SESSION = SessionConfig.from_manifest()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "LocusZoom/0.1"

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api(parsed)
            return
        self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404, "Unknown endpoint")
            return
        self.handle_api(parsed, method="POST")

    def handle_api(self, parsed, method: str = "GET"):
        try:
            if parsed.path == "/api/manifest" and method == "GET":
                self.write_json(DEFAULT_SESSION.snapshot())
                return

            if parsed.path == "/api/session" and method == "GET":
                self.write_json(SESSION.snapshot())
                return

            if parsed.path == "/api/health" and method == "GET":
                self.write_json(backend_health())
                return

            if parsed.path == "/api/session/load" and method == "POST":
                self.handle_session_load()
                return

            if parsed.path == "/api/session/indexes" and method == "POST":
                self.handle_session_indexes()
                return

            if parsed.path == "/api/reference" and method == "GET":
                self.handle_reference(parsed)
                return

            if parsed.path == "/api/alignments" and method == "GET":
                self.handle_alignments(parsed)
                return

            if parsed.path == "/api/variants" and method == "GET":
                self.handle_variants(parsed)
                return

            if parsed.path == "/api/annotations" and method == "GET":
                self.handle_annotations(parsed)
                return

            if parsed.path == "/api/alphagenome/analyze" and method == "POST":
                self.handle_alphagenome_analyze()
                return

            self.send_error(404, "Unknown API endpoint")
        except (BrokenPipeError, ConnectionResetError):
            return
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.strip() if exc.stderr else "Command failed"
            try:
                self.write_json({"error": stderr}, status=500)
            except (BrokenPipeError, ConnectionResetError):
                return
        except Exception as exc:
            try:
                self.write_json({"error": str(exc)}, status=400)
            except (BrokenPipeError, ConnectionResetError):
                return

    def read_json_body(self) -> Dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def handle_session_load(self):
        global SESSION
        payload = self.read_json_body()
        proposed = SESSION.with_updates(payload)
        snapshot = build_lightweight_snapshot(proposed)
        if not snapshot["contigs"]:
            raise ValueError("Reference FASTA with .fai index is required")
        SESSION = proposed
        self.write_json(snapshot)

    def handle_session_indexes(self):
        payload = self.read_json_body()
        proposed = SESSION.with_updates(payload)
        created = create_missing_indexes(proposed)
        self.write_json(
            {
                "created": created,
                "count": len(created),
            }
        )

    def handle_reference(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        contig = query.get("contig", [""])[0]
        start = int(query.get("start", ["1"])[0])
        end = int(query.get("end", ["1"])[0])
        fasta = SESSION.reference
        if not fasta:
            raise ValueError("No reference configured")
        if available_backend() == "pysam":
            with pysam.FastaFile(str(fasta)) as handle:
                sequence = handle.fetch(contig, max(start - 1, 0), end)
        else:
            region = f"{contig}:{start}-{end}"
            output = run_samtools(["faidx", str(fasta), region])
            lines = [line.strip() for line in output.splitlines() if line and not line.startswith(">")]
            sequence = "".join(lines)
        self.write_json(
            {
                "contig": contig,
                "start": start,
                "end": end,
                "sequence": sequence,
            }
        )

    def handle_alignments(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        contig = query.get("contig", [""])[0]
        start = int(query.get("start", ["1"])[0])
        end = int(query.get("end", ["1"])[0])
        limit = int(query.get("limit", ["2500"])[0])
        include_reads = query.get("includeReads", ["1"])[0] != "0"
        bins = max(0, int(query.get("bins", ["0"])[0]))
        bams = SESSION.bams or []
        if not bams:
            self.write_json(
                {
                    "contig": contig,
                    "start": start,
                    "end": end,
                    "tracks": [],
                    "truncated": False,
                    "totalReadCount": 0,
                    "readsLoaded": False,
                    "coverageBinned": False,
                }
            )
            return
        region = f"{contig}:{start}-{end}"
        tracks = []
        total_read_count = 0
        any_truncated = False

        for bam in bams:
            if include_reads:
                all_reads = read_alignment_records(bam, contig, start, end)
                reads = sample_reads_for_display(all_reads, limit)
                coverage = compute_coverage(all_reads, start, end)
                total_read_count += len(all_reads)
                any_truncated = any_truncated or len(all_reads) > limit
                truncated = len(all_reads) > limit
            else:
                reads = []
                if bins > 0:
                    coverage = summarize_coverage_points(
                        read_depth_coverage(bam, contig, start, end),
                        start,
                        end,
                        bins,
                    )
                else:
                    coverage = read_depth_coverage(bam, contig, start, end)
                truncated = False
            tracks.append(
                {
                    "id": bam.name,
                    "path": str(bam),
                    "coverage": coverage,
                    "reads": reads,
                    "truncated": truncated,
                    "totalReadCount": len(reads) if include_reads else 0,
                }
            )

        self.write_json(
            {
                "contig": contig,
                "start": start,
                "end": end,
                "tracks": tracks,
                "truncated": any_truncated,
                "totalReadCount": total_read_count,
                "readsLoaded": include_reads,
                "coverageBinned": (not include_reads) and bins > 0,
            }
        )

    def handle_variants(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        contig = query.get("contig", [""])[0]
        start = int(query.get("start", ["1"])[0])
        end = int(query.get("end", ["1"])[0])
        variants = VariantStore.load(SESSION.vcf)
        self.write_json(
            {
                "contig": contig,
                "start": start,
                "end": end,
                "variants": variants.query(contig, start, end),
                "nearbyVariants": variants.nearby(contig, start, end),
            }
        )

    def handle_annotations(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        contig = query.get("contig", [""])[0]
        start = int(query.get("start", ["1"])[0])
        end = int(query.get("end", ["1"])[0])
        annotations = AnnotationStore.load_gff(SESSION.gff)
        self.write_json(
            {
                "contig": contig,
                "start": start,
                "end": end,
                "annotations": annotations.query(contig, start, end),
            }
        )

    def handle_alphagenome_analyze(self):
        payload = self.read_json_body()
        variant = payload.get("variant") or {}
        if not variant:
            raise ValueError("Variant payload is required")

        contig = variant.get("contig")
        position = variant.get("position")
        ref = variant.get("ref")
        alt = variant.get("alt")
        if not contig or position is None or not ref or not alt:
            raise ValueError("Variant payload must include contig, position, ref, and alt")

        api_key = configured_alphagenome_api_key(payload.get("apiKey"))
        if not api_key:
            flank = 500
            self.write_json(
                {
                    "status": "not_configured",
                    "configured": False,
                    "provider": "AlphaGenome",
                    "message": (
                        "AlphaGenome API key is not configured. Set ALPHAGENOME_API_KEY (or ALPHA_GENOME_API_KEY) "
                        "or provide a key from the app prompt."
                    ),
                    "request": {
                        "contig": contig,
                        "position": int(position),
                        "ref": ref,
                        "alt": alt,
                        "window": {
                            "start": max(1, int(position) - flank),
                            "end": int(position) + flank,
                        },
                    },
                    "result": None,
                }
            )
            return

        ontology_terms = payload.get("ontologyTerms")
        if ontology_terms and not isinstance(ontology_terms, list):
            raise ValueError("ontologyTerms must be an array when provided")
        result = run_alphagenome_variant_prediction(
            {
                "contig": contig,
                "position": int(position),
                "ref": ref,
                "alt": alt,
            },
            api_key,
            ontology_terms=ontology_terms,
        )
        flank = 500
        self.write_json(
            {
                **result,
                "request": {
                    **result["request"],
                    "window": result["request"].get(
                        "window",
                        {
                            "start": max(1, int(position) - flank),
                            "end": int(position) + flank,
                        },
                    ),
                },
            }
        )

    def serve_static(self, route_path: str):
        route = route_path or "/"
        if route == "/":
            route = "/index.html"

        target = (APP_DIR / route.lstrip("/")).resolve()
        if not str(target).startswith(str(APP_DIR)):
            self.send_error(403, "Forbidden")
            return
        if not target.exists() or not target.is_file():
            self.send_error(404, "Not found")
            return

        content_type = self.content_type_for(target.suffix)
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            if target.suffix in {".html", ".css", ".js"}:
                self.send_header("Cache-Control", "no-store, max-age=0")
            self.end_headers()
            self.wfile.write(target.read_bytes())
        except (BrokenPipeError, ConnectionResetError):
            return

    def content_type_for(self, suffix: str) -> str:
        return {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
        }.get(suffix, "application/octet-stream")

    def write_json(self, payload: Dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


class LocusZoomHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    available_backend()
    with LocusZoomHTTPServer((HOST, PORT), RequestHandler) as httpd:
        print(f"Locus Zoom running at http://{HOST}:{PORT} using {available_backend()} backend")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
