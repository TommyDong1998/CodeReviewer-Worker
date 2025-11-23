import { parseCodeFunctions } from './dist/parsing/native-tree-sitter-parser.js';

const testCode = `
function hello(name) {
  return 'Hello, ' + name;
}

const greet = (name) => {
  console.log('Greeting:', name);
};

class MyClass {
  myMethod() {
    console.log('Method in class');
  }
}
`;

console.log('Testing native tree-sitter parser...\n');

parseCodeFunctions(testCode, 'test.js')
  .then(functions => {
    console.log(`Found ${functions.length} functions:\n`);
    functions.forEach((fn, i) => {
      console.log(`${i + 1}. ${fn.name} (lines ${fn.startLine}-${fn.endLine})`);
      console.log(`   Class path: ${fn.classPath.join('.') || '(none)'}`);
      console.log(`   Hash: ${fn.contentHash.substring(0, 16)}...`);
      console.log('');
    });
    console.log('✓ Parser test passed!');
    process.exit(0);
  })
  .catch(error => {
    console.error('✗ Parser test failed:', error);
    process.exit(1);
  });
