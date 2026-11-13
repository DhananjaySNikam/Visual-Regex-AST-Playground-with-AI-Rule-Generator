export interface Example {
  id: string
  title: string
  prompt: string
  pattern: string
  flags: string
  corpus: string
  note: string
}

export const EXAMPLES: Example[] = [
  {
    id: 'gstin',
    title: 'Indian GST numbers',
    prompt: 'match valid Indian GST numbers',
    pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$',
    flags: 'gm',
    corpus: [
      '27AAPFU0939F1ZV',
      '07AAACR5055K1Z5',
      '33AAACG1234H1ZP',
      '27aapfu0939f1zv',
      '99AAPFU0939F1ZV',
      '27AAPFU0939F1Z',
    ].join('\n'),
    note: 'Anchored per line: 2-digit state code, PAN, entity number, "Z", checksum.',
  },
  {
    id: 'email',
    title: 'Email addresses',
    prompt: 'extract all email addresses',
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    flags: 'g',
    corpus:
      'Contact asha@example.com or dev+alerts@mail.co.in.\nBroken: asha@example, @nowhere.org, two words@x.com\nEscalation: oncall@infra.example.io',
    note: 'Pure character classes — linear time on the safe engine.',
  },
  {
    id: 'redos',
    title: 'ReDoS: nested quantifier',
    prompt: 'explain why (a+)+$ hangs a backtracking engine',
    pattern: '(a+)+$',
    flags: 'g',
    corpus: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
    note: 'Safe engine: O(n·m). Backtracking engine: 2ⁿ partitions of the same run.',
  },
  {
    id: 'logs',
    title: 'Structured log lines',
    prompt: 'parse timestamp, level and message from log lines',
    pattern: '^(?<ts>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2})Z? (?<level>INFO|WARN|ERROR) (?<msg>.+)$',
    flags: 'gm',
    corpus: [
      '2024-05-11T09:14:02Z INFO worker started',
      '2024-05-11T09:14:03Z WARN retry budget at 80%',
      '2024-05-11T09:14:07Z ERROR upstream timeout id=abc123',
      'not a log line',
    ].join('\n'),
    note: 'Named groups drive the capture table and the node inspector.',
  },
  {
    id: 'pan',
    title: 'PAN cards',
    prompt: 'validate PAN numbers',
    pattern: '\\b[A-Z]{5}[0-9]{4}[A-Z]\\b',
    flags: 'g',
    corpus: 'AAPFU0939F CABPM1234K AAFU0939FY aapfu0939f',
    note: 'Word boundaries instead of anchors, so it finds PANs inside prose.',
  },
  {
    id: 'ipv4',
    title: 'IPv4 addresses',
    prompt: 'find IPv4 addresses',
    pattern: '\\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\b',
    flags: 'g',
    corpus: 'edge 192.168.0.1, gateway 10.0.0.255, bad 256.1.1.1 and 1.2.3 and 1.2.3.345',
    note: 'Octets enumerated in range order — no `\\d{1,3}` guessing, no backtracking blow-up.',
  },
  {
    id: 'inr',
    title: 'INR amounts',
    prompt: 'match Indian currency amounts in lakh format',
    pattern: '(?:₹|Rs\\.?|INR)\\s?[1-9][0-9]{0,2}(?:,[0-9]{2})*(?:,[0-9]{3})?(?:\\.[0-9]{1,2})?',
    flags: 'gi',
    corpus: 'invoice ₹1,23,456.78 paid; retainer Rs. 5,000; token INR 250; bad ₹0123',
    note: 'Encodes the 2-2-3 Indian digit grouping rather than accepting any commas.',
  },
  {
    id: 'uuid',
    title: 'UUID v4',
    prompt: 'extract UUID v4 identifiers',
    pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b',
    flags: 'gi',
    corpus:
      'req f47ac10b-58cc-4372-a567-0e02b2c3d479 ok\nwrong f47ac10b-58cc-1372-a567-0e02b2c3d479',
    note: 'Version and variant nibbles are pinned, so other UUID versions are rejected.',
  },
  {
    id: 'dates',
    title: 'ISO dates + alt prefixes',
    prompt: 'find ISO dates, optionally prefixed by date=',
    pattern: '(?:date=)?\\b[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])\\b',
    flags: 'g',
    corpus: 'created 2024-01-31, updated date=1999-12-01, invalid 2024-13-01 and 2024-1-1',
    note: 'Month and day are explicit alternations, not \\d{2}, so impossible shapes are rejected.',
  },
]
