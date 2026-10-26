// Replace assets/evidence.svg with real, redacted screenshots before delivery.
window.drawFrame = function(c,t,film,view,M) {
  M.paper(c);
  const shot=film.shots.find(s=>t>=s.start && t<s.end);
  if (shot) M.steps(c,t,film.data.steps[shot.id],{start:shot.start,duration:shot.end-shot.start});
  M.captions(c,t);
};
