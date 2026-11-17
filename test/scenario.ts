import type { PlanAction } from "./lib.ts";

export interface PhaseContext {
  run: string;
  /** Attributes per logical id, as persisted after this phase. */
  state: Record<string, Record<string, any> | undefined>;
  /** Attributes per logical id from the previous phase. */
  previous: Record<string, Record<string, any> | undefined>;
}

export interface Phase {
  name: string;
  /** The plan Alchemy must print for this deploy. */
  plan: Record<string, PlanAction>;
  /** The deploy must fail and its log must contain this text. */
  failsWith?: string;
  /** Deploy with `--detect-drift`, which re-reads every resource from Mux. */
  detectDrift?: boolean;
  before?: (ctx: { run: string; previous: PhaseContext["previous"] }) => Promise<void>;
  /** Assertions against the live Mux API. */
  verify?: (ctx: PhaseContext) => Promise<void>;
  after?: (ctx: { run: string }) => Promise<void>;
}

export interface Scenario {
  name: string;
  stack: string;
  stackFile: string;
  /** Logical id -> API path of the resource, used to confirm it is gone after destroy. */
  resources: Record<string, (attrs: Record<string, any>) => string>;
  /**
   * Runs after every phase for every resource that exists: the attributes
   * Alchemy persisted must agree with what Mux reports now.
   */
  matchesMux?: Record<string, (attrs: Record<string, any>) => Promise<void>>;
  /**
   * Logical ids declared with `RemovalPolicy.retain()`. Every generation of
   * these must still exist after destroy; the harness then deletes them.
   */
  retained?: string[];
  /** Overrides the GET-404 check for resources whose GET is unreliable after delete. */
  isGone?: Record<string, (attrs: Record<string, any>) => Promise<boolean>>;
  phases: Phase[];
}
