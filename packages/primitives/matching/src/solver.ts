/**
 * The assignment solver — the piece that decides who actually gets whom.
 *
 * GREEDY IS THE BUG. The failure mode is specific and it has happened to every
 * mentoring program that sorted by score and walked the list: the first thirty
 * mentees get excellent mentors, capacity is gone, and mentee thirty-one gets
 * nobody while a perfectly good mentor sits under capacity because the one
 * mentee they were eligible for was taken by someone who had four other
 * options. Locally optimal, globally broken, and invisible until a human asks
 * why ten people are unmatched.
 *
 * So this is a constrained global assignment: min-cost max-flow on a bipartite
 * graph with mentor capacities (a b-matching). Max-flow first means *coverage*
 * is maximised before quality is — no mentee is left out while capacity and an
 * eligible edge exist — and min-cost among the max-flows means the best
 * allocation consistent with that coverage.
 */

export interface CandidateEdge {
  menteeId: string;
  mentorId: string;
  /** 0..1, higher is better. */
  score: number;
}

export interface MentorCapacity {
  mentorId: string;
  /** Slots still available in THIS run — prior load already subtracted. */
  capacity: number;
}

export interface AssignmentRequest {
  menteeIds: string[];
  mentors: MentorCapacity[];
  /** Eligible pairs only. Hard constraints have already removed the rest. */
  edges: CandidateEdge[];
  /** Cost added to a mentor's k-th assignment. Convex, so it spreads load. */
  loadBalancePenalty?: number;
}

export interface Assignment {
  menteeId: string;
  mentorId: string;
  score: number;
}

export interface AssignmentResult {
  solver: string;
  assignments: Assignment[];
  unmatchedMenteeIds: string[];
  /** Sum of assigned scores. Comparable across solvers on the same request. */
  totalScore: number;
}

export interface AssignmentSolver {
  name: string;
  solve(request: AssignmentRequest): AssignmentResult;
}

/**
 * Costs are integers. Floating point cost accumulation in a shortest-path loop
 * produces ties that resolve differently depending on the order edges happened
 * to be added, which shows up as an unstable matching under a perturbation
 * that should not have mattered. 1e6 is far finer than any score difference
 * anyone can justify.
 */
const COST_SCALE = 1_000_000;
const costOf = (score: number): number =>
  Math.round((1 - Math.min(1, Math.max(0, score))) * COST_SCALE);

interface FlowEdge {
  to: number;
  capacity: number;
  cost: number;
  /** Index of the paired reverse edge. */
  reverse: number;
}

/**
 * Successive-shortest-paths min-cost max-flow. SPFA rather than Dijkstra with
 * potentials: residual edges carry negative costs, the graphs here are small
 * (a cohort is hundreds of nodes, not millions), and a correct simple
 * implementation beats a subtly wrong fast one on something that decides who
 * a person spends six months with.
 */
class MinCostFlow {
  private readonly edges: FlowEdge[] = [];
  private readonly adjacency: number[][];

  constructor(nodeCount: number) {
    this.adjacency = Array.from({ length: nodeCount }, () => []);
  }

  /** Returns the index of the forward edge, so flow can be read back. */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    const forward = this.edges.length;
    this.edges.push({ to, capacity, cost, reverse: forward + 1 });
    this.adjacency[from]!.push(forward);
    this.edges.push({ to: from, capacity: 0, cost: -cost, reverse: forward });
    this.adjacency[to]!.push(forward + 1);
    return forward;
  }

  flowOn(edgeIndex: number): number {
    // The reverse edge's capacity IS the flow pushed along the forward edge.
    return this.edges[this.edges[edgeIndex]!.reverse]!.capacity;
  }

  /** Saturates: augments along a shortest path until the sink is unreachable. */
  run(source: number, sink: number): void {
    const n = this.adjacency.length;
    for (;;) {
      const distance = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
      const inQueue = new Array<boolean>(n).fill(false);
      const previousEdge = new Array<number>(n).fill(-1);
      distance[source] = 0;
      // A plain FIFO queue, drained in insertion order: the traversal must be
      // a pure function of the edge order, or two runs on the same input can
      // disagree about which of two equal-cost matchings they return.
      const queue: number[] = [source];
      inQueue[source] = true;

      while (queue.length > 0) {
        const node = queue.shift()!;
        inQueue[node] = false;
        const base = distance[node]!;
        for (const edgeIndex of this.adjacency[node]!) {
          const edge = this.edges[edgeIndex]!;
          if (edge.capacity <= 0) continue;
          const candidate = base + edge.cost;
          if (candidate < distance[edge.to]!) {
            distance[edge.to] = candidate;
            previousEdge[edge.to] = edgeIndex;
            if (!inQueue[edge.to]!) {
              inQueue[edge.to] = true;
              queue.push(edge.to);
            }
          }
        }
      }

      if (!Number.isFinite(distance[sink]!)) return;

      let bottleneck = Number.POSITIVE_INFINITY;
      for (let node = sink; node !== source; ) {
        const edge = this.edges[previousEdge[node]!]!;
        bottleneck = Math.min(bottleneck, edge.capacity);
        node = this.edges[edge.reverse]!.to;
      }
      for (let node = sink; node !== source; ) {
        const edge = this.edges[previousEdge[node]!]!;
        edge.capacity -= bottleneck;
        this.edges[edge.reverse]!.capacity += bottleneck;
        node = this.edges[edge.reverse]!.to;
      }
    }
  }
}

