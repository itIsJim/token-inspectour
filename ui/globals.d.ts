// Vendored scripts loaded as globals before the page modules (see index.html / graph.html).
// d3-sankey's UMD build extends the same global d3 object.
declare const d3: typeof import('d3') & typeof import('d3-sankey');
