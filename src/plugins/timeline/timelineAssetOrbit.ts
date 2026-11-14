export const timelineFocusEventCenter = {x: 50, y: 50};
const nodeSpacing = 96;
// Leave room for the 36px node radius, hover growth, category dot and idle drift.
const edgeInset = 48;

/** Positions and travel share the same center, so assets emerge from the event. */
export function getTimelineAssetOrbit(groups: readonly {count: number}[], size: {width: number; height: number}) {
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  const innerRadius = Math.max(nodeSpacing, Math.min(size.width, size.height) / 2 - edgeInset);
  const rings: {radius: number; capacity: number; count: number}[] = [];
  let capacity = 0;
  while (capacity < count) {
    const radius = innerRadius + rings.length * nodeSpacing;
    // Chord spacing keeps neighboring circles apart, including diagonally placed nodes.
    const ringCapacity = Math.floor(Math.PI / Math.asin(nodeSpacing / (2 * radius)));
    rings.push({radius, capacity: ringCapacity, count: 0});
    capacity += ringCapacity;
  }
  let remaining = count;
  let remainingCapacity = capacity;
  for (const ring of rings) {
    ring.count = Math.round(remaining * ring.capacity / remainingCapacity);
    remaining -= ring.count;
    remainingCapacity -= ring.capacity;
  }
  const diameter = 2 * ((rings[rings.length - 1]?.radius ?? innerRadius) + edgeInset);
  const positions = rings.flatMap(({radius, count}) => Array.from({length: count}, (_, index) => {
    const angle = index * 2 * Math.PI / count;
    const dx = Math.sin(angle) * radius;
    const dy = -Math.cos(angle) * radius;
    return {x: 50 + dx / diameter * 100, y: 50 + dy / diameter * 100, offsetX: -dx, offsetY: -dy};
  }));
  let next = 0;
  return {diameter, rings, groups: groups.map(group => {
    const slots = positions.slice(next, next + group.count);
    next += group.count;
    return {slots};
  })};
}
