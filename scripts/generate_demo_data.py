#!/usr/bin/env python3

import json
import random
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
REFERENCE = DATA / "demo.fa"
VCF = DATA / "demo.vcf"
GFF = DATA / "demo.gff3"
MANIFEST = DATA / "manifest.json"
CONTIG_NAME = "chrDemo"
CONTIG_LENGTH = 50_000
READ_MIN_LENGTH = 1_000
READ_MAX_LENGTH = 2_000
TARGET_DEPTH = 50
ALIGNMENT_TARGETS = [
    {
        "name": "demo",
        "seed": 17,
        "depth": TARGET_DEPTH,
        "sam": DATA / "demo.sam",
        "bam": DATA / "demo.bam",
    },
    {
        "name": "demo_compare",
        "seed": 29,
        "depth": 42,
        "sam": DATA / "demo_compare.sam",
        "bam": DATA / "demo_compare.bam",
    },
    {
        "name": "demo_third",
        "seed": 41,
        "depth": 36,
        "sam": DATA / "demo_third.sam",
        "bam": DATA / "demo_third.bam",
    },
]


def run(args):
    subprocess.run(args, check=True)


def write_reference():
    motif = "ACGTTGCAAGTC"
    repeats = (CONTIG_LENGTH // len(motif)) + 2
    sequence = (motif * repeats)[:CONTIG_LENGTH]
    content = f">{CONTIG_NAME}\n{sequence}\n"
    REFERENCE.write_text(content)
    run(["samtools", "faidx", str(REFERENCE)])
    return sequence


def mutate(base):
    cycle = {"A": "G", "C": "T", "G": "A", "T": "C"}
    return cycle.get(base, "N")


def random_bases(rng, length):
    return "".join(rng.choice("ACGT") for _ in range(length))


def collapse_ops(ops):
    collapsed = []
    for length, op in ops:
        if length <= 0:
            continue
        if collapsed and collapsed[-1][1] == op:
            collapsed[-1] = (collapsed[-1][0] + length, op)
        else:
            collapsed.append((length, op))
    return collapsed


def build_long_read_sequence(reference, start, ref_span, rng, variant_positions, salt):
    end = start + ref_span - 1
    bases = list(reference[start - 1:end])

    for var_position in variant_positions:
        if start <= var_position <= end and (salt + var_position) % 3 == 0:
            local = var_position - start
            bases[local] = mutate(bases[local])

    deletion = None
    if ref_span > 200 and rng.random() < 0.45:
        delete_len = rng.randint(1, min(12, max(2, ref_span // 18)))
        delete_start = rng.randint(80, ref_span - delete_len - 80)
        deletion = (delete_start, delete_len)

    insertion = None
    if rng.random() < 0.45:
        insert_len = rng.randint(1, 16)
        insert_offset = rng.randint(40, ref_span - 40)
        if deletion and deletion[0] <= insert_offset < deletion[0] + deletion[1]:
            insert_offset = deletion[0]
        insertion = (insert_offset, random_bases(rng, insert_len))

    query = []
    ops = []
    index = 0

    while index < ref_span:
        if insertion and insertion[0] == index:
            inserted = insertion[1]
            query.append(inserted)
            ops.append((len(inserted), "I"))
            insertion = None

        if deletion and deletion[0] == index:
            ops.append((deletion[1], "D"))
            index += deletion[1]
            deletion = None
            continue

        query.append(bases[index])
        ops.append((1, "M"))
        index += 1

    if insertion:
        inserted = insertion[1]
        query.append(inserted)
        ops.append((len(inserted), "I"))

    return "".join(query), "".join(f"{length}{op}" for length, op in collapse_ops(ops))


def build_read(name, start, sequence, cigar, flag=0, mapq=60):
    return "\t".join(
        [
            name,
            str(flag),
            CONTIG_NAME,
            str(start),
            str(mapq),
            cigar,
            "*",
            "0",
            "0",
            sequence,
            "I" * len(sequence),
        ]
    )


def build_read_starts(rng, ref_span, target_depth):
    variant_positions = {82, 141, 213, 15_004, 32_010, 47_220}
    max_start = CONTIG_LENGTH - ref_span + 1
    read_count = int((CONTIG_LENGTH * target_depth) / ref_span)
    starts = []

    for _ in range(read_count):
        center = rng.randint(1, CONTIG_LENGTH)
        offset = rng.randint(0, ref_span - 1)
        start = center - offset
        if start < 1:
            start = 2 - start
        if start > max_start:
            start = max_start - (start - max_start)
        start = max(1, min(start, max_start))
        starts.append(start)

    starts.sort()
    return starts, variant_positions


def write_alignment_files(reference, target):
    rng = random.Random(target["seed"])
    mean_ref_span = (READ_MIN_LENGTH + READ_MAX_LENGTH) // 2
    starts, variant_positions = build_read_starts(rng, mean_ref_span, target["depth"])
    lines = [
        "@HD\tVN:1.6\tSO:coordinate",
        f"@SQ\tSN:{CONTIG_NAME}\tLN:{CONTIG_LENGTH}",
    ]
    records = []

    for index, start in enumerate(starts):
        ref_span = rng.randint(READ_MIN_LENGTH, READ_MAX_LENGTH)
        max_start = CONTIG_LENGTH - ref_span + 1
        adjusted_start = max(1, min(start, max_start))
        read_seq, cigar = build_long_read_sequence(
            reference,
            adjusted_start,
            ref_span,
            rng,
            variant_positions,
            index + target["seed"],
        )
        flag = 16 if index % 3 == 0 else 0
        mapq = 60 if index % 11 else 35
        records.append((adjusted_start, f"{target['name']}_read_{index + 1:04d}", read_seq, cigar, flag, mapq))

    edge_boost = 16
    for edge_index in range(edge_boost):
        left_span = rng.randint(READ_MIN_LENGTH, READ_MAX_LENGTH)
        left_start = 1
        left_seq, left_cigar = build_long_read_sequence(
            reference,
            left_start,
            left_span,
            rng,
            variant_positions,
            edge_index + 1000 + target["seed"],
        )
        left_flag = 16 if (len(records) + edge_index) % 3 == 0 else 0
        records.append((left_start, f"{target['name']}_edge_left_{edge_index + 1:03d}", left_seq, left_cigar, left_flag, 45))

        right_span = rng.randint(READ_MIN_LENGTH, READ_MAX_LENGTH)
        right_start = CONTIG_LENGTH - right_span + 1
        right_seq, right_cigar = build_long_read_sequence(
            reference,
            right_start,
            right_span,
            rng,
            variant_positions,
            edge_index + 2000 + target["seed"],
        )
        right_flag = 16 if (len(records) + edge_boost + edge_index) % 3 == 0 else 0
        records.append((right_start, f"{target['name']}_edge_right_{edge_index + 1:03d}", right_seq, right_cigar, right_flag, 45))

    records.sort(key=lambda item: (item[0], item[1]))
    for start, name, sequence, cigar, flag, mapq in records:
        lines.append(build_read(name, start, sequence, cigar, flag=flag, mapq=mapq))

    target["sam"].write_text("\n".join(lines) + "\n")
    run(["samtools", "view", "-bS", "-o", str(target["bam"]), str(target["sam"])])
    run(["samtools", "index", str(target["bam"])])


def write_vcf(reference):
    positions = [82, 141, 213, 15_004, 32_010, 47_220]
    lines = [
        "##fileformat=VCFv4.2",
        f"##contig=<ID={CONTIG_NAME},length={CONTIG_LENGTH}>",
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
    ]

    for idx, position in enumerate(positions, start=1):
        ref = reference[position - 1]
        alt = mutate(ref)
        lines.append(
            "\t".join(
                [
                    CONTIG_NAME,
                    str(position),
                    f"demo_var_{idx}",
                    ref,
                    alt,
                    str(80 + idx * 7),
                    "PASS",
                    f"DP={14 + idx * 3}",
                    "GT:AD",
                    "0/1:8,6",
                ]
            )
        )
    VCF.write_text("\n".join(lines) + "\n")


def write_manifest():
    payload = {
        "reference": "demo.fa",
        "bam": "demo.bam",
        "bams": ["demo.bam", "demo_compare.bam", "demo_third.bam"],
        "vcf": "demo.vcf",
        "gff": "demo.gff3",
        "contigs": [
            {
                "name": "chrDemo",
                "length": CONTIG_LENGTH,
            }
        ],
    }
    MANIFEST.write_text(json.dumps(payload, indent=2) + "\n")


def write_gff():
    lines = [
        "##gff-version 3",
        f"{CONTIG_NAME}\tdemo\tgene\t40\t170\t.\t+\t.\tID=geneA;Name=DemoGeneA",
        f"{CONTIG_NAME}\tdemo\texon\t40\t90\t.\t+\t.\tID=geneA_exon1;Parent=geneA;Name=DemoGeneA exon 1",
        f"{CONTIG_NAME}\tdemo\texon\t120\t170\t.\t+\t.\tID=geneA_exon2;Parent=geneA;Name=DemoGeneA exon 2",
        f"{CONTIG_NAME}\tdemo\tgene\t200\t310\t.\t-\t.\tID=geneB;Name=DemoGeneB",
        f"{CONTIG_NAME}\tdemo\texon\t200\t235\t.\t-\t.\tID=geneB_exon1;Parent=geneB;Name=DemoGeneB exon 1",
        f"{CONTIG_NAME}\tdemo\texon\t260\t310\t.\t-\t.\tID=geneB_exon2;Parent=geneB;Name=DemoGeneB exon 2",
        f"{CONTIG_NAME}\tdemo\tgene\t380\t540\t.\t+\t.\tID=geneC;Name=DemoGeneC",
        f"{CONTIG_NAME}\tdemo\texon\t380\t430\t.\t+\t.\tID=geneC_exon1;Parent=geneC;Name=DemoGeneC exon 1",
        f"{CONTIG_NAME}\tdemo\texon\t470\t540\t.\t+\t.\tID=geneC_exon2;Parent=geneC;Name=DemoGeneC exon 2",
        f"{CONTIG_NAME}\tdemo\tgene\t14920\t15120\t.\t+\t.\tID=geneD;Name=DemoGeneD",
        f"{CONTIG_NAME}\tdemo\texon\t14920\t15010\t.\t+\t.\tID=geneD_exon1;Parent=geneD;Name=DemoGeneD exon 1",
        f"{CONTIG_NAME}\tdemo\texon\t15060\t15120\t.\t+\t.\tID=geneD_exon2;Parent=geneD;Name=DemoGeneD exon 2",
        f"{CONTIG_NAME}\tdemo\tgene\t31940\t32170\t.\t-\t.\tID=geneE;Name=DemoGeneE",
        f"{CONTIG_NAME}\tdemo\texon\t31940\t32020\t.\t-\t.\tID=geneE_exon1;Parent=geneE;Name=DemoGeneE exon 1",
        f"{CONTIG_NAME}\tdemo\texon\t32080\t32170\t.\t-\t.\tID=geneE_exon2;Parent=geneE;Name=DemoGeneE exon 2",
        f"{CONTIG_NAME}\tdemo\tgene\t46900\t47280\t.\t+\t.\tID=geneF;Name=DemoGeneF",
        f"{CONTIG_NAME}\tdemo\texon\t46900\t47040\t.\t+\t.\tID=geneF_exon1;Parent=geneF;Name=DemoGeneF exon 1",
        f"{CONTIG_NAME}\tdemo\texon\t47130\t47280\t.\t+\t.\tID=geneF_exon2;Parent=geneF;Name=DemoGeneF exon 2",
    ]
    GFF.write_text("\n".join(lines) + "\n")


def main():
    DATA.mkdir(exist_ok=True)
    reference = write_reference()
    for target in ALIGNMENT_TARGETS:
        write_alignment_files(reference, target)
    write_vcf(reference)
    write_gff()
    write_manifest()
    print("Generated demo FASTA, BAM, BAI, VCF, and GFF in", DATA)


if __name__ == "__main__":
    main()
