import {
  Body, Box, Narrowphase, Quaternion, Vec3,
  type ContactEquation, type FrictionEquation, type Shape, type World
} from "cannon-es";

const AXES = [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)];

interface BoxTransform {
  readonly shape: Box;
  readonly position: Vec3;
  readonly quaternion: Quaternion;
  readonly lower: Vec3;
  readonly upper: Vec3;
}

interface BodyTransforms {
  generation: number;
  boxes?: BoxTransform[];
}

/** Box projections with Cannon's axis order, clipping, materials and equation pooling. */
export class BoxNarrowphase extends Narrowphase {
  readonly #inverseA = new Quaternion();
  readonly #inverseB = new Quaternion();
  readonly #originA = new Vec3();
  readonly #originB = new Vec3();
  readonly #localAxis = new Vec3();
  readonly #axesA = AXES.map(() => new Vec3());
  readonly #axesB = AXES.map(() => new Vec3());
  readonly #cross = new Vec3();
  readonly #separatingAxis = new Vec3();
  readonly #contactOffset = new Vec3();
  readonly #transforms = new WeakMap<Body, BodyTransforms>();
  readonly #fallbackA: Body[] = [];
  readonly #fallbackB: Body[] = [];
  #generation = 0;

  override getContacts(
    p1: Body[], p2: Body[], world: World, result: ContactEquation[],
    oldcontacts: ContactEquation[], frictionResult: FrictionEquation[],
    frictionPool: FrictionEquation[]
  ): void {
    this.contactPointPool = oldcontacts;
    this.frictionEquationPool = frictionPool;
    this.result = result;
    this.frictionResult = frictionResult;
    this.#generation++;
    for (let k = 0; k < p1.length; k++) {
      const bi = p1[k]!;
      const bj = p2[k]!;
      // The transform/index preparation costs more than it saves for the
      // overwhelmingly common single-shape pair. It still uses this
      // Narrowphase's boxBox override through Cannon's normal dispatcher.
      if (bi.shapes.length === 1 && bj.shapes.length === 1) {
        this.#fallbackA[0] = bi;
        this.#fallbackB[0] = bj;
        super.getContacts(this.#fallbackA, this.#fallbackB, world, result,
          oldcontacts, frictionResult, frictionPool);
        continue;
      }
      const boxesA = this.getBoxTransforms(bi);
      const boxesB = this.getBoxTransforms(bj);
      if (!boxesA || !boxesB) {
        this.#fallbackA[0] = bi;
        this.#fallbackB[0] = bj;
        super.getContacts(this.#fallbackA, this.#fallbackB, world, result,
          oldcontacts, frictionResult, frictionPool);
        continue;
      }
      const bodyMaterial = bi.material && bj.material
        ? world.getContactMaterial(bi.material, bj.material) : undefined;
      const justTest = Boolean(
        (bi.type & Body.KINEMATIC) && (bj.type & Body.STATIC)
        || (bi.type & Body.STATIC) && (bj.type & Body.KINEMATIC)
        || (bi.type & Body.KINEMATIC) && (bj.type & Body.KINEMATIC)
      );
      // Preserve shape order: contact order also determines solver iteration order.
      for (const a of boxesA) {
        const si = a.shape;
        for (const b of boxesB) {
          const sj = b.shape;
          if (!(si.collisionFilterMask & sj.collisionFilterGroup)
            || !(sj.collisionFilterMask & si.collisionFilterGroup)) continue;
          if (a.lower.x > b.upper.x || a.upper.x < b.lower.x
            || a.lower.y > b.upper.y || a.upper.y < b.lower.y
            || a.lower.z > b.upper.z || a.upper.z < b.lower.z) continue;
          if (a.position.distanceTo(b.position)
            > si.boundingSphereRadius + sj.boundingSphereRadius) continue;
          const shapeMaterial = si.material && sj.material
            ? world.getContactMaterial(si.material, sj.material) : undefined;
          this.currentContactMaterial = shapeMaterial || bodyMaterial || world.defaultContactMaterial;
          // Cannon dispatches equal shape types with the second shape first.
          const overlap = this.boxBox(sj, si, b.position, a.position,
            b.quaternion, a.quaternion, bj, bi, si, sj, justTest);
          if (overlap && justTest) {
            world.shapeOverlapKeeper.set(si.id, sj.id);
            world.bodyOverlapKeeper.set(bi.id, bj.id);
          }
        }
      }
    }
  }

