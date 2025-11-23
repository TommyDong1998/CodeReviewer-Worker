import JavaScript from 'tree-sitter-javascript';
import Parser from 'tree-sitter';

console.log('JavaScript module type:', typeof JavaScript);
console.log('JavaScript module:', JavaScript);
console.log('JavaScript keys:', Object.keys(JavaScript));
console.log('');

const parser = new Parser();
console.log('Parser created');

try {
  parser.setLanguage(JavaScript);
  console.log('✓ Language set successfully!');

  const code = 'function hello() { return "world"; }';
  const tree = parser.parse(code);
  console.log('✓ Code parsed successfully!');
  console.log('Root node type:', tree.rootNode.type);
  console.log('Root node children count:', tree.rootNode.namedChildCount);
} catch (error) {
  console.error('✗ Error:', error.message);
}
