import type { ModelEntry, ProviderRegistry } from './registry';
import { route as smartRoute, type RouteMode, type RouteReason } from './smartRouter';

/** Model choice for one generation run. */
export interface GenerationRoute {
  entries: ModelEntry[];
  /** Reported to the client as `route` in `run_started`. null = smart router off:
   *  no `route` field is added, so events are exactly the pre-wave-3 events. */
  decision: { model: string; reason: RouteReason } | null;
}

export interface GenerationRouteInput {
  modelId?: string;
  allowFallback?: boolean;
  fallbackIds?: readonly string[];
  prompt: string;
  mode: 'create' | 'iterate' | 'fix' | 'explain' | 'auto';
  fileCount: number;
  /** Server flag AI_SMART_ROUTER=1 (default OFF, Bora W3 P3-1). */
  smartRouter?: boolean;
}

/** AI_SMART_ROUTER=1 turns the smart router on. Anything else (unset, 0, true) keeps it OFF. */
export function smartRouterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_SMART_ROUTER === '1';
}

function routeMode(mode: GenerationRouteInput['mode']): RouteMode {
  if (mode === 'fix') return 'fix';
  if (mode === 'explain') return 'explain';
  return 'generate';
}

/**
 * Picks the provider chain for /api/agent/generate, the durable worker and autofix.
 * - Flag OFF (default): exactly `providers.route(modelId, allowFallback, fallbackIds)`, i.e. AI_DEFAULT_MODEL
 *   (or the Mistral Agent default) with AI_FALLBACK_MODELS / UI fallbacks as before; decision = null.
 * - Flag ON, explicit `modelId`: always wins, exactly today's route (UI fallbacks included).
 * - Flag ON, no `modelId`: the router chooses only from the registered (allowed) models. If it picks the
 *   registry default, today's route is kept unchanged. Otherwise the pick is followed by the operator's
 *   AI_FALLBACK_MODELS (never by a router-only cascade).
 * Throws `invalid_model` exactly like `providers.route` for an unknown model or bad fallbacks.
 */
export function selectGenerationRoute(providers: ProviderRegistry, input: GenerationRouteInput): GenerationRoute {
  const current = providers.route(input.modelId, input.allowFallback, input.fallbackIds);
  if (!input.smartRouter) return { entries: current, decision: null };
  if (input.modelId !== undefined) {
    return { entries: current, decision: { model: input.modelId, reason: 'explicit_user_choice' } };
  }

  const available = providers.ids();
  const decision = smartRoute(input.prompt, routeMode(input.mode), { fileCount: input.fileCount, availableModels: available });
  if (decision.model === current[0].id) {
    return { entries: current, decision: { model: decision.model, reason: decision.reason } };
  }
  const picked = providers.find(decision.model);
  if (!picked) throw new Error('invalid_model');
  const configured = providers.catalog().models.find(model => model.id === picked.id)?.fallbackIds ?? [];
  const entries = providers.route(picked.id, configured.length > 0, configured);
  return { entries, decision: { model: decision.model, reason: decision.reason } };
}

/** Adds the routing decision to the `run_started` event; every other event, and every event when
 *  the router is off (decision null), passes unchanged. */
export function withRouteDecision<E extends { type: string }>(event: E, decision: GenerationRoute['decision']): E {
  return decision && event.type === 'run_started' ? { ...event, route: { model: decision.model, reason: decision.reason } } : event;
}