  private getBoxTransforms(body: Body): BoxTransform[] | undefined {
    let entry = this.#transforms.get(body);
    if (entry?.generation === this.#generation) return entry.boxes;
    if (!entry) {
      entry = { generation: this.#generation };
      this.#transforms.set(body, entry);
    }
    entry.generation = this.#generation;
    if (body.shapes.some(shape => !(shape instanceof Box))) {
      entry.boxes = undefined;
      return undefined;
    }
    const boxes = entry.boxes ??= [];
    boxes.length = body.shapes.length;
    for (let i = 0; i < body.shapes.length; i++) {
      const shape = body.shapes[i] as Box;
      let transform = boxes[i];
      if (!transform || transform.shape !== shape) {
        transform = boxes[i] = {
          shape, position: new Vec3(), quaternion: new Quaternion(),
          lower: new Vec3(), upper: new Vec3()
        };
      }
      const { position, quaternion, lower, upper } = transform;
      body.quaternion.mult(body.shapeOrientations[i]!, quaternion);
      body.quaternion.vmult(body.shapeOffsets[i]!, position);
      position.vadd(body.position, position);
      const axes = this.#axesA;
      for (let axis = 0; axis < 3; axis++) quaternion.vmult(AXES[axis]!, axes[axis]!);
      const h = shape.halfExtents;
      const x = Math.abs(axes[0]!.x * h.x) + Math.abs(axes[1]!.x * h.y) + Math.abs(axes[2]!.x * h.z);
      const y = Math.abs(axes[0]!.y * h.x) + Math.abs(axes[1]!.y * h.y) + Math.abs(axes[2]!.y * h.z);
      const z = Math.abs(axes[0]!.z * h.x) + Math.abs(axes[1]!.z * h.y) + Math.abs(axes[2]!.z * h.z);
      // Conservative rounding guard; this is only a rejection test, never a contact shape.
      const pad = 1e-7 + 16 * Number.EPSILON
        * (Math.max(Math.abs(position.x), Math.abs(position.y), Math.abs(position.z)) + x + y + z);
      lower.set(position.x - x - pad, position.y - y - pad, position.z - z - pad);
      upper.set(position.x + x + pad, position.y + y + pad, position.z + z + pad);
    }
    return boxes;
  }

  override boxBox(
    si: Box, sj: Box, xi: Vec3, xj: Vec3, qi: Quaternion, qj: Quaternion,
    bi: Body, bj: Body, _rsi?: Shape | null, _rsj?: Shape | null, justTest?: boolean
  ): true | void {
    const hullA = si.convexPolyhedronRepresentation;
    const hullB = sj.convexPolyhedronRepresentation;
    hullA.material = si.material;
    hullB.material = sj.material;
    hullA.collisionResponse = si.collisionResponse;
    hullB.collisionResponse = sj.collisionResponse;
    if (xi.distanceTo(xj) > hullA.boundingSphereRadius + hullB.boundingSphereRadius) return;
    if (!this.findBoxSeparatingAxis(si, sj, xi, xj, qi, qj)) return;

    const contacts: { point: Vec3; normal: Vec3; depth: number }[] = [];
    const axis = this.#separatingAxis;
    hullA.clipAgainstHull(xi, qi, hullB, xj, qj, axis, -100, 100, contacts);
    // Keep Cannon 0.20's contact/friction construction, including shape overrides.
    // cannon-es (MIT): Copyright (c) 2015 cannon.js Authors.
    let count = 0;
    for (const contact of contacts) {
      if (justTest) return true;
      const equation = this.createContactEquation(bi, bj, hullA, hullB, si, sj);
      axis.negate(equation.ni);
      contact.normal.negate(this.#contactOffset);
      this.#contactOffset.scale(contact.depth, this.#contactOffset);
      contact.point.vadd(this.#contactOffset, equation.ri);
      equation.rj.copy(contact.point);
      equation.ri.vsub(xi, equation.ri);
      equation.rj.vsub(xj, equation.rj);
      equation.ri.vadd(xi, equation.ri);
      equation.ri.vsub(bi.position, equation.ri);
      equation.rj.vadd(xj, equation.rj);
      equation.rj.vsub(bj.position, equation.rj);
      this.result.push(equation);
      count++;
      if (!this.enableFrictionReduction) this.createFrictionEquationsFromContact(equation, this.frictionResult);
    }
    if (this.enableFrictionReduction && count) this.createFrictionFromAverage(count);
  }

  private findBoxSeparatingAxis(
    a: Box, b: Box, pa: Vec3, pb: Vec3, qa: Quaternion, qb: Quaternion
  ): boolean {
    qa.conjugate(this.#inverseA);
    qb.conjugate(this.#inverseB);
    pa.negate(this.#originA);
    pb.negate(this.#originB);
    this.#inverseA.vmult(this.#originA, this.#originA);
    this.#inverseB.vmult(this.#originB, this.#originB);
    for (let i = 0; i < 3; i++) {
      qa.vmult(AXES[i]!, this.#axesA[i]!);
      qb.vmult(AXES[i]!, this.#axesB[i]!);
    }
    let minimum = Number.MAX_VALUE;
    const test = (axis: Vec3): boolean => {
      const depth = this.boxOverlap(axis, a.halfExtents, b.halfExtents);
      if (depth === false) return false;
      if (depth < minimum) {
        minimum = depth;
        this.#separatingAxis.copy(axis);
      }
      return true;
    };
    // Box.uniqueAxes is Z, Y, X. Keep its priority for equally deep contacts.
    for (let i = 2; i >= 0; i--) if (!test(this.#axesA[i]!)) return false;
    for (let i = 2; i >= 0; i--) if (!test(this.#axesB[i]!)) return false;
    // First occurrence of each unique edge in Cannon is -X, Y, Z.
    // Its remaining edges are exact negatives and repeat the same projections.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        this.#axesA[i]!.cross(this.#axesB[j]!, this.#cross);
        if ((i === 0) !== (j === 0)) this.#cross.negate(this.#cross);
        if (this.#cross.almostZero()) continue;
        this.#cross.normalize();
        if (!test(this.#cross)) return false;
      }
    }
    pb.vsub(pa, this.#cross);
    if (this.#cross.dot(this.#separatingAxis) > 0) this.#separatingAxis.negate(this.#separatingAxis);
    return true;
  }

  private boxOverlap(axis: Vec3, a: Vec3, b: Vec3): number | false {
    const local = this.#localAxis;
    this.#inverseA.vmult(axis, local);
    const radiusA = Math.abs(a.x * local.x) + Math.abs(a.y * local.y) + Math.abs(a.z * local.z);
    const originA = this.#originA.dot(local);
    this.#inverseB.vmult(axis, local);
    const radiusB = Math.abs(b.x * local.x) + Math.abs(b.y * local.y) + Math.abs(b.z * local.z);
    const originB = this.#originB.dot(local);
    // Same local projection arithmetic as ConvexPolyhedron.project, without 8 vertices.
    const maxA = radiusA - originA;
    const minA = -radiusA - originA;
    const maxB = radiusB - originB;
    const minB = -radiusB - originB;
    if (maxA < minB || maxB < minA) return false;
    return Math.min(maxA - minB, maxB - minA);
  }
}
