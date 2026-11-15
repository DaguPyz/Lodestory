export const timelineFocusEventCenter = {x: 50, y: 50};
const nodeSpacing = 96;
// Leave room for the 36px node radius, hover growth, category dot and idle drift.
const edgeInset = 48;

export type OrbitSlot = Readonly<{x: number; y: number; offsetX: number; offsetY: number}>;
export type OrbitViewport = Readonly<{left: number; top: number; width: number; height: number}>;

export function relationLabelPosition(slot: OrbitSlot, rem: number) {
  const ratio = 1 - 5.5 * rem / Math.hypot(slot.offsetX, slot.offsetY);
  return {x: 50 + (slot.x - 50) * ratio, y: 50 + (slot.y - 50) * ratio};
}

export function isRelationInViewport(slot: OrbitSlot, label: {x: number; y: number}, diameter: number, viewport: OrbitViewport, rem: number) {
  const margin = 4.5 * rem; // Includes half the label width and a small scroll buffer.
  const left = viewport.left - margin;
  const top = viewport.top - margin;
  const right = viewport.left + viewport.width + margin;
  const bottom = viewport.top + viewport.height + margin;
  const contains = ({x, y}: {x: number; y: number}) => {
    const horizontal = x * diameter / 100;
    const vertical = y * diameter / 100;
    return horizontal >= left && horizontal <= right && vertical >= top && vertical <= bottom;
  };
  return contains(slot) || contains(label);
}

/** Positions and travel share the same center, so assets emerge from the event. */
export function getTimelineAssetOrbit(groups: readonly {count: number}[], size: {width: number; height: number},
  {spacing = nodeSpacing, offsetRings = false}: {spacing?: number; offsetRings?: boolean} = {}) {
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  const innerRadius = Math.max(spacing, Math.min(size.width, size.height) / 2 - edgeInset);
  const rings: {radius: number; capacity: number; count: number}[] = [];
  let capacity = 0;
  while (capacity < count) {
    const radius = innerRadius + rings.length * spacing;
    // Chord spacing keeps neighboring circles apart, including diagonally placed nodes.
    const ringCapacity = Math.floor(Math.PI / Math.asin(spacing / (2 * radius)));
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
  const positions = rings.flatMap(({radius, count}, ringIndex) => Array.from({length: count}, (_, index) => {
    const phase = offsetRings ? ringIndex * (Math.PI * (3 - Math.sqrt(5))) : 0;
    const angle = index * 2 * Math.PI / count + phase;
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
