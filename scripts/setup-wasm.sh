#!/bin/bash

# Script to copy tree-sitter WASM files from node_modules to public directory
# Run this after npm install

echo "Setting up tree-sitter WASM files..."

# Create the destination directory
mkdir -p public/tree-sitter

# Copy core WASM file
echo "Copying web-tree-sitter core..."
cp node_modules/web-tree-sitter/tree-sitter.wasm public/tree-sitter/

# List of language packages to copy
languages=(
  "tree-sitter-javascript"
  "tree-sitter-typescript"
  "tree-sitter-python"
  "tree-sitter-java"
  "tree-sitter-c"
  "tree-sitter-cpp"
  "tree-sitter-c-sharp"
  "tree-sitter-php"
  "tree-sitter-ruby"
  "tree-sitter-go"
  "tree-sitter-rust"
  "tree-sitter-kotlin"
  "tree-sitter-swift"
  "tree-sitter-bash"
  "tree-sitter-dart"
  "tree-sitter-scala"
  "tree-sitter-lua"
  "tree-sitter-sql"
)

# Copy each language WASM file
for lang in "${languages[@]}"; do
  echo "Copying $lang..."
  # Find and copy all .wasm files from the package
  find node_modules/$lang -name "*.wasm" -exec cp {} public/tree-sitter/ \; 2>/dev/null || echo "  Warning: $lang WASM files not found"
done

echo "✓ WASM setup complete!"
echo ""
echo "Files copied to public/tree-sitter:"
ls -lh public/tree-sitter/
