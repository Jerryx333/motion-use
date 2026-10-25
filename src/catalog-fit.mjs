// Original selection guidance for our existing studies. Tags are explicit
// editorial choices, not a measured ranking or a promise of audience response.
export const PRODUCT_TYPES = ["developer-tool", "data-explainer", "education", "hardware", "brand"];
export const MATERIAL_TYPES = ["screenshot", "recording", "document", "data", "text", "diagram", "object"];
const FIT = {
  "tutorial-steps": [["education", "developer-tool"], ["screenshot", "document"], "A real interface needs ordered instructions and a focused screenshot for each step."],
  whiteboard: [["education", "data-explainer", "developer-tool"], ["diagram", "text"], "The viewer needs to follow a causal chain and retain earlier marks."],
  editorial: [["developer-tool", "data-explainer", "education"], ["document", "screenshot"], "A real document or screenshot contains the evidence; one annotation explains it."],
  kinetic: [["brand", "developer-tool"], ["text"], "One short phrase is the actual message, rather than a replacement for a missing demonstration."],
  "data-story": [["data-explainer", "education"], ["data"], "Comparable quantities answer a specific question on one shared scale."],
  print: [["brand", "hardware"], ["object", "text"], "The subject benefits from a tactile two-colour graphic treatment."],
  product: [["developer-tool", "hardware"], ["screenshot", "recording", "object"], "A real product surface contains the action; move attention to its useful detail."],
  "focus-handoff": [["developer-tool", "education", "hardware"], ["diagram", "screenshot", "recording"], "An input visibly causes a receiving object to change."],
  "parallax-tour": [["developer-tool", "hardware", "brand"], ["screenshot", "object"], "Several related flat views need depth while the reading layer stays sharp."],
  "before-after": [["developer-tool", "hardware", "data-explainer"], ["screenshot", "recording", "data"], "Two source-backed states can keep the same framing and landmarks."],
  "exploded-view": [["hardware", "education", "developer-tool"], ["object", "diagram"], "Part-to-whole relationships explain the subject; illustrative internals are labelled."],
  "shared-shape": [["brand", "developer-tool"], ["diagram", "screenshot", "text"], "One persistent shape can carry the viewer through changing states."],
  "chart-reveal": [["data-explainer", "education"], ["data"], "The important value needs to settle before its consequence is annotated."],
};
export function fitForCard(id) {
  const fit = FIT[id];
  if (!fit) throw new Error(`missing selection guidance for ${id}`);
  return { productTypes: [...fit[0]], materials: [...fit[1]], chooseWhen: fit[2],
    evidence: "authored-guidance", reference: "references/catalog-selection.md",
    study: { command: `motion-use study ${id} <fresh-dir>`, evidence: "procedural-study", actualProductProof: false } };
}
export function recommendCards(cards, { productType, material } = {}) {
  if (!productType && !material) throw new Error("catalog recommend needs --product-type and/or --material");
  if (productType !== undefined && !PRODUCT_TYPES.includes(productType)) throw new Error(`--product-type: ${PRODUCT_TYPES.join(", ")}`);
  if (material !== undefined && !MATERIAL_TYPES.includes(material)) throw new Error(`--material: ${MATERIAL_TYPES.join(", ")}`);
  const matches = cards.filter((c) => (!productType || c.fit.productTypes.includes(productType)) && (!material || c.fit.materials.includes(material)));
  return { ok: true, status: matches.length ? "CANDIDATES" : "NO_MATCH", selection: { productType: productType ?? null, material: material ?? null },
    evidence: "explicit-tag-match", ranked: false,
    warning: "Selection candidates, not quality scores. Study with the actual product and review a real preview.",
    cards: matches.map((c) => ({ ...c, reasons: [productType && `product type: ${productType}`, material && `available material: ${material}`, c.fit.chooseWhen].filter(Boolean) })),
  };
}
