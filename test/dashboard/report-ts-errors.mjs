// Reads `tsc --pretty false` output from stdin and fails on errors in the plugin's dashboard files.
// The dashboard package ships its TypeScript sources, which do not all compile with this project's settings;
// errors inside node_modules are therefore ignored.
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const own = input.split('\n').filter((line) => /^dashboard\/.*error TS/.test(line));
  if (own.length) {
    console.error(own.join('\n'));
    process.exit(1);
  }
  console.log('dashboard: no type errors');
});
