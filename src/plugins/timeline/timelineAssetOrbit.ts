export const timelineFocusEventCenter = {x: 50, y: 50};
const nodeSpacing = 96;
// Leave room for the 36px node radius, hover growth, category dot and idle drift.
const edgeInset = 48;

export type OrbitSlot = Readonly<{x: number; y: number; offsetX: number; offsetY: number}>;
export type OrbitViewport = Readonly<{left: number; top: number; width: number; height: number}>;
type RelationLabel = Readonly<{id: string; position: OrbitSlot; labelPosition: {x: number; y: number}; label: string}>;

export function relationLabelPosition(slot: OrbitSlot, rem: number) {
  const ratio = Math.max(0.5, 1 - 5.5 * rem / Math.hypot(slot.offsetX, slot.offsetY));
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

/** Reserve space for nodes and labels when their text is larger than the zoomed layout. */
export function layoutRelationLabels(relations: readonly RelationLabel[], diameter: number, nodeRem: number, textRem: number,
  selectedId: string | null, focusedId?: string) {
  const cellSize = 8 * textRem;
  const occupied = new Map<string, OrbitViewport[]>();
  const shown = new Set<string>();
  const boundsAt = ({x, y}: {x: number; y: number}, width: number, height: number) => ({
    left: x * diameter / 100 - width / 2, top: y * diameter / 100 - height / 2, width, height,
  });
  function cells(bounds: OrbitViewport) {
    const keys: string[] = [];
    for (let x = Math.floor(bounds.left / cellSize); x <= Math.floor((bounds.left + bounds.width) / cellSize); x++) {
      for (let y = Math.floor(bounds.top / cellSize); y <= Math.floor((bounds.top + bounds.height) / cellSize); y++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  }
  function occupy(bounds: OrbitViewport, keys = cells(bounds)) {
    for (const key of keys) {
      const bucket = occupied.get(key);
      if (bucket) bucket.push(bounds);
      else occupied.set(key, [bounds]);
    }
  }
  const centerSize = Math.max(24, 6 * nodeRem);
  const peerSize = Math.max(24, 4.5 * nodeRem);
  occupy(boundsAt(timelineFocusEventCenter, centerSize + 4, centerSize + 4));
  for (const relation of relations) occupy(boundsAt(relation.position, peerSize + 4, peerSize + 4));

  const preferred = relations.filter(({id}) => id === selectedId || id === focusedId);
  for (const relation of [...preferred, ...relations]) {
    if (!relation.label || shown.has(relation.id)) continue;
    const measured = [...relation.label].reduce((width, char) => width + (char.codePointAt(0)! > 255 ? 0.875 : 0.5) * textRem, 0);
    const width = Math.max(24, Math.min(measured + 0.5 * textRem, 8 * textRem));
    const height = Math.max(24, (measured + 0.5 * textRem > width ? 2.75 : 1.5) * textRem);
    const box = boundsAt(relation.labelPosition, width, height);
    const keys = cells(box);
    if (relation.id !== selectedId && relation.id !== focusedId && keys.some(key => occupied.get(key)?.some(other =>
      box.left < other.left + other.width && box.left + box.width > other.left
      && box.top < other.top + other.height && box.top + box.height > other.top))) continue;
    shown.add(relation.id);
    occupy(box, keys);
  }
  return shown;
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
