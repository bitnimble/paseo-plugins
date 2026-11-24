import cytoscape, { type CytoscapeOptions } from "cytoscape";

export default Object.assign((options: CytoscapeOptions) => {
  const cy = cytoscape(options);
  // Mermaid never destroys it, and its canvas renderer would redraw forever in the long-lived worker.
  // A turn later: mermaid reads the laid-out positions in the turn that builds it.
  cy.ready(() => setTimeout(() => cy.destroy()));
  return cy;
}, cytoscape);
