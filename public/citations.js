
export function citationTextNodes(container) {
  const walker = container.ownerDocument.createTreeWalker(container, 4);
  const nodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest("code, pre, a")) nodes.push(walker.currentNode);
  }
  return nodes;
}

export function citedNumbersIn(container) {
  const numbers = new Set();
  for (const node of citationTextNodes(container)) {
    for (const match of node.textContent.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      for (const n of match[1].split(",")) numbers.add(Number(n));
    }
  }
  return [...numbers].sort((a, b) => a - b);
}
