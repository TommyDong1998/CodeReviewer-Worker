import { parseCodeFunctions } from './dist/parsing/tree-sitter-parser.js';

const testCode = `
function hello(name) {
  return 'Hello, ' + name;
}

const greet = (name) => {
  console.log('Greeting:', name);
};
`;

console.log('Testing web-tree-sitter parser...\n');

parseCodeFunctions(testCode, 'test.js')
  .then(functions => {
    console.log(`\n✓ Found ${functions.length} functions:`);
    functions.forEach((fn, i) => {
      console.log(`  ${i + 1}. ${fn.name} (lines ${fn.startLine}-${fn.endLine})`);
    });
    process.exit(functions.length > 0 ? 0 : 1);
  })
  .catch(error => {
    console.error('\n✗ Parser test failed:', error.message);
    process.exit(1);
  });
