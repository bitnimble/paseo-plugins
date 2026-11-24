const EDGE_GAP = 8;

export function menuOffset(triggerLeft: number, containerWidth: number, menuWidth: number): number {
  const overflowRight = containerWidth - EDGE_GAP - triggerLeft - menuWidth;
  return Math.max(EDGE_GAP - triggerLeft, Math.min(0, overflowRight));
}
