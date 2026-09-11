import { SAPBroadphase, type Body, type World } from "cannon-es";

/** Sweep termination uses the same bounds that SAP sorts by. */
export class AabbSAPBroadphase extends SAPBroadphase {
  override collisionPairs(world: World, p1: Body[], p2: Body[]): void {
    if (!this.useBoundingBoxes) {
      super.collisionPairs(world, p1, p2);
      return;
    }
    if (this.dirty) {
      this.sortList();
      this.dirty = false;
    }
    const axis = this.axisIndex === 0 ? "x" : this.axisIndex === 1 ? "y" : "z";
    const bodies = this.axisList;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]!;
      const upper = a.aabb.upperBound[axis];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]!;
        // Touching AABBs remain candidates, as in Broadphase.doBoundingBoxBroadphase.
        if (b.aabb.lowerBound[axis] > upper) break;
        if (this.needBroadphaseCollision(a, b)) this.intersectionTest(a, b, p1, p2);
      }
    }
  }
}