/**
 * The real solver. Network shape:
 *
 *   source -> mentee        capacity 1, cost 0
 *   mentee -> mentor        capacity 1, cost (1 - score)
 *   mentor -> sink          `capacity` PARALLEL unit edges, costs 0, p, 2p, …
 *
 * The parallel sink edges are the load-balancing trick: because the costs
 * increase, the flow takes a mentor's cheap first slot before their expensive
 * third, so mentees spread out when scores are close. It is a convex cost, so
 * successive shortest paths still returns the true optimum — which a flat
 * "penalise mentors with more than N" hack would not.
 */
export const minCostFlowSolver: AssignmentSolver = {
  name: "min_cost_flow",
  solve(request) {
    const penalty = Math.round((request.loadBalancePenalty ?? 0) * COST_SCALE);

    // Sorting makes the node and edge order a function of the data alone, not
    // of whatever order the caller assembled its arrays in.
    const menteeIds = [...new Set(request.menteeIds)].sort();
    const mentors = [...request.mentors]
      .filter((m) => m.capacity > 0)
      .sort((a, b) => a.mentorId.localeCompare(b.mentorId));

    const menteeIndex = new Map(menteeIds.map((id, i) => [id, i + 1]));
    const mentorOffset = 1 + menteeIds.length;
    const mentorIndex = new Map(mentors.map((m, i) => [m.mentorId, mentorOffset + i]));
    const source = 0;
    const sink = mentorOffset + mentors.length;

    const network = new MinCostFlow(sink + 1);
    for (const id of menteeIds) network.addEdge(source, menteeIndex.get(id)!, 1, 0);
    for (const mentor of mentors) {
      const node = mentorIndex.get(mentor.mentorId)!;
      for (let slot = 0; slot < mentor.capacity; slot++) {
        network.addEdge(node, sink, 1, slot * penalty);
      }
    }

    const edges = [...request.edges]
      .filter((e) => menteeIndex.has(e.menteeId) && mentorIndex.has(e.mentorId))
      .sort(
        (a, b) =>
          a.menteeId.localeCompare(b.menteeId) ||
          b.score - a.score ||
          a.mentorId.localeCompare(b.mentorId),
      );

    const edgeHandles = edges.map((edge) => ({
      edge,
      index: network.addEdge(
        menteeIndex.get(edge.menteeId)!,
        mentorIndex.get(edge.mentorId)!,
        1,
        costOf(edge.score),
      ),
    }));

    network.run(source, sink);

    const assignments: Assignment[] = [];
    const matched = new Set<string>();
    for (const handle of edgeHandles) {
      if (network.flowOn(handle.index) > 0) {
        assignments.push({
          menteeId: handle.edge.menteeId,
          mentorId: handle.edge.mentorId,
          score: handle.edge.score,
        });
        matched.add(handle.edge.menteeId);
      }
    }

    return {
      solver: minCostFlowSolver.name,
      assignments,
      unmatchedMenteeIds: menteeIds.filter((id) => !matched.has(id)),
      totalScore: assignments.reduce((sum, a) => sum + a.score, 0),
    };
  },
};

/**
 * The wrong answer, kept deliberately.
 *
 * It is exported for two reasons: a test asserts that it strands a mentee on a
 * case the flow solver covers (documentation that the complexity is earning
 * its keep), and anyone benchmarking a replacement solver needs a floor to
 * compare against. It is never the default and should never be configured as
 * one.
 */
export const greedyAssignmentSolver: AssignmentSolver = {
  name: "greedy",
  solve(request) {
    const remaining = new Map(request.mentors.map((m) => [m.mentorId, m.capacity]));
    const taken = new Set<string>();
    const assignments: Assignment[] = [];

    const ordered = [...request.edges].sort(
      (a, b) =>
        b.score - a.score ||
        a.menteeId.localeCompare(b.menteeId) ||
        a.mentorId.localeCompare(b.mentorId),
    );

    for (const edge of ordered) {
      if (taken.has(edge.menteeId)) continue;
      const left = remaining.get(edge.mentorId) ?? 0;
      if (left <= 0) continue;
      remaining.set(edge.mentorId, left - 1);
      taken.add(edge.menteeId);
      assignments.push({ menteeId: edge.menteeId, mentorId: edge.mentorId, score: edge.score });
    }

    return {
      solver: greedyAssignmentSolver.name,
      assignments,
      unmatchedMenteeIds: [...new Set(request.menteeIds)].sort().filter((id) => !taken.has(id)),
      totalScore: assignments.reduce((sum, a) => sum + a.score, 0),
    };
  },
};
