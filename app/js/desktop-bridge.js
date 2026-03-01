export function inferFileSlots(paths) {
  const slots = {
    reference: "",
    bams: [],
    vcf: "",
    gff: "",
  };

  paths.forEach((path) => {
    const lower = path.toLowerCase();
    if (!slots.reference && (lower.endsWith(".fa") || lower.endsWith(".fasta") || lower.endsWith(".fna"))) {
      slots.reference = path;
      return;
    }
    if (lower.endsWith(".bam") || lower.endsWith(".cram")) {
      slots.bams.push(path);
      return;
    }
    if (!slots.vcf && lower.endsWith(".vcf")) {
      slots.vcf = path;
      return;
    }
    if (!slots.gff && (lower.endsWith(".gff") || lower.endsWith(".gff3"))) {
      slots.gff = path;
    }
  });

  return slots;
}

export function extractDroppedPaths(fileList) {
  return Array.from(fileList)
    .map((file) => file.path || "")
    .filter(Boolean);
}

export function canResolveNativePaths(fileList) {
  return Array.from(fileList).some((file) => Boolean(file.path));
}
