/* link-sweep tests — the hard-wrap bridging heuristic is the risky part, so
 * every rule gets a case, including Owner's real OAuth sample. */
import { extractUrls } from '../web/link-sweep.mjs';

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`);
  }
}

// Owner's real case (claude hard-wrapped an OAuth URL twice, with indents)
eq(
  extractUrls([
    'Open this in a browser:',
    'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123456789012-exampleclientid0000000000.apps.googleuserconte',
    '  nt.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2F&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&state',
    '  =C_exampleStateValue00',
    'then paste the code back.',
  ]),
  [
    'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123456789012-exampleclientid0000000000.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2F&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&state=C_exampleStateValue00',
  ],
  'reconstructs a twice-hard-wrapped OAuth URL (real sample)',
);

// URL that legitimately ends at end-of-line, followed by prose — must NOT glue
eq(
  extractUrls(['see https://example.com/docs', 'and then run the tool']),
  ['https://example.com/docs'],
  'prose after a line-final URL is not glued on',
);

// Simple inline URL with trailing punctuation
eq(
  extractUrls(['read (https://a.io/x?q=1).']),
  ['https://a.io/x?q=1'],
  'trailing punctuation trimmed',
);

// Continuation guard accepts "=token" starts (query-value wraps)
eq(
  extractUrls(['go https://h.co/a?k', '=v&x=y done']),
  ['https://h.co/a?k=v&x=y'],
  'continuation starting with = is bridged',
);

// Dedup + order
eq(
  extractUrls(['x https://a.io b https://b.io', 'https://a.io again']),
  ['https://a.io', 'https://b.io'],
  'dedup keeps first-appearance order',
);

// Box-drawing / quote prefixes on continuation lines are stripped
eq(
  extractUrls(['│ https://long.example/path/segment?with=queryparams', '│   &more=stuff-tail']),
  ['https://long.example/path/segment?with=queryparams&more=stuff-tail'],
  'box-prefix continuation lines bridge',
);

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
